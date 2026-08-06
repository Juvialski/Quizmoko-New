import { createHash } from 'node:crypto';
import { normalizeAiLatexText, validateLatexText } from './latex.ts';

export interface LatexPatchRequest {
  id: string;
  field: string;
  original_hash: string;
  original: string;
}

export interface LatexPatch {
  id: string;
  field: string;
  original_hash: string;
  replacement: string;
}

export interface LatexPatchResult {
  questions: any[];
  applied: number;
  rejected: Array<{ id: string; field: string; reason: string }>;
}

export function latexFieldHash(value: unknown): string {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex').slice(0, 24);
}

function questionId(question: any, index: number): string {
  return String(question?.id || question?.source?.original_index || question?.original_index || `question_${index + 1}`);
}

export function createLatexPatchRequests(questions: any[]): LatexPatchRequest[] {
  const requests: LatexPatchRequest[] = [];
  questions.forEach((question, index) => {
    const id = questionId(question, index);
    const add = (field: string, value: unknown) => {
      if (typeof value !== 'string' || !value.trim()) return;
      requests.push({ id, field, original_hash: latexFieldHash(value), original: value });
    };
    add('question', question?.question);
    if (typeof question?.raw_text === 'string' && question.raw_text !== question.question) add('raw_text', question.raw_text);
    add('solution', question?.solution);
    if (String(question?.type || '').toLowerCase() !== 'identification') add('answer', question?.answer);
    if (Array.isArray(question?.options)) {
      question.options.forEach((option: unknown, optionIndex: number) => add(`options[${optionIndex}]`, option));
    }
  });
  return requests;
}

function htmlTags(value: string): string[] {
  return value.match(/<[^>]+>/g) || [];
}

function canonicalFormattingSignature(value: string): string {
  let text = String(value)
    .replace(/\r\n?/g, '\n')
    .replace(/<[^>]+>/g, match => `HTML${createHash('sha1').update(match).digest('hex').slice(0, 8)}`)
    .replace(/\$\$/g, '')
    .replace(/\$/g, '')
    .replace(/\\left|\\right/g, '')
    .replace(/\\text\{([^{}]*)\}/g, '$1')
    .replace(/\\(?:mathrm|mathbf|operatorname)\{([^{}]*)\}/g, '$1')
    .replace(/\\times|\\cdot|×/g, '*')
    .replace(/\\div|÷/g, '/')
    .replace(/\\%/g, '%')
    .replace(/\\\$/g, '$')
    .replace(/\\[,;:! ]/g, '');

  // Normalize fractions without erasing meaningful grouping. Simple atoms are
  // reduced directly; compound numerators/denominators keep parentheses.
  for (let pass = 0; pass < 4; pass += 1) {
    text = text.replace(/\\(?:d?frac)\{([^{}]*)\}\{([^{}]*)\}/g, (_match, numerator: string, denominator: string) => {
      const atom = /^[A-Za-z0-9.+-]+$/;
      const left = atom.test(numerator) ? numerator : `(${numerator})`;
      const right = atom.test(denominator) ? denominator : `(${denominator})`;
      return `${left}/${right}`;
    });
  }

  return text
    .replace(/[{}]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

export function isSafeLatexReplacement(original: string, replacement: string): boolean {
  if (htmlTags(original).join('\n') !== htmlTags(replacement).join('\n')) return false;
  return canonicalFormattingSignature(original) === canonicalFormattingSignature(replacement);
}

function setField(question: any, field: string, replacement: string): boolean {
  if (field === 'question' || field === 'raw_text' || field === 'solution' || field === 'answer') {
    question[field] = replacement;
    return true;
  }
  const optionMatch = field.match(/^options\[(\d+)\]$/);
  if (optionMatch && Array.isArray(question.options)) {
    const index = Number(optionMatch[1]);
    if (Number.isInteger(index) && index >= 0 && index < question.options.length) {
      question.options[index] = replacement;
      return true;
    }
  }
  return false;
}

function getField(question: any, field: string): unknown {
  if (field === 'question' || field === 'raw_text' || field === 'solution' || field === 'answer') return question?.[field];
  const optionMatch = field.match(/^options\[(\d+)\]$/);
  if (optionMatch && Array.isArray(question?.options)) return question.options[Number(optionMatch[1])];
  return undefined;
}

export function applyLatexPatches(questions: any[], patches: LatexPatch[]): LatexPatchResult {
  const cloned = questions.map(question => ({
    ...question,
    options: Array.isArray(question?.options) ? [...question.options] : question?.options
  }));
  const byId = new Map(cloned.map((question, index) => [questionId(question, index), question]));
  const seen = new Set<string>();
  const rejected: LatexPatchResult['rejected'] = [];
  let applied = 0;

  for (const patch of patches) {
    const id = String(patch?.id || '');
    const field = String(patch?.field || '');
    const key = `${id}:${field}`;
    const question = byId.get(id);
    if (!question || seen.has(key)) {
      rejected.push({ id, field, reason: 'Unexpected question, field, or duplicate patch.' });
      continue;
    }
    seen.add(key);
    const originalValue = getField(question, field);
    if (typeof originalValue !== 'string') {
      rejected.push({ id, field, reason: 'The target field is not a string.' });
      continue;
    }
    if (latexFieldHash(originalValue) !== String(patch.original_hash || '')) {
      rejected.push({ id, field, reason: 'The original field hash does not match.' });
      continue;
    }
    const replacement = normalizeAiLatexText(patch.replacement ?? '');
    if (!replacement.trim()) {
      rejected.push({ id, field, reason: 'The replacement is empty.' });
      continue;
    }
    if (!isSafeLatexReplacement(originalValue, replacement)) {
      rejected.push({ id, field, reason: 'The patch changes content, values, or HTML rather than formatting only.' });
      continue;
    }
    const issues = validateLatexText(replacement);
    if (issues.length > 0) {
      rejected.push({ id, field, reason: issues[0].message });
      continue;
    }
    if (!setField(question, field, replacement)) {
      rejected.push({ id, field, reason: 'The target field is unsupported.' });
      continue;
    }
    applied += 1;
  }

  return { questions: cloned, applied, rejected };
}
