import {
  canonicalQuestionType,
  getCorrectAnswer,
  getQuestionOptions,
  gradeQuestionLocally,
  stripLatex
} from './grading.ts';
import {
  NON_MATH_RULES,
  SHARED_LATEX_RULES,
  WORKSHEET_SOLVER_PROMPT,
  WORKSHEET_SOLVER_PROMPT_NON_MATH
} from '../../prompts.ts';
import type {
  CanonicalQuestionType,
  QuestionVerification,
  WorksheetQuestionSource
} from '../types.ts';
export type { QuestionVerification, WorksheetQuestionSource } from '../types.ts';

export type CanonicalWorksheetQuestionType = CanonicalQuestionType;

export interface WorksheetSolverTrace {
  model: string;
  status: 'fulfilled' | 'failed' | 'invalid';
  answer?: string | string[];
  reason?: string;
}

export interface WorksheetQaMetadata {
  golden_answer?: string | string[];
  solver_candidates?: WorksheetSolverTrace[];
  adjudicator_reason?: string;
}

export type WorksheetDiagnosticCode =
  | 'invalid_source_id'
  | 'duplicate_source_id'
  | 'duplicate_question_text'
  | 'duplicate_golden_id'
  | 'missing_golden_id'
  | 'unmatched_golden_id'
  | 'invalid_golden_answer'
  | 'ambiguous_option_answer'
  | 'unresolved_fragment'
  | 'missing_question_text'
  | 'unsupported_question_type'
  | 'invalid_options'
  | 'duplicate_option'
  | 'invalid_answer'
  | 'invalid_points'
  | 'missing_solution'
  | 'grading_contract_mismatch'
  | 'solver_failure'
  | 'solver_disagreement'
  | 'invalid_checker_response'
  | 'review_required'
  | 'unverified_question'
  | 'missing_recheck_output'
  | 'unexpected_recheck_output'
  | 'invalid_recheck_output';

export interface WorksheetDiagnostic {
  code: WorksheetDiagnosticCode;
  severity: 'error' | 'warning';
  message: string;
  source_id?: string;
  page_number?: number;
  source_file?: string;
}

export interface NormalizedWorksheetQuestion {
  [key: string]: unknown;
  id: string;
  type: CanonicalWorksheetQuestionType;
  question: string;
  options: string[];
  answer: string | string[];
  points: number;
  solution?: string;
  source: WorksheetQuestionSource;
  verification?: QuestionVerification;
  worksheet_qa?: WorksheetQaMetadata;
}

export interface WorksheetQuestionValidationResult {
  valid: boolean;
  question?: NormalizedWorksheetQuestion;
  diagnostics: WorksheetDiagnostic[];
}

export interface GoldenAnswerEntry {
  source_id: string;
  answer: unknown;
}

export type GoldenAnswerInput =
  | Readonly<Record<string, unknown>>
  | readonly GoldenAnswerEntry[];

export interface GoldenAnswerIndex {
  entries: ReadonlyMap<string, GoldenAnswerEntry>;
  diagnostics: WorksheetDiagnostic[];
}

export interface GoldenCoverageResult extends GoldenAnswerIndex {
  question_ids: string[];
}

export interface AnswerMappingResult {
  valid: boolean;
  answer?: string | string[];
  diagnostics: WorksheetDiagnostic[];
}

export interface ExtractedWorksheetPage {
  source_file?: string;
  page_number: number;
  file_order?: number;
  questions: readonly unknown[];
  fragments?: readonly WorksheetPageFragment[];
}

export interface WorksheetPageFragment {
  kind: 'choices' | 'text' | 'image';
  target_source_id?: string;
  text?: string;
  options?: readonly unknown[];
  crop_or_image_reference?: string;
}

export interface UnresolvedWorksheetFragment extends WorksheetPageFragment {
  source_file?: string;
  page_number: number;
  reason: string;
}

export interface ReconciledWorksheetQuestion {
  [key: string]: unknown;
  source_id: string;
  source_order: number;
  question: string;
  options: string[];
  source: WorksheetQuestionSource;
}

export interface WorksheetReconciliationResult {
  questions: ReconciledWorksheetQuestion[];
  unresolved_fragments: UnresolvedWorksheetFragment[];
  diagnostics: WorksheetDiagnostic[];
}

export interface IndependentSolverCandidate {
  model: string;
  status: 'fulfilled' | 'failed';
  output?: unknown;
  error?: string;
}

export interface WorksheetAdjudicatorDecision {
  status: 'fulfilled' | 'failed';
  verified?: boolean;
  accepted_model?: string;
  corrected_answer?: unknown;
  corrected_solution?: string;
  corrected_type?: string;
  reason?: string;
}

export interface WorksheetConsensusResult {
  publishable: boolean;
  question: Record<string, unknown>;
  verification: QuestionVerification;
  worksheet_qa: WorksheetQaMetadata;
  diagnostics: WorksheetDiagnostic[];
}

export interface WorksheetQuizValidationOptions {
  require_solution?: boolean;
  allow_review_required?: boolean;
  require_verification?: boolean;
  golden_answers?: GoldenAnswerInput;
  prior_diagnostics?: readonly WorksheetDiagnostic[];
}

export interface WorksheetQuizValidationResult {
  valid: boolean;
  questions: NormalizedWorksheetQuestion[];
  diagnostics: WorksheetDiagnostic[];
}

export interface WorksheetRecheckSummary {
  changed: string[];
  unchanged: string[];
  invalid: string[];
  review_required: string[];
  missing: string[];
  unexpected: string[];
}

export interface WorksheetRecheckMergeResult {
  success: boolean;
  questions: Record<string, unknown>[];
  diagnostics: WorksheetDiagnostic[];
  summary: WorksheetRecheckSummary;
}

const TYPE_ALIASES: Readonly<Record<string, CanonicalWorksheetQuestionType>> = {
  'multiple choice': 'multiple_choice',
  'multiple select': 'multiple_choice_multi',
  'multiple choice multi': 'multiple_choice_multi',
  'multi select': 'multiple_choice_multi',
  'true false': 'true_false',
  identification: 'identification',
  'short answer': 'open_ended',
  essay: 'open_ended',
  'open ended': 'open_ended',
  'open response': 'open_ended',
  'free response': 'open_ended',
  graphing: 'graphing',
  drawing: 'graphing'
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value).trim();
  }
  return '';
}

function hasAnswerValue(value: unknown): boolean {
  return Array.isArray(value)
    ? value.some(item => textValue(item) !== '')
    : textValue(value) !== '';
}

function diagnostic(
  code: WorksheetDiagnosticCode,
  message: string,
  sourceId?: string,
  severity: 'error' | 'warning' = 'error'
): WorksheetDiagnostic {
  return { code, severity, message, ...(sourceId ? { source_id: sourceId } : {}) };
}

/** Trims only outer whitespace. It never parses numbers, so 01, 11a and 11b remain distinct. */
export function normalizeWorksheetSourceId(value: unknown): string {
  return textValue(value);
}

export function getWorksheetSourceId(value: unknown): string {
  if (!isRecord(value)) return '';
  const source = isRecord(value.source) ? value.source : undefined;
  return normalizeWorksheetSourceId(
    source?.original_index
      ?? value.original_index
      ?? value.source_id
      ?? value.id
  );
}

export function worksheetSourceKey(source: WorksheetQuestionSource): string {
  return JSON.stringify([
    source.source_file ?? '',
    source.page_number ?? null,
    normalizeWorksheetSourceId(source.original_index)
  ]);
}

function readQuestionText(value: Record<string, unknown>): string {
  return textValue(value.question ?? value.raw_text ?? value.statement);
}

function readOptions(value: unknown): string[] {
  return getQuestionOptions(value)
    .map((option: unknown) => textValue(option))
    .filter(Boolean);
}

function stripChoiceLabel(value: string): string {
  return value.replace(/^\s*(?:option\s+)?[A-Z]\s*[).:\-]\s*/i, '').trim();
}

function normalizedComparableText(value: unknown): string {
  return stripLatex(textValue(value))
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedOptionText(value: unknown): string {
  return normalizedComparableText(stripChoiceLabel(textValue(value)));
}

function strictQuestionType(value: unknown): CanonicalWorksheetQuestionType | null {
  if (!isRecord(value)) return null;
  const raw = textValue(value.type ?? value.question_type ?? value.questionType)
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
  const mapped = TYPE_ALIASES[raw];
  if (!mapped) return null;
  const canonical = canonicalQuestionType({ ...value, type: mapped });
  return canonical === 'unsupported' ? null : canonical;
}

function sourceFromQuestion(value: Record<string, unknown>): WorksheetQuestionSource | null {
  const rawSource = isRecord(value.source) ? value.source : {};
  const originalIndex = normalizeWorksheetSourceId(
    rawSource.original_index ?? value.original_index ?? value.source_id ?? value.id
  );
  if (!originalIndex) return null;
  const sourceFile = textValue(rawSource.source_file ?? value.source_file);
  const pageValue = Number(rawSource.page_number ?? value.page_number);
  const cropReference = textValue(
    rawSource.crop_or_image_reference
      ?? value.crop_or_image_reference
      ?? value.image_reference
      ?? value.crop_data_url
      ?? value.image_url
  );
  return {
    original_index: originalIndex,
    ...(sourceFile ? { source_file: sourceFile } : {}),
    ...(Number.isInteger(pageValue) && pageValue > 0 ? { page_number: pageValue } : {}),
    ...(cropReference ? { crop_or_image_reference: cropReference } : {})
  };
}

function choiceLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

function mapSingleChoice(options: string[], value: unknown, sourceId: string): AnswerMappingResult {
  const diagnostics: WorksheetDiagnostic[] = [];
  const normalizedOptions = options.map(normalizedOptionText);
  if (normalizedOptions.some(option => !option)) {
    return { valid: false, diagnostics: [diagnostic('invalid_options', 'An answer option is empty.', sourceId)] };
  }
  if (new Set(normalizedOptions).size !== normalizedOptions.length) {
    return { valid: false, diagnostics: [diagnostic('duplicate_option', 'Normalized answer options must be unique.', sourceId)] };
  }

  const raw = textValue(value);
  const labelled = raw.match(/^\s*(?:option\s+)?([A-Z])(?:\s*[).:\-]\s*(.*))?\s*$/i);
  if (labelled) {
    const index = labelled[1].toUpperCase().charCodeAt(0) - 65;
    if (index < 0 || index >= options.length) {
      return { valid: false, diagnostics: [diagnostic('invalid_answer', `Choice ${labelled[1].toUpperCase()} is outside the available options.`, sourceId)] };
    }
    const labelledText = normalizedComparableText(labelled[2] ?? '');
    if (labelledText && labelledText !== normalizedOptions[index]) {
      return { valid: false, diagnostics: [diagnostic('invalid_answer', 'The answer letter and labelled option text disagree.', sourceId)] };
    }
    return { valid: true, answer: choiceLetter(index), diagnostics };
  }

  const target = normalizedOptionText(raw);
  const matches = normalizedOptions
    .map((option, index) => option === target ? index : -1)
    .filter(index => index >= 0);
  if (matches.length === 1) return { valid: true, answer: choiceLetter(matches[0]), diagnostics };
  if (matches.length > 1) {
    return { valid: false, diagnostics: [diagnostic('ambiguous_option_answer', 'The answer text maps to more than one option.', sourceId)] };
  }
  return { valid: false, diagnostics: [diagnostic('invalid_answer', 'The answer does not map to an available option.', sourceId)] };
}

function mapTrueFalse(options: string[], value: unknown, sourceId: string): AnswerMappingResult {
  if (options.length !== 2) {
    return { valid: false, diagnostics: [diagnostic('invalid_options', 'True/false questions require exactly two options.', sourceId)] };
  }
  const normalized = options.map(normalizedOptionText);
  if (new Set(normalized).size !== 2 || !normalized.includes('true') || !normalized.includes('false')) {
    return { valid: false, diagnostics: [diagnostic('invalid_options', 'True/false options must map uniquely to True and False.', sourceId)] };
  }
  const choiceMapping = mapSingleChoice(options, value, sourceId);
  if (choiceMapping.valid) return choiceMapping;
  const raw = textValue(value).toLowerCase();
  if (/^(?:a|b)$/.test(raw)) {
    const index = raw.toUpperCase().charCodeAt(0) - 65;
    return { valid: true, answer: choiceLetter(index), diagnostics: [] };
  }
  const desired = ['t', 'true'].includes(raw) ? 'true' : (['f', 'false'].includes(raw) ? 'false' : '');
  const index = normalized.indexOf(desired);
  return index >= 0
    ? { valid: true, answer: choiceLetter(index), diagnostics: [] }
    : { valid: false, diagnostics: [diagnostic('invalid_answer', 'The true/false answer is not recognized.', sourceId)] };
}

export function mapWorksheetAnswerToCanonical(question: unknown, value: unknown): AnswerMappingResult {
  if (!isRecord(question)) {
    return { valid: false, diagnostics: [diagnostic('invalid_answer', 'Question data is not an object.')] };
  }
  const sourceId = getWorksheetSourceId(question);
  const type = strictQuestionType(question);
  if (!type) {
    return { valid: false, diagnostics: [diagnostic('unsupported_question_type', 'Question type is unsupported.', sourceId)] };
  }
  const options = readOptions(question);
  if (type === 'multiple_choice') return mapSingleChoice(options, value, sourceId);
  if (type === 'true_false') return mapTrueFalse(options, value, sourceId);
  if (type === 'multiple_choice_multi') {
    const rawItems = Array.isArray(value)
      ? value
      : textValue(value).split(/[,;|\n]+/).map(item => item.trim()).filter(Boolean);
    if (rawItems.length === 0) {
      return { valid: false, diagnostics: [diagnostic('invalid_answer', 'A multiple-select answer is empty.', sourceId)] };
    }
    const mapped: string[] = [];
    const diagnostics: WorksheetDiagnostic[] = [];
    for (const item of rawItems) {
      const result = mapSingleChoice(options, item, sourceId);
      diagnostics.push(...result.diagnostics);
      if (result.valid && typeof result.answer === 'string') mapped.push(result.answer);
    }
    const unique = [...new Set(mapped)].sort();
    if (mapped.length !== unique.length) {
      diagnostics.push(diagnostic('invalid_answer', 'Duplicate multiple-select answers are not allowed.', sourceId));
    }
    return { valid: diagnostics.length === 0, ...(diagnostics.length === 0 ? { answer: unique } : {}), diagnostics };
  }
  if (Array.isArray(value)) {
    return { valid: false, diagnostics: [diagnostic('invalid_answer', 'This question type requires a scalar answer.', sourceId)] };
  }
  const answer = textValue(value);
  if (!answer || answer.toLowerCase() === 'no answer') {
    return { valid: false, diagnostics: [diagnostic('invalid_answer', 'The question has no valid answer.', sourceId)] };
  }
  return { valid: true, answer, diagnostics: [] };
}

export function areCanonicalWorksheetAnswersEquivalent(question: unknown, left: unknown, right: unknown): boolean {
  const leftResult = mapWorksheetAnswerToCanonical(question, left);
  const rightResult = mapWorksheetAnswerToCanonical(question, right);
  if (!leftResult.valid || !rightResult.valid) return false;
  if (Array.isArray(leftResult.answer) || Array.isArray(rightResult.answer)) {
    return JSON.stringify(leftResult.answer) === JSON.stringify(rightResult.answer);
  }
  const type = strictQuestionType(question);
  if (type === 'open_ended' || type === 'graphing') {
    return normalizedComparableText(leftResult.answer) === normalizedComparableText(rightResult.answer);
  }
  const comparisonQuestion = isRecord(question) ? { ...question, answer: leftResult.answer } : { answer: leftResult.answer };
  const forward = gradeQuestionLocally(comparisonQuestion, rightResult.answer);
  const reverse = gradeQuestionLocally({ ...comparisonQuestion, answer: rightResult.answer }, leftResult.answer);
  return forward.isCorrect && reverse.isCorrect;
}

export function validateWorksheetQuestion(
  value: unknown,
  options: { require_solution?: boolean } = {}
): WorksheetQuestionValidationResult {
  if (!isRecord(value)) {
    return { valid: false, diagnostics: [diagnostic('missing_question_text', 'Question data is not an object.')] };
  }
  const diagnostics: WorksheetDiagnostic[] = [];
  const source = sourceFromQuestion(value);
  const sourceId = source?.original_index ?? '';
  if (!source) diagnostics.push(diagnostic('invalid_source_id', 'A stable worksheet source identifier is required.'));
  const questionText = readQuestionText(value);
  if (!questionText) diagnostics.push(diagnostic('missing_question_text', 'Question text is empty.', sourceId));
  const type = strictQuestionType(value);
  if (!type) diagnostics.push(diagnostic('unsupported_question_type', 'Question type is unsupported.', sourceId));
  const rawOptions = readOptions(value);
  const normalizedOptions = rawOptions.map(normalizedOptionText);
  if (normalizedOptions.some(option => !option)) diagnostics.push(diagnostic('invalid_options', 'An option is empty.', sourceId));
  if (new Set(normalizedOptions).size !== normalizedOptions.length) diagnostics.push(diagnostic('duplicate_option', 'Normalized options must be unique.', sourceId));
  if (type && ['multiple_choice', 'multiple_choice_multi'].includes(type) && (rawOptions.length < 2 || rawOptions.length > 26)) {
    diagnostics.push(diagnostic('invalid_options', 'Choice questions require between 2 and 26 options.', sourceId));
  }
  if (type && ['identification', 'open_ended', 'graphing'].includes(type) && rawOptions.length !== 0) {
    diagnostics.push(diagnostic('invalid_options', `${type} questions must not contain answer options.`, sourceId));
  }
  const answerResult = type ? mapWorksheetAnswerToCanonical({ ...value, type }, getCorrectAnswer(value)) : { valid: false, diagnostics: [] };
  diagnostics.push(...answerResult.diagnostics);
  const pointsValue = value.points === undefined ? 1 : Number(value.points);
  if (!Number.isFinite(pointsValue) || pointsValue <= 0) diagnostics.push(diagnostic('invalid_points', 'Question points must be a positive finite number.', sourceId));
  const solution = textValue(value.solution);
  if (options.require_solution && !solution) diagnostics.push(diagnostic('missing_solution', 'A worked solution is required.', sourceId));

  if (diagnostics.some(item => item.severity === 'error') || !source || !type || !answerResult.valid || answerResult.answer === undefined) {
    return { valid: false, diagnostics };
  }
  const rawVerification = isRecord(value.verification) ? value.verification : undefined;
  const validAnswerSources = new Set(['golden_key', 'solver_consensus', 'manual']);
  const validStatuses = new Set(['verified', 'review_required', 'unverified', 'invalid']);
  const verification = rawVerification
    && validAnswerSources.has(String(rawVerification.answer_source))
    && validStatuses.has(String(rawVerification.verification_status))
    ? {
        answer_source: rawVerification.answer_source,
        verification_status: rawVerification.verification_status,
        ...(textValue(rawVerification.reason) ? { reason: textValue(rawVerification.reason) } : {}),
        ...(Array.isArray(rawVerification.solver_models)
          ? { solver_models: rawVerification.solver_models.map(textValue).filter(Boolean) }
          : {})
      } as QuestionVerification
    : undefined;
  const normalized: NormalizedWorksheetQuestion = {
    ...value,
    id: sourceId,
    type,
    question: questionText,
    options: rawOptions,
    answer: answerResult.answer,
    points: pointsValue,
    source,
    ...(solution ? { solution } : {}),
    ...(verification ? { verification } : {})
  };
  if (['multiple_choice', 'multiple_choice_multi', 'true_false', 'identification'].includes(type)) {
    const local = gradeQuestionLocally(normalized, normalized.answer);
    if (!local.isCorrect || local.requiresSemanticGrading) {
      diagnostics.push(diagnostic('grading_contract_mismatch', 'The canonical deterministic grader cannot recognize the stored answer.', sourceId));
      return { valid: false, diagnostics };
    }
  }
  return { valid: true, question: normalized, diagnostics };
}

export function indexGoldenAnswers(input: GoldenAnswerInput): GoldenAnswerIndex {
  const entries = new Map<string, GoldenAnswerEntry>();
  const diagnostics: WorksheetDiagnostic[] = [];
  const sourceEntries: GoldenAnswerEntry[] = Array.isArray(input)
    ? input.map(entry => ({ source_id: normalizeWorksheetSourceId(entry.source_id), answer: entry.answer }))
    : Object.entries(input).map(([sourceId, answer]) => ({ source_id: normalizeWorksheetSourceId(sourceId), answer }));
  for (const entry of sourceEntries) {
    if (!entry.source_id) {
      diagnostics.push(diagnostic('invalid_source_id', 'An answer-key entry has no source identifier.'));
      continue;
    }
    if (entries.has(entry.source_id)) {
      diagnostics.push(diagnostic('duplicate_golden_id', `Answer key contains duplicate ID "${entry.source_id}".`, entry.source_id));
      continue;
    }
    entries.set(entry.source_id, entry);
  }
  return { entries, diagnostics };
}

export function diagnoseGoldenCoverage(questions: readonly unknown[], input: GoldenAnswerInput): GoldenCoverageResult {
  const indexed = indexGoldenAnswers(input);
  const diagnostics = [...indexed.diagnostics];
  const questionIds = questions.map(getWorksheetSourceId);
  const seen = new Set<string>();
  for (const sourceId of questionIds) {
    if (!sourceId) {
      diagnostics.push(diagnostic('invalid_source_id', 'A worksheet question has no stable source identifier.'));
      continue;
    }
    if (seen.has(sourceId)) diagnostics.push(diagnostic('duplicate_source_id', `Worksheet contains duplicate ID "${sourceId}".`, sourceId));
    seen.add(sourceId);
    if (!indexed.entries.has(sourceId)) diagnostics.push(diagnostic('missing_golden_id', `No golden answer exists for "${sourceId}".`, sourceId));
  }
  for (const sourceId of indexed.entries.keys()) {
    if (!seen.has(sourceId)) diagnostics.push(diagnostic('unmatched_golden_id', `Golden answer "${sourceId}" has no worksheet question.`, sourceId));
  }
  return { ...indexed, diagnostics, question_ids: questionIds };
}

export function applyGoldenAnswers(
  questions: readonly unknown[],
  input: GoldenAnswerInput
): { questions: Record<string, unknown>[]; diagnostics: WorksheetDiagnostic[] } {
  const coverage = diagnoseGoldenCoverage(questions, input);
  const diagnostics = [...coverage.diagnostics];
  const applied = questions.map(value => {
    if (!isRecord(value)) return {};
    const sourceId = getWorksheetSourceId(value);
    const golden = coverage.entries.get(sourceId);
    if (!golden) return { ...value };
    const mapped = mapWorksheetAnswerToCanonical(value, golden.answer);
    diagnostics.push(...mapped.diagnostics.map(item => ({ ...item, code: item.code === 'ambiguous_option_answer' ? item.code : 'invalid_golden_answer' as const })));
    if (!mapped.valid || mapped.answer === undefined) return { ...value };
    const prior = getCorrectAnswer(value);
    const conflict = hasAnswerValue(prior) && !areCanonicalWorksheetAnswersEquivalent(value, prior, mapped.answer);
    const verification: QuestionVerification = {
      answer_source: 'golden_key',
      verification_status: conflict ? 'review_required' : 'verified',
      reason: conflict ? 'Independent or existing answer disagrees with the authoritative golden key.' : 'Answer mapped deterministically from the golden key.'
    };
    if (conflict) diagnostics.push(diagnostic('review_required', `Answer for "${sourceId}" conflicts with the golden key.`, sourceId));
    return {
      ...value,
      answer: mapped.answer,
      verification,
      worksheet_qa: {
        ...(isRecord(value.worksheet_qa) ? value.worksheet_qa : {}),
        golden_answer: mapped.answer,
        ...(hasAnswerValue(prior) ? { solver_candidates: [{ model: 'existing_answer', status: 'fulfilled' as const, answer: Array.isArray(prior) ? prior.map(textValue) : textValue(prior) }] } : {})
      }
    };
  });
  return { questions: applied, diagnostics };
}

function pageImageReference(value: Record<string, unknown>): string {
  const explicit = textValue(value.crop_or_image_reference ?? value.image_reference ?? value.crop_data_url ?? value.image_url);
  if (explicit) return explicit;
  return /<img\b[^>]*\bsrc\s*=/i.test(readQuestionText(value)) ? 'embedded-in-question-html' : '';
}

export function reconcileWorksheetPages(pages: readonly ExtractedWorksheetPage[]): WorksheetReconciliationResult {
  const diagnostics: WorksheetDiagnostic[] = [];
  const unresolved: UnresolvedWorksheetFragment[] = [];
  const questions: ReconciledWorksheetQuestion[] = [];
  const orderedPages = pages.map((page, inputOrder) => ({ page, inputOrder }))
    .sort((left, right) => (left.page.file_order ?? left.inputOrder) - (right.page.file_order ?? right.inputOrder) || left.page.page_number - right.page.page_number || left.inputOrder - right.inputOrder);
  let sourceOrder = 0;

  const attachFragment = (fragment: WorksheetPageFragment, page: ExtractedWorksheetPage): boolean => {
    const fragmentOptions = (fragment.options ?? []).map(textValue).filter(Boolean);
    const targetId = normalizeWorksheetSourceId(fragment.target_source_id);
    let candidates = questions.filter(question => question.options.length === 0);
    if (targetId) candidates = candidates.filter(question => question.source_id === targetId);
    else candidates = candidates.filter(question =>
      question.source.source_file === page.source_file
      && question.source.page_number === page.page_number - 1
      && ['multiple_choice', 'multiple_choice_multi'].includes(String(question.type ?? ''))
    );
    if (candidates.length !== 1) return false;
    const target = candidates[0];
    const index = questions.indexOf(target);
    if (fragment.kind === 'choices' && fragmentOptions.length >= 2 && new Set(fragmentOptions.map(normalizedOptionText)).size === fragmentOptions.length) {
      questions[index] = { ...target, options: fragmentOptions };
      return true;
    }
    if (fragment.kind === 'image' && fragment.crop_or_image_reference) {
      questions[index] = {
        ...target,
        source: { ...target.source, crop_or_image_reference: fragment.crop_or_image_reference }
      };
      return true;
    }
    return false;
  };

  for (const { page } of orderedPages) {
    const pageFragments: WorksheetPageFragment[] = [...(page.fragments ?? [])];
    for (const rawValue of page.questions) {
      if (!isRecord(rawValue)) continue;
      const text = readQuestionText(rawValue);
      const itemOptions = readOptions(rawValue);
      if (!text) {
        pageFragments.push({ kind: itemOptions.length ? 'choices' : 'text', options: itemOptions, target_source_id: getWorksheetSourceId(rawValue) || undefined });
        continue;
      }
      const sourceId = getWorksheetSourceId(rawValue);
      if (!sourceId) {
        diagnostics.push({ ...diagnostic('invalid_source_id', 'Extracted question has no source identifier.'), page_number: page.page_number, source_file: page.source_file });
        unresolved.push({ kind: 'text', text, page_number: page.page_number, source_file: page.source_file, reason: 'Missing stable source identifier.' });
        continue;
      }
      const imageReference = pageImageReference(rawValue);
      const source: WorksheetQuestionSource = {
        original_index: sourceId,
        ...(page.source_file ? { source_file: page.source_file } : {}),
        ...(Number.isInteger(page.page_number) && page.page_number > 0 ? { page_number: page.page_number } : {}),
        ...(imageReference ? { crop_or_image_reference: imageReference } : {})
      };
      if (questions.some(question => question.source_id === sourceId)) diagnostics.push(diagnostic('duplicate_source_id', `Extracted duplicate source ID "${sourceId}".`, sourceId));
      questions.push({ ...rawValue, source_id: sourceId, source_order: sourceOrder++, question: text, options: itemOptions, source });
    }
    for (const fragment of pageFragments) {
      if (!attachFragment(fragment, page)) {
        const reason = 'Fragment could not be attached to exactly one adjacent incomplete question.';
        unresolved.push({ ...fragment, page_number: page.page_number, source_file: page.source_file, reason });
        diagnostics.push({ ...diagnostic('unresolved_fragment', reason, normalizeWorksheetSourceId(fragment.target_source_id)), page_number: page.page_number, source_file: page.source_file });
      }
    }
  }

  const textOwners = new Map<string, string>();
  for (const question of questions) {
    const fingerprint = normalizedComparableText(question.question);
    const owner = textOwners.get(fingerprint);
    if (fingerprint && owner && owner !== question.source_id) diagnostics.push(diagnostic('duplicate_question_text', `Questions "${owner}" and "${question.source_id}" have duplicate normalized text.`, question.source_id));
    else if (fingerprint) textOwners.set(fingerprint, question.source_id);
  }
  return { questions, unresolved_fragments: unresolved, diagnostics };
}

function candidateRecord(base: Record<string, unknown>, output: unknown): Record<string, unknown> {
  if (!isRecord(output)) return { ...base };
  return {
    ...base,
    ...output,
    question: readQuestionText(base),
    source: base.source,
    original_index: base.original_index,
    source_id: getWorksheetSourceId(base)
  };
}

export function adjudicateWorksheetSolverCandidates(
  baseQuestion: unknown,
  candidates: readonly IndependentSolverCandidate[],
  adjudicator?: WorksheetAdjudicatorDecision
): WorksheetConsensusResult {
  const base = isRecord(baseQuestion) ? { ...baseQuestion } : {};
  const sourceId = getWorksheetSourceId(base);
  const diagnostics: WorksheetDiagnostic[] = [];
  const traces: WorksheetSolverTrace[] = [];
  const valid: Array<{ model: string; question: NormalizedWorksheetQuestion }> = [];
  for (const candidate of candidates) {
    if (candidate.status === 'failed') {
      traces.push({ model: candidate.model, status: 'failed', reason: candidate.error || 'Solver failed.' });
      diagnostics.push(diagnostic('solver_failure', `${candidate.model} failed to solve "${sourceId}".`, sourceId));
      continue;
    }
    const checked = validateWorksheetQuestion(candidateRecord(base, candidate.output));
    if (!checked.valid || !checked.question) {
      traces.push({ model: candidate.model, status: 'invalid', reason: checked.diagnostics.map(item => item.message).join(' ') });
      diagnostics.push(...checked.diagnostics);
      continue;
    }
    valid.push({ model: candidate.model, question: checked.question });
    traces.push({ model: candidate.model, status: 'fulfilled', answer: checked.question.answer });
  }

  const review = (reason: string, code: WorksheetDiagnosticCode): WorksheetConsensusResult => {
    diagnostics.push(diagnostic(code, reason, sourceId));
    const verification: QuestionVerification = { answer_source: 'manual', verification_status: 'review_required', reason, solver_models: candidates.map(candidate => candidate.model) };
    const provisional = valid[0]?.question ?? base;
    return { publishable: false, question: { ...provisional, verification, worksheet_qa: { solver_candidates: traces, adjudicator_reason: adjudicator?.reason } }, verification, worksheet_qa: { solver_candidates: traces, adjudicator_reason: adjudicator?.reason }, diagnostics };
  };

  if (candidates.length < 2 || valid.length !== candidates.length) {
    return review('Independent solver coverage is incomplete or invalid; teacher review is required.', 'solver_failure');
  }
  const first = valid[0];
  const allAgree = valid.slice(1).every(item => areCanonicalWorksheetAnswersEquivalent(first.question, first.question.answer, item.question.answer));
  let selected = allAgree ? first.question : undefined;
  if (!allAgree) {
    if (!adjudicator || adjudicator.status === 'failed') return review('Independent solvers disagree and no valid adjudication is available.', 'solver_disagreement');
    if (adjudicator.verified === true && adjudicator.accepted_model) selected = valid.find(item => item.model === adjudicator.accepted_model)?.question;
    else if (adjudicator.verified === false && adjudicator.corrected_answer !== undefined) {
      const corrected = candidateRecord(base, {
        answer: adjudicator.corrected_answer,
        solution: adjudicator.corrected_solution,
        type: adjudicator.corrected_type ?? base.type
      });
      selected = validateWorksheetQuestion(corrected).question;
    }
    if (!selected) return review('Checker did not provide a complete, valid correction for the solver disagreement.', 'invalid_checker_response');
  }
  const verification: QuestionVerification = {
    answer_source: 'solver_consensus',
    verification_status: 'verified',
    reason: allAgree ? 'Independent normalized solver answers agree.' : (adjudicator?.reason || 'A valid adjudicator resolved the disagreement.'),
    solver_models: candidates.map(candidate => candidate.model)
  };
  const qa: WorksheetQaMetadata = { solver_candidates: traces, adjudicator_reason: adjudicator?.reason };
  return { publishable: true, question: { ...selected, verification, worksheet_qa: qa }, verification, worksheet_qa: qa, diagnostics };
}

export function validateWorksheetQuizForPublication(
  inputQuestions: readonly unknown[],
  options: WorksheetQuizValidationOptions = {}
): WorksheetQuizValidationResult {
  const goldenApplied = options.golden_answers ? applyGoldenAnswers(inputQuestions, options.golden_answers) : {
    questions: inputQuestions.map(value => isRecord(value) ? { ...value } : {}),
    diagnostics: [] as WorksheetDiagnostic[]
  };
  const diagnostics = [...(options.prior_diagnostics ?? []), ...goldenApplied.diagnostics];
  const questions: NormalizedWorksheetQuestion[] = [];
  const seen = new Set<string>();
  for (const raw of goldenApplied.questions) {
    const checked = validateWorksheetQuestion(raw, { require_solution: options.require_solution });
    diagnostics.push(...checked.diagnostics);
    if (!checked.valid || !checked.question) continue;
    const question = checked.question;
    if (seen.has(question.id)) diagnostics.push(diagnostic('duplicate_source_id', `Quiz contains duplicate source ID "${question.id}".`, question.id));
    seen.add(question.id);
    const status = question.verification?.verification_status;
    if ((options.require_verification ?? true) && !status) diagnostics.push(diagnostic('unverified_question', `Question "${question.id}" has no verification record.`, question.id));
    if (status === 'review_required' && !options.allow_review_required) diagnostics.push(diagnostic('review_required', `Question "${question.id}" still requires teacher review.`, question.id));
    if (status === 'invalid' || status === 'unverified') diagnostics.push(diagnostic('unverified_question', `Question "${question.id}" is not verified.`, question.id));
    questions.push(question);
  }
  return { valid: questions.length === inputQuestions.length && !diagnostics.some(item => item.severity === 'error'), questions, diagnostics };
}

export function mergeWorksheetRecheckByStableId(
  originals: readonly unknown[],
  outputs: readonly unknown[]
): WorksheetRecheckMergeResult {
  const diagnostics: WorksheetDiagnostic[] = [];
  const summary: WorksheetRecheckSummary = { changed: [], unchanged: [], invalid: [], review_required: [], missing: [], unexpected: [] };
  const originalMap = new Map<string, Record<string, unknown>>();
  const outputMap = new Map<string, Record<string, unknown>>();
  for (const value of originals) {
    if (!isRecord(value)) continue;
    const id = getWorksheetSourceId(value);
    if (!id || originalMap.has(id)) diagnostics.push(diagnostic(id ? 'duplicate_source_id' : 'invalid_source_id', id ? `Duplicate original ID "${id}".` : 'Original question has no stable ID.', id));
    else originalMap.set(id, value);
  }
  for (const value of outputs) {
    if (!isRecord(value)) continue;
    const id = getWorksheetSourceId(value);
    if (!id || outputMap.has(id)) diagnostics.push(diagnostic(id ? 'duplicate_source_id' : 'invalid_source_id', id ? `Duplicate recheck ID "${id}".` : 'Recheck output has no stable ID.', id));
    else outputMap.set(id, value);
  }
  for (const id of originalMap.keys()) if (!outputMap.has(id)) {
    summary.missing.push(id);
    diagnostics.push(diagnostic('missing_recheck_output', `Recheck omitted "${id}".`, id));
  }
  for (const id of outputMap.keys()) if (!originalMap.has(id)) {
    summary.unexpected.push(id);
    diagnostics.push(diagnostic('unexpected_recheck_output', `Recheck returned unexpected "${id}".`, id));
  }
  if (diagnostics.some(item => item.severity === 'error')) return { success: false, questions: originals.map(value => isRecord(value) ? { ...value } : {}), diagnostics, summary };

  const merged: Record<string, unknown>[] = [];
  for (const [id, original] of originalMap) {
    const output = outputMap.get(id)!;
    if (!Object.prototype.hasOwnProperty.call(output, 'answer') || !hasAnswerValue(output.answer)) {
      summary.invalid.push(id);
      diagnostics.push(diagnostic('invalid_recheck_output', `Recheck output for "${id}" omitted its answer.`, id));
      merged.push({ ...original });
      continue;
    }
    const candidate = candidateRecord(original, output);
    const checked = validateWorksheetQuestion(candidate);
    if (!checked.valid || !checked.question) {
      summary.invalid.push(id);
      diagnostics.push(diagnostic('invalid_recheck_output', `Recheck output for "${id}" is invalid.`, id));
      diagnostics.push(...checked.diagnostics);
      merged.push({ ...original });
      continue;
    }
    if (checked.question.verification?.verification_status === 'review_required') summary.review_required.push(id);
    if (areCanonicalWorksheetAnswersEquivalent(original, getCorrectAnswer(original), checked.question.answer)) summary.unchanged.push(id);
    else summary.changed.push(id);
    merged.push(checked.question);
  }
  return { success: !diagnostics.some(item => item.severity === 'error') && summary.review_required.length === 0, questions: merged, diagnostics, summary };
}

export function stripWorksheetSolverState(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const clean: Record<string, unknown> = {};
  for (const key of ['id', 'source_id', 'original_index', 'question', 'raw_text', 'statement', 'options', 'choices', 'type', 'bounding_box', 'crop_data_url', 'image_url']) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const fieldValue = value[key];
    clean[key] = typeof fieldValue === 'string'
      ? fieldValue.replace(/data:[^;,"']+;base64,[^"']+/gi, '[IMAGE_PROVIDED_IN_VISION_CONTEXT]')
      : fieldValue;
  }
  const source = sourceFromQuestion(value);
  if (source) clean.source = source;
  return clean;
}

export function buildWorksheetSolverPrompt(input: {
  questions: readonly unknown[];
  subject?: string;
  topic?: string;
  non_math?: boolean;
}): string {
  const cleanQuestions = input.questions.map((question, sourceIndex) => ({
    ...stripWorksheetSolverState(question),
    source_id: getWorksheetSourceId(question),
    source_index: sourceIndex
  }));
  const template = input.non_math ? WORKSHEET_SOLVER_PROMPT_NON_MATH : WORKSHEET_SOLVER_PROMPT;
  return template
    .replace('{subject}', textValue(input.subject) || 'General')
    .replace('{topic}', textValue(input.topic) || 'Worksheet')
    .replace('{questions_json}', JSON.stringify(cleanQuestions))
    .replace('{latex_rules}', input.non_math ? NON_MATH_RULES : SHARED_LATEX_RULES);
}
