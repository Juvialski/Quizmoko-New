import type {
  CanonicalQuestionType,
  GradeStatus,
  GradedDetail,
  NormalizedQuestion,
  NumericAnswerPolicy,
  Question,
  QuestionStorageNormalizationResult,
  QuestionValidationError,
  QuestionValidationResult,
  QuizScoreSummary
} from '../types.ts';

export type { CanonicalQuestionType, GradeStatus, NormalizedQuestion } from '../types.ts';

export interface LocalGradeResult {
  isCorrect: boolean;
  scoreFraction: number;
  questionType: CanonicalQuestionType | 'unsupported';
  correctAnswer: unknown;
  requiresSemanticGrading: boolean;
  gradeStatus: GradeStatus;
  authoritative: boolean;
  points: number;
  earnedPoints: number;
  errors: QuestionValidationError[];
}

export type AnswerNormalizationResult =
  | { valid: true; answer: string | string[]; errors: [] }
  | { valid: false; answer?: undefined; errors: QuestionValidationError[] };

const SCORE_DECIMALS = 4;
const MAX_ANSWER_LENGTH = 50_000;

const TYPE_ALIASES: Readonly<Record<string, CanonicalQuestionType>> = {
  'multiple choice': 'multiple_choice',
  'multiple choices': 'multiple_choice',
  'multiple select': 'multiple_choice_multi',
  'multiple choice multi': 'multiple_choice_multi',
  'multi select': 'multiple_choice_multi',
  'true false': 'true_false',
  'true or false': 'true_false',
  identification: 'identification',
  identify: 'identification',
  'fill in the blank': 'identification',
  open: 'open_ended',
  'open ended': 'open_ended',
  'open response': 'open_ended',
  'free response': 'open_ended',
  'free text': 'open_ended',
  essay: 'open_ended',
  'short answer': 'open_ended',
  graph: 'graphing',
  graphing: 'graphing'
};

const ANSWER_ALIAS_PRECEDENCE = [
  'correct_answer',
  'correctAnswer',
  'correct_answer_letter',
  'correctAnswerLetter',
  'answer'
] as const;

function validationError(
  code: QuestionValidationError['code'],
  message: string,
  field?: string,
  value?: unknown
): QuestionValidationError {
  return { code, message, ...(field ? { field } : {}), ...(value !== undefined ? { value } : {}) };
}

function answerToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(answerToString).join(', ');
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function sanitizeStudentAnswer(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.slice(0, MAX_ANSWER_LENGTH);
  if (typeof value === 'number') return Number.isFinite(value) ? value : '';
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => {
      if (typeof item === 'string') return item.slice(0, 2_000);
      return sanitizeStudentAnswer(item);
    });
  }
  return String(value).slice(0, MAX_ANSWER_LENGTH);
}

export function getQuestionOptions(question: unknown): unknown[] {
  if (!question || typeof question !== 'object' || Array.isArray(question)) return [];
  const record = question as Record<string, unknown>;
  const raw = record.options ?? record.choices ?? record.answers;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return Object.values(raw as Record<string, unknown>);
  return [];
}

function presentAnswerAliases(question: Record<string, unknown>): Array<{ key: string; value: unknown }> {
  const aliases: Array<{ key: string; value: unknown }> = [];
  for (const key of ANSWER_ALIAS_PRECEDENCE) {
    if (!Object.prototype.hasOwnProperty.call(question, key)) continue;
    const value = question[key];
    if (value === null || value === undefined || answerToString(value).trim() === '') continue;
    aliases.push({ key, value });
  }
  return aliases;
}

/**
 * Legacy corrected-answer aliases deliberately precede `answer`. New records are
 * written with `answer` only by normalizeQuestionForStorage().
 */
export function getCorrectAnswer(question: unknown): unknown {
  if (!question || typeof question !== 'object' || Array.isArray(question)) return '';
  return presentAnswerAliases(question as Record<string, unknown>)[0]?.value ?? '';
}

function normalizedTypeToken(value: unknown): string {
  return answerToString(value)
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function resolveQuestionType(question: Record<string, unknown>): {
  type?: CanonicalQuestionType;
  explicit: boolean;
} {
  const raw = question.type ?? question.question_type ?? question.questionType;
  const explicit = raw !== null && raw !== undefined && answerToString(raw).trim() !== '';
  if (!explicit) {
    return { type: getQuestionOptions(question).length > 0 ? 'multiple_choice' : 'identification', explicit: false };
  }
  return { type: TYPE_ALIASES[normalizedTypeToken(raw)], explicit: true };
}

export function canonicalQuestionType(question: unknown): CanonicalQuestionType | 'unsupported' {
  if (!question || typeof question !== 'object' || Array.isArray(question)) return 'unsupported';
  return resolveQuestionType(question as Record<string, unknown>).type ?? 'unsupported';
}

export function isSemanticQuestion(question: unknown): boolean {
  if (typeof question === 'string') {
    const type = TYPE_ALIASES[normalizedTypeToken(question)];
    return type === 'open_ended' || type === 'graphing';
  }
  if (!question || typeof question !== 'object' || Array.isArray(question)) return false;
  const record = question as Record<string, unknown>;
  const gradingMode = normalizedTypeToken(record.grading_mode ?? record.gradingMode);
  if (gradingMode === 'semantic' || gradingMode === 'ai') return true;
  if (gradingMode === 'deterministic' || gradingMode === 'exact') return false;
  const type = canonicalQuestionType(record);
  if (type === 'open_ended' || type === 'graphing') return true;
  if (type !== 'identification') return false;

  // Legacy algebraic identification keys cannot safely be compared by regex or
  // punctuation removal. Numeric and ordinary textual keys remain deterministic.
  const expected = stripLatex(getCorrectAnswer(record)).normalize('NFKC').trim();
  if (!expected || parseNumericAnswer(expected)) return false;
  return /[=<>^]|\\(?:sqrt|sin|cos|tan|log)|(?:[a-z]\s*[+*/-]\s*(?:[a-z]|\d))|(?:\d\s*[a-z])|(?:[a-z]\s*\()/i.test(expected);
}

export function stripLatex(value: unknown): string {
  return answerToString(value)
    .replace(/^\s*\$+|\$+\s*$/g, '')
    .replace(/\\(?:dfrac|tfrac|frac)\{([^{}]+)\}\{([^{}]+)\}/g, '$1/$2')
    .replace(/\\(?:text|mathrm|operatorname)\{([^{}]+)\}/g, '$1')
    .replace(/\\(?:left|right)/g, '')
    .replace(/\\times|\\cdot/g, '*')
    .replace(/\\div/g, '/')
    .replace(/\\%/g, '%')
    .replace(/\\[,;! ]/g, '')
    .replace(/[{}]/g, '')
    .trim();
}

function explicitChoice(value: unknown): { letter: string; tail: string } | null {
  const match = answerToString(value).match(/^\s*(?:option\s*)?([A-Z])(?:\s*[\)\].:\-]\s*(.*)|\s*)$/i);
  if (!match) return null;
  return { letter: match[1].toUpperCase(), tail: (match[2] || '').trim() };
}

function stripExplicitChoiceLabel(value: unknown): string {
  return answerToString(value)
    .replace(/^\s*(?:option\s*)?[A-Z](?:\s*[\)\].:\-]\s*|\s*$)/i, '')
    .trim();
}

function normalizeText(value: unknown): string {
  return stripLatex(stripExplicitChoiceLabel(value))
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\u201c|\u201d/g, '"')
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeIdentificationText(value: unknown): string {
  return stripLatex(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\u201c|\u201d/g, '"')
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function optionTexts(options: readonly string[]): string[] {
  return options.map(normalizeText);
}

function mapChoiceToLetter(options: readonly string[], value: unknown): AnswerNormalizationResult {
  const explicit = explicitChoice(value);
  if (explicit) {
    const index = explicit.letter.charCodeAt(0) - 65;
    if (index < 0 || index >= options.length) {
      return {
        valid: false,
        errors: [validationError('answer_out_of_range', `Choice ${explicit.letter} is outside the available options.`, 'answer', value)]
      };
    }
    return { valid: true, answer: explicit.letter, errors: [] };
  }

  const wanted = normalizeText(value);
  if (!wanted) {
    return { valid: false, errors: [validationError('invalid_answer', 'The answer is blank.', 'answer', value)] };
  }
  const matches: number[] = [];
  optionTexts(options).forEach((option, index) => {
    if (option === wanted) matches.push(index);
  });
  if (matches.length === 0) {
    return { valid: false, errors: [validationError('invalid_answer', 'The answer does not map to an available option.', 'answer', value)] };
  }
  if (matches.length > 1) {
    return { valid: false, errors: [validationError('ambiguous_answer', 'The answer text maps to more than one option.', 'answer', value)] };
  }
  return { valid: true, answer: String.fromCharCode(65 + matches[0]), errors: [] };
}

function splitMultiSelection(options: readonly string[], value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const raw = answerToString(value).trim();
  if (!raw) return [];
  const whole = mapChoiceToLetter(options, raw);
  if (whole.valid) return [raw];
  if (/^[A-Z](?:\s+[A-Z])+$/i.test(raw)) return raw.split(/\s+/);
  return raw.split(/\s*[,;|]\s*/).filter(Boolean);
}

function normalizeMultiSelection(options: readonly string[], value: unknown): AnswerNormalizationResult {
  const items = splitMultiSelection(options, value);
  if (items.length === 0) {
    return { valid: false, errors: [validationError('invalid_answer', 'At least one option must be selected.', 'answer', value)] };
  }
  const letters: string[] = [];
  const errors: QuestionValidationError[] = [];
  for (const item of items) {
    const mapped = mapChoiceToLetter(options, item);
    if (!mapped.valid) {
      errors.push(...mapped.errors);
      continue;
    }
    const letter = mapped.answer as string;
    if (letters.includes(letter)) {
      errors.push(validationError('duplicate_selection', `Choice ${letter} was selected more than once.`, 'answer', value));
    } else {
      letters.push(letter);
    }
  }
  if (errors.length > 0) return { valid: false, errors };
  letters.sort();
  return { valid: true, answer: letters, errors: [] };
}

function trueFalseOptionMap(options: readonly string[]): Map<string, 'true' | 'false'> | null {
  if (options.length === 0) return new Map([['A', 'true'], ['B', 'false']]);
  if (options.length !== 2) return null;
  const mapped = new Map<string, 'true' | 'false'>();
  for (let index = 0; index < options.length; index += 1) {
    const normalized = normalizeText(options[index]);
    const value = normalized === 'true' || normalized === 't'
      ? 'true'
      : (normalized === 'false' || normalized === 'f' ? 'false' : null);
    if (!value || Array.from(mapped.values()).includes(value)) return null;
    mapped.set(String.fromCharCode(65 + index), value);
  }
  return mapped;
}

function normalizeTrueFalse(options: readonly string[], value: unknown): AnswerNormalizationResult {
  const normalized = stripLatex(value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  if (normalized === 'true' || normalized === 't') return { valid: true, answer: 'true', errors: [] };
  if (normalized === 'false' || normalized === 'f') return { valid: true, answer: 'false', errors: [] };
  const explicit = explicitChoice(value);
  if (!explicit) {
    return { valid: false, errors: [validationError('invalid_answer', 'Expected True, False, T, F, A, or B.', 'answer', value)] };
  }
  const mapping = trueFalseOptionMap(options);
  const mapped = mapping?.get(explicit.letter);
  if (!mapped) {
    return { valid: false, errors: [validationError('invalid_true_false_mapping', 'The true/false choice does not map unambiguously.', 'answer', value)] };
  }
  return { valid: true, answer: mapped, errors: [] };
}

function readAnswerPolicy(question: Record<string, unknown>): NumericAnswerPolicy | undefined {
  const raw = question.answer_policy ?? question.answerPolicy ?? question.numeric_policy ?? question.numericPolicy;
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const requiredUnit = source.required_unit ?? source.requiredUnit ?? question.required_unit ?? question.requiredUnit;
  const accepted = source.accepted_units ?? source.acceptedUnits;
  const policy: NumericAnswerPolicy = {
    allow_percentage: Boolean(source.allow_percentage ?? source.allowPercentage),
    percentage_as_fraction: Boolean(source.percentage_as_fraction ?? source.percentageAsFraction ?? source.allow_percentage_equivalent),
    ...(typeof requiredUnit === 'string' && requiredUnit.trim() ? { required_unit: requiredUnit.trim() } : {}),
    ...(Array.isArray(accepted) ? { accepted_units: accepted.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => item.trim()) } : {}),
    allow_omitted_unit: Boolean(source.allow_omitted_unit ?? source.allowOmittedUnit),
    unit_case_sensitive: Boolean(source.unit_case_sensitive ?? source.unitCaseSensitive)
  };
  return Object.values(policy).some(value => value !== false && value !== undefined && (!Array.isArray(value) || value.length > 0))
    ? policy
    : undefined;
}

function normalizeScalarAnswer(value: unknown): AnswerNormalizationResult {
  if (Array.isArray(value) || (value !== null && typeof value === 'object')) {
    return { valid: false, errors: [validationError('invalid_answer', 'This question requires one scalar answer.', 'answer', value)] };
  }
  const normalized = stripLatex(value).normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return { valid: false, errors: [validationError('missing_answer', 'A correct answer is required.', 'answer', value)] };
  }
  return { valid: true, answer: normalized, errors: [] };
}

function normalizeExpectedAnswer(
  type: CanonicalQuestionType,
  options: readonly string[],
  value: unknown
): AnswerNormalizationResult {
  if (type === 'multiple_choice') return mapChoiceToLetter(options, value);
  if (type === 'multiple_choice_multi') return normalizeMultiSelection(options, value);
  if (type === 'true_false') return normalizeTrueFalse(options, value);
  return normalizeScalarAnswer(value);
}

function simpleHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function normalizeQuestion(input: unknown): QuestionValidationResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: [validationError('invalid_question', 'Question must be an object.')] };
  }
  const question = input as Record<string, unknown>;
  const errors: QuestionValidationError[] = [];
  const textValue = question.question ?? question.prompt ?? question.text ?? question.raw_text ?? question.statement;
  const text = typeof textValue === 'string' ? textValue.trim() : '';
  if (!text) errors.push(validationError('missing_question_text', 'Question text is required.', 'question', textValue));

  const resolvedType = resolveQuestionType(question);
  if (!resolvedType.type) {
    errors.push(validationError('unsupported_question_type', `Unsupported explicit question type: ${answerToString(question.type ?? question.question_type ?? question.questionType)}`, 'type'));
  }
  const type = resolvedType.type;

  const rawOptions = getQuestionOptions(question);
  if (rawOptions.some(option => typeof option !== 'string')) {
    errors.push(validationError('invalid_options', 'Every option must be a string.', 'options'));
  }
  const options = rawOptions.filter((option): option is string => typeof option === 'string').map(option => option.trim());
  if (options.some(option => !option)) errors.push(validationError('empty_option', 'Options cannot be blank.', 'options'));
  if (options.length > 26) errors.push(validationError('invalid_option_count', 'At most 26 letter-addressable options are supported.', 'options'));

  if (type === 'multiple_choice' || type === 'multiple_choice_multi') {
    if (options.length < 2) errors.push(validationError('invalid_option_count', 'Choice questions require at least two options.', 'options'));
    const normalizedOptions = optionTexts(options);
    if (new Set(normalizedOptions).size !== normalizedOptions.length) {
      errors.push(validationError('duplicate_options', 'Choice options must be unique after normalization.', 'options'));
    }
  }
  if (type === 'true_false' && !trueFalseOptionMap(options)) {
    errors.push(validationError('invalid_true_false_mapping', 'True/false options must map uniquely to True and False.', 'options'));
  }

  const pointsRaw = question.points;
  const points = pointsRaw === undefined || pointsRaw === null || pointsRaw === '' ? 1 : Number(pointsRaw);
  if (!Number.isFinite(points) || points <= 0) {
    errors.push(validationError('invalid_points', 'Points must be a finite number greater than zero.', 'points', pointsRaw));
  }

  let normalizedAnswer: string | string[] = '';
  const aliases = presentAnswerAliases(question);
  if (type && aliases.length > 0) {
    const selected = normalizeExpectedAnswer(type, options, aliases[0].value);
    if (selected.valid) {
      normalizedAnswer = selected.answer;
      for (const alias of aliases.slice(1)) {
        const candidate = normalizeExpectedAnswer(type, options, alias.value);
        // A corrected legacy alias intentionally wins over a stale lower-priority
        // `answer` field. Conflicts between corrected aliases still fail closed.
        if (alias.key === 'answer' && aliases[0].key !== 'answer') continue;
        if (!candidate.valid || JSON.stringify(candidate.answer) !== JSON.stringify(normalizedAnswer)) {
          errors.push(validationError(
            'conflicting_answer_aliases',
            `Answer field ${alias.key} conflicts with higher-precedence ${aliases[0].key}.`,
            alias.key,
            alias.value
          ));
        }
      }
    } else {
      errors.push(...selected.errors);
    }
  } else if (type && !isSemanticQuestion(type)) {
    errors.push(validationError('missing_answer', 'A correct answer is required.', 'answer'));
  }

  const source = question.source && typeof question.source === 'object' && !Array.isArray(question.source)
    ? question.source as NormalizedQuestion['source']
    : undefined;
  if (source && (typeof source.original_index !== 'string' || !source.original_index.trim())) {
    errors.push(validationError('invalid_source', 'source.original_index must be a non-empty string.', 'source.original_index'));
  }

  if (errors.length > 0 || !type || !text || !Number.isFinite(points) || points <= 0) {
    return { valid: false, errors };
  }

  const rawId = question.id ?? question.question_id ?? source?.original_index;
  const id = typeof rawId === 'string' && rawId.trim()
    ? rawId.trim()
    : `q_${simpleHash(`${type}\0${text}`)}`;
  const solution = typeof question.solution === 'string' && question.solution.trim()
    ? question.solution.trim()
    : undefined;
  const verification = question.verification && typeof question.verification === 'object' && !Array.isArray(question.verification)
    ? question.verification as NormalizedQuestion['verification']
    : undefined;
  const answerPolicy = readAnswerPolicy(question);

  return {
    valid: true,
    errors: [],
    question: {
      id,
      type,
      question: text,
      options,
      answer: normalizedAnswer,
      points: roundNumber(points),
      grading_mode: isSemanticQuestion(question) ? 'semantic' : 'deterministic',
      ...(solution ? { solution } : {}),
      ...(source ? { source: { ...source, original_index: source.original_index.trim() } } : {}),
      ...(verification ? { verification } : {}),
      ...(answerPolicy ? { answer_policy: answerPolicy } : {})
    }
  };
}

export function validateQuestion(input: unknown): QuestionValidationResult {
  return normalizeQuestion(input);
}

export function normalizeQuestionForStorage(input: unknown): QuestionStorageNormalizationResult {
  const result = normalizeQuestion(input);
  if (!result.valid) return { valid: false, errors: result.errors };
  const original = input as Record<string, unknown>;
  const stored: Record<string, unknown> = { ...original };
  for (const alias of ANSWER_ALIAS_PRECEDENCE) delete stored[alias];
  delete stored.question_type;
  delete stored.questionType;
  delete stored.prompt;
  delete stored.text;
  delete stored.raw_text;
  delete stored.statement;
  delete stored.choices;
  delete stored.answers;
  stored.id = result.question.id;
  stored.type = result.question.type;
  stored.question = result.question.question;
  stored.options = result.question.options;
  stored.answer = result.question.answer;
  stored.points = result.question.points;
  stored.grading_mode = result.question.grading_mode;
  if (result.question.answer_policy) stored.answer_policy = result.question.answer_policy;
  return { valid: true, errors: [], normalized: result.question, question: stored as Question };
}

interface ParsedNumericAnswer {
  value: number;
  percentage: boolean;
  unit: string;
}

function parsePlainNumber(value: string): number | null {
  const pattern = /^[-+]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)$/;
  if (!pattern.test(value)) return null;
  const parsed = Number(value.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNumericAnswer(value: unknown): ParsedNumericAnswer | null {
  const normalized = stripLatex(value).normalize('NFKC').trim();
  const match = normalized.match(/^([-+]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:\s*\/\s*[-+]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+))?)\s*(%)?(?:\s+(.+))?$/);
  if (!match) return null;
  const numericPart = match[1].trim();
  const percentage = Boolean(match[2]);
  const unit = (match[3] || '').trim();
  const fraction = numericPart.match(/^(.+?)\s*\/\s*(.+)$/);
  let numeric: number | null;
  if (fraction) {
    const numerator = parsePlainNumber(fraction[1].trim());
    const denominator = parsePlainNumber(fraction[2].trim());
    numeric = numerator !== null && denominator !== null && denominator !== 0
      ? numerator / denominator
      : null;
  } else {
    numeric = parsePlainNumber(numericPart);
  }
  return numeric === null ? null : { value: numeric, percentage, unit };
}

function normalizedUnit(value: string, caseSensitive: boolean): string {
  const normalized = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return caseSensitive ? normalized : normalized.toLowerCase();
}

function numericAnswersEqual(
  expected: ParsedNumericAnswer,
  actual: ParsedNumericAnswer,
  policy: NumericAnswerPolicy = {}
): boolean {
  let expectedValue = expected.value;
  let actualValue = actual.value;
  if (expected.percentage !== actual.percentage) {
    if (policy.percentage_as_fraction) {
      if (expected.percentage) expectedValue /= 100;
      if (actual.percentage) actualValue /= 100;
    } else if (!policy.allow_percentage) {
      return false;
    }
  }

  const caseSensitive = Boolean(policy.unit_case_sensitive);
  const required = policy.required_unit || expected.unit;
  const allowedUnits = [required, ...(policy.accepted_units || [])]
    .filter(Boolean)
    .map(unit => normalizedUnit(unit, caseSensitive));
  const actualUnit = normalizedUnit(actual.unit, caseSensitive);
  const expectedUnit = normalizedUnit(expected.unit, caseSensitive);
  if (required) {
    if (!actualUnit && !policy.allow_omitted_unit) return false;
    if (actualUnit && !allowedUnits.includes(actualUnit)) return false;
  } else if (actualUnit || expectedUnit) {
    if (actualUnit !== expectedUnit) return false;
  }

  return Math.abs(expectedValue - actualValue) <= Math.max(1, Math.abs(expectedValue)) * 1e-10;
}

function identificationAnswersEqual(question: NormalizedQuestion, actual: unknown): boolean {
  const expectedText = answerToString(question.answer).trim();
  const actualText = stripLatex(actual).normalize('NFKC').replace(/\s+/g, ' ').trim();
  const expectedNumeric = parseNumericAnswer(expectedText);
  const actualNumeric = parseNumericAnswer(actualText);
  if (expectedNumeric || actualNumeric) {
    return Boolean(expectedNumeric && actualNumeric && numericAnswersEqual(expectedNumeric, actualNumeric, question.answer_policy));
  }
  return normalizeIdentificationText(expectedText) !== ''
    && normalizeIdentificationText(expectedText) === normalizeIdentificationText(actualText);
}

function isBlankAnswer(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0 || value.every(isBlankAnswer);
  const normalized = answerToString(value).trim().toLowerCase();
  return normalized === '' || normalized === 'no answer';
}

function roundNumber(value: number, decimals = SCORE_DECIMALS): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function normalizeGradeScore(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return roundNumber(Math.max(0, Math.min(1, parsed)));
}

function localResult(
  questionType: CanonicalQuestionType | 'unsupported',
  correctAnswer: unknown,
  points: number,
  status: GradeStatus,
  score: number,
  requiresSemanticGrading: boolean,
  errors: QuestionValidationError[] = []
): LocalGradeResult {
  const normalizedScore = normalizeGradeScore(score) ?? 0;
  const authoritative = status === 'graded';
  return {
    isCorrect: authoritative && normalizedScore === 1,
    scoreFraction: normalizedScore,
    questionType,
    correctAnswer,
    requiresSemanticGrading,
    gradeStatus: status,
    authoritative,
    points,
    earnedPoints: authoritative ? roundNumber(points * normalizedScore) : 0,
    errors
  };
}

export function gradeQuestionLocally(
  rawQuestion: unknown,
  rawStudentAnswer: unknown,
  hasSnapshots = false
): LocalGradeResult {
  const validation = normalizeQuestion(rawQuestion);
  const fallbackType = canonicalQuestionType(rawQuestion);
  const fallbackAnswer = getCorrectAnswer(rawQuestion);
  const semantic = isSemanticQuestion(rawQuestion);
  if (!validation.valid) {
    return localResult(fallbackType, fallbackAnswer, 1, 'invalid_response', 0, semantic, validation.errors);
  }

  const question = validation.question;
  const studentAnswer = sanitizeStudentAnswer(rawStudentAnswer);
  if (isBlankAnswer(studentAnswer) && !hasSnapshots) {
    return localResult(question.type, question.answer, question.points, 'graded', 0, false);
  }

  // Non-blank open-ended and graphing work is never converted into a local zero.
  if (semantic) {
    return localResult(question.type, question.answer, question.points, 'pending', 0, true);
  }

  if (question.type === 'multiple_choice') {
    const actual = mapChoiceToLetter(question.options, studentAnswer);
    const correct = actual.valid && actual.answer === question.answer;
    return localResult(question.type, question.answer, question.points, 'graded', correct ? 1 : 0, false, actual.valid ? [] : actual.errors);
  }

  if (question.type === 'multiple_choice_multi') {
    const actual = normalizeMultiSelection(question.options, studentAnswer);
    if (!actual.valid) {
      return localResult(question.type, question.answer, question.points, 'graded', 0, false, actual.errors);
    }
    const expected = new Set(question.answer as string[]);
    const selected = new Set(actual.answer as string[]);
    let correctHits = 0;
    let wrongHits = 0;
    selected.forEach(letter => expected.has(letter) ? correctHits += 1 : wrongHits += 1);
    // One wrong extra selection removes half the credit of one correct selection.
    const partial = expected.size > 0
      ? (correctHits - wrongHits * 0.5) / expected.size
      : 0;
    const score = normalizeGradeScore(partial) ?? 0;
    return localResult(question.type, question.answer, question.points, 'graded', score, false);
  }

  if (question.type === 'true_false') {
    const actual = normalizeTrueFalse(question.options, studentAnswer);
    const correct = actual.valid && actual.answer === question.answer;
    return localResult(question.type, question.answer, question.points, 'graded', correct ? 1 : 0, false, actual.valid ? [] : actual.errors);
  }

  const correct = identificationAnswersEqual(question, studentAnswer);
  return localResult(question.type, question.answer, question.points, 'graded', correct ? 1 : 0, false);
}

export function scoreQuizDetails(
  questions: readonly unknown[],
  details: readonly (Partial<GradedDetail> | null | undefined)[]
): QuizScoreSummary {
  let earnedPoints = 0;
  let maxPoints = 0;
  const incompleteQuestionIndexes: number[] = [];
  questions.forEach((rawQuestion, index) => {
    const normalized = normalizeQuestion(rawQuestion);
    const points = normalized.valid ? normalized.question.points : 1;
    maxPoints += points;
    if (!normalized.valid) {
      incompleteQuestionIndexes.push(index);
      return;
    }
    const detail = details[index];
    if (!detail || detail.grade_status !== 'graded') {
      incompleteQuestionIndexes.push(index);
      return;
    }
    const fraction = normalizeGradeScore(detail.score_fraction);
    if (fraction === null) {
      incompleteQuestionIndexes.push(index);
      return;
    }
    earnedPoints += roundNumber(points * fraction);
  });
  earnedPoints = roundNumber(earnedPoints);
  maxPoints = roundNumber(maxPoints);
  return {
    earned_points: earnedPoints,
    max_points: maxPoints,
    accuracy_pct: maxPoints > 0 ? roundNumber((earnedPoints / maxPoints) * 100) : 0,
    grading_complete: incompleteQuestionIndexes.length === 0,
    incomplete_question_indexes: incompleteQuestionIndexes
  };
}
