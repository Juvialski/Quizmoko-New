import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';
import { getCorrectAnswer, getQuestionOptions } from './grading.ts';

const PROOF_VERSION = 1;
const PROOF_TTL_MS = 36 * 60 * 60 * 1000;
let generatedSecret: Buffer | null = null;
let warnedAboutGeneratedSecret = false;

interface GradeProofPayload {
  v: number;
  quiz_id: string;
  q_index: number;
  answer_digest: string;
  question_digest: string;
  is_correct: boolean;
  score_fraction: number;
  exp: number;
}

function proofSecret(): Buffer {
  if (process.env.SESSION_SECRET) return Buffer.from(process.env.SESSION_SECRET, 'utf8');
  if (!generatedSecret) generatedSecret = randomBytes(32);
  if (!warnedAboutGeneratedSecret) {
    console.warn('[Grading] SESSION_SECRET is unset; outstanding grade proofs will expire on restart.');
    warnedAboutGeneratedSecret = true;
  }
  return generatedSecret;
}

function stableValue(value: any, depth = 0): any {
  if (depth > 20) return '[MAX_DEPTH]';
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(item => stableValue(item, depth + 1));
  if (typeof value === 'object') {
    const normalized: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = stableValue(value[key], depth + 1);
    }
    return normalized;
  }
  return String(value);
}

function digest(value: any): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('base64url');
}

function questionFingerprint(question: any): string {
  return digest({
    question: question?.question ?? question?.prompt ?? question?.text ?? '',
    type: question?.type ?? question?.question_type ?? question?.questionType ?? '',
    options: getQuestionOptions(question),
    correct_answer: getCorrectAnswer(question)
  });
}

function sign(encodedPayload: string): string {
  return createHmac('sha256', proofSecret())
    .update('quizmoko-grade-proof-v1\0')
    .update(encodedPayload)
    .digest('base64url');
}

function signaturesMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function createGradeProof(input: {
  quizId: string;
  questionIndex: number;
  question: any;
  studentAnswer: any;
  isCorrect: boolean;
  scoreFraction: number;
}): string {
  const payload: GradeProofPayload = {
    v: PROOF_VERSION,
    quiz_id: input.quizId,
    q_index: input.questionIndex,
    answer_digest: digest(input.studentAnswer),
    question_digest: questionFingerprint(input.question),
    is_correct: Boolean(input.isCorrect),
    score_fraction: Math.max(0, Math.min(1, Number(input.scoreFraction) || 0)),
    exp: Date.now() + PROOF_TTL_MS
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `qmg1.${encoded}.${sign(encoded)}`;
}

export function verifyGradeProof(
  token: any,
  expected: {
    quizId: string;
    questionIndex: number;
    question: any;
    studentAnswer: any;
  }
): { isCorrect: boolean; scoreFraction: number } | null {
  if (typeof token !== 'string' || token.length > 4_096) return null;
  const parts = token.split('.');
  if (
    parts.length !== 3
    || parts[0] !== 'qmg1'
    || !signaturesMatch(parts[2], sign(parts[1]))
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as GradeProofPayload;
    if (
      payload.v !== PROOF_VERSION
      || payload.quiz_id !== expected.quizId
      || payload.q_index !== expected.questionIndex
      || payload.answer_digest !== digest(expected.studentAnswer)
      || payload.question_digest !== questionFingerprint(expected.question)
      || typeof payload.is_correct !== 'boolean'
      || !Number.isFinite(payload.score_fraction)
      || payload.score_fraction < 0
      || payload.score_fraction > 1
      || !Number.isFinite(payload.exp)
      || payload.exp <= Date.now()
      || payload.exp > Date.now() + PROOF_TTL_MS + 60_000
    ) {
      return null;
    }
    return {
      isCorrect: payload.is_correct,
      scoreFraction: payload.score_fraction
    };
  } catch {
    return null;
  }
}
