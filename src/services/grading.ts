export interface LocalGradeResult {
  isCorrect: boolean;
  scoreFraction: number;
  questionType: string;
  correctAnswer: any;
  requiresSemanticGrading: boolean;
}

const TYPE_ALIASES: Record<string, string> = {
  'multiple choice': 'multiple_choice',
  'multiple choices': 'multiple_choice',
  'multiple select': 'multiple_choice_multi',
  'multiple choice multi': 'multiple_choice_multi',
  'multi select': 'multiple_choice_multi',
  'true false': 'true_false',
  'true or false': 'true_false',
  'open': 'open_ended',
  'open ended': 'open_ended',
  'open response': 'open_ended',
  'free response': 'open_ended',
  'free text': 'open_ended'
};

function answerToString(value: any): string {
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

export function getQuestionOptions(question: any): any[] {
  const raw = question?.options ?? question?.choices ?? question?.answers;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return Object.values(raw);
  return [];
}

export function getCorrectAnswer(question: any): any {
  if (!question || typeof question !== 'object') return '';
  const keys = ['answer', 'correct_answer', 'correctAnswer', 'correct_answer_letter'];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(question, key) && question[key] !== null && question[key] !== undefined) {
      return question[key];
    }
  }
  return '';
}

export function canonicalQuestionType(question: any): string {
  const rawType = answerToString(question?.type ?? question?.question_type ?? question?.questionType)
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

  if (TYPE_ALIASES[rawType]) return TYPE_ALIASES[rawType];
  if (rawType === 'multiple choice multi') return 'multiple_choice_multi';
  if (rawType === 'multiple choice') return 'multiple_choice';
  if (rawType === 'true false') return 'true_false';
  if (rawType === 'open ended') return 'open_ended';
  if (rawType === 'identification' || rawType === 'graphing') return rawType;

  return getQuestionOptions(question).length > 0 ? 'multiple_choice' : 'identification';
}

export function stripLatex(value: any): string {
  return answerToString(value)
    .replace(/\$/g, '')
    .replace(/\\(?:dfrac|frac)\{([^{}]+)\}\{([^{}]+)\}/g, '$1/$2')
    .replace(/\\text\{([^{}]+)\}/g, '$1')
    .replace(/\\(?:left|right)/g, '')
    .replace(/\\times/g, '*')
    .replace(/\\div/g, '/')
    .replace(/[{}]/g, '')
    .trim();
}

function explicitChoiceLetter(value: any): string | null {
  const match = answerToString(value).match(/^\s*(?:option\s*)?([A-Z])(?:\s*[\)\].:\-]\s*|\s*$)/i);
  return match ? match[1].toUpperCase() : null;
}

function stripExplicitChoiceLabel(value: any): string {
  return answerToString(value).replace(/^\s*(?:option\s*)?[A-Z](?:\s*[\)\].:\-]\s*|\s*$)/i, '').trim();
}

function normalizeText(value: any): string {
  return stripLatex(stripExplicitChoiceLabel(value))
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\u201c|\u201d/g, '"')
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function optionForLetter(question: any, letter: string | null): any {
  if (!letter) return undefined;
  const index = letter.charCodeAt(0) - 65;
  const options = getQuestionOptions(question);
  return index >= 0 && index < options.length ? options[index] : undefined;
}

function gradeMultipleChoice(question: any, expected: any, actual: any): boolean {
  const expectedLetter = explicitChoiceLetter(expected);
  const actualLetter = explicitChoiceLetter(actual);

  // Choice letters are authoritative only when both values explicitly provide one.
  if (expectedLetter && actualLetter) return expectedLetter === actualLetter;

  const expectedOption = optionForLetter(question, expectedLetter);
  const actualOption = optionForLetter(question, actualLetter);
  const expectedText = normalizeText(expectedOption !== undefined ? expectedOption : expected);
  const actualText = normalizeText(actualOption !== undefined ? actualOption : actual);

  return expectedText.length > 0 && expectedText === actualText;
}

function normalizeTrueFalse(question: any, value: any): string {
  const letter = explicitChoiceLetter(value);
  const option = optionForLetter(question, letter);
  let normalized = normalizeText(option !== undefined ? option : value);

  if (option === undefined && letter === 'A') normalized = 'true';
  if (option === undefined && letter === 'B') normalized = 'false';
  if (['t', 'yes', 'correct'].includes(normalized)) normalized = 'true';
  if (['f', 'no', 'incorrect'].includes(normalized)) normalized = 'false';
  return normalized;
}

function numericValue(value: any): number | null {
  const normalized = stripLatex(value).replace(/,/g, '').trim();
  const fraction = normalized.match(/^([-+]?(?:\d+(?:\.\d+)?|\.\d+))\s*\/\s*([-+]?(?:\d+(?:\.\d+)?|\.\d+))$/);
  if (fraction) {
    const denominator = Number(fraction[2]);
    if (denominator === 0) return null;
    return Number(fraction[1]) / denominator;
  }

  if (/^[-+]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) {
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function gradeIdentification(expected: any, actual: any): boolean {
  const expectedText = normalizeText(expected).replace(/[^a-z0-9.<>=+\-/]/gi, '');
  const actualText = normalizeText(actual).replace(/[^a-z0-9.<>=+\-/]/gi, '');
  if (expectedText.length > 0 && expectedText === actualText) return true;

  const expectedNumber = numericValue(expected);
  const actualNumber = numericValue(actual);
  if (expectedNumber === null || actualNumber === null) return false;
  return Math.abs(expectedNumber - actualNumber) <= Math.max(1, Math.abs(expectedNumber)) * 1e-10;
}

function choiceLetterSet(value: any): Set<string> {
  const values = Array.isArray(value) ? value : answerToString(value).split(/[,;|\s]+/);
  const letters = new Set<string>();
  for (const item of values) {
    const raw = answerToString(item).trim();
    const letter = explicitChoiceLetter(raw) || (/^[A-Z]$/i.test(raw) ? raw.toUpperCase() : null);
    if (letter) letters.add(letter);
  }
  return letters;
}

function gradeMultipleChoiceMulti(expected: any, actual: any): { isCorrect: boolean; scoreFraction: number } {
  const expectedSet = choiceLetterSet(expected);
  const actualSet = choiceLetterSet(actual);

  if (expectedSet.size === 0) {
    const exact = normalizeText(expected);
    const submitted = normalizeText(actual);
    const isCorrect = exact.length > 0 && exact === submitted;
    return { isCorrect, scoreFraction: isCorrect ? 1 : 0 };
  }

  let correctHits = 0;
  let wrongHits = 0;
  for (const letter of actualSet) {
    if (expectedSet.has(letter)) correctHits += 1;
    else wrongHits += 1;
  }

  const scoreFraction = Math.max(0, Math.min(1, (correctHits - wrongHits * 0.5) / expectedSet.size));
  return {
    isCorrect: actualSet.size === expectedSet.size && scoreFraction === 1,
    scoreFraction
  };
}

export function gradeQuestionLocally(question: any, studentAnswer: any): LocalGradeResult {
  const questionType = canonicalQuestionType(question);
  const correctAnswer = getCorrectAnswer(question);
  const hasExpectedAnswer = correctAnswer !== null
    && correctAnswer !== undefined
    && answerToString(correctAnswer).trim().length > 0;
  const hasStudentAnswer = studentAnswer !== null
    && studentAnswer !== undefined
    && answerToString(studentAnswer).trim().length > 0
    && answerToString(studentAnswer).trim().toLowerCase() !== 'no answer';

  if (!hasExpectedAnswer || !hasStudentAnswer) {
    return {
      isCorrect: false,
      scoreFraction: 0,
      questionType,
      correctAnswer,
      requiresSemanticGrading: false
    };
  }

  if (questionType === 'multiple_choice') {
    const isCorrect = gradeMultipleChoice(question, correctAnswer, studentAnswer);
    return { isCorrect, scoreFraction: isCorrect ? 1 : 0, questionType, correctAnswer, requiresSemanticGrading: false };
  }

  if (questionType === 'multiple_choice_multi') {
    const grade = gradeMultipleChoiceMulti(correctAnswer, studentAnswer);
    return { ...grade, questionType, correctAnswer, requiresSemanticGrading: false };
  }

  if (questionType === 'true_false') {
    const expected = normalizeTrueFalse(question, correctAnswer);
    const actual = normalizeTrueFalse(question, studentAnswer);
    const isCorrect = expected.length > 0 && expected === actual;
    return { isCorrect, scoreFraction: isCorrect ? 1 : 0, questionType, correctAnswer, requiresSemanticGrading: false };
  }

  if (questionType === 'identification') {
    const isCorrect = gradeIdentification(correctAnswer, studentAnswer);
    return { isCorrect, scoreFraction: isCorrect ? 1 : 0, questionType, correctAnswer, requiresSemanticGrading: false };
  }

  const expected = normalizeText(correctAnswer);
  const actual = normalizeText(studentAnswer);
  const isCorrect = expected.length > 0 && expected === actual;
  return {
    isCorrect,
    scoreFraction: isCorrect ? 1 : 0,
    questionType,
    correctAnswer,
    requiresSemanticGrading: !isCorrect
  };
}
