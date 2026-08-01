import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';
import type { AnswerAttemptIdentity, GradeStatus } from '../types.ts';
import { normalizeGradeScore, normalizeQuestion } from './grading.ts';

const PROOF_VERSION = 2;
const PROOF_TTL_MS = 36 * 60 * 60 * 1000;
const MAX_PROOF_LENGTH = 8_192;
const MAX_PROOF_FEEDBACK_LENGTH = 2_000;
const MAX_SNAPSHOT_COUNT = 5;
const MAX_SNAPSHOT_CHARS = 10 * 1024 * 1024;
let generatedSecret: Buffer | null = null;
let warnedAboutGeneratedSecret = false;

interface GradeProofPayloadV2 {
  v: 2;
  quiz_id: string;
  session_id: string;
  question_index: number;
  answer_revision: number;
  answer_digest: string;
  snapshot_digest: string;
  question_digest: string;
  grade_status: 'graded';
  score_fraction: number;
  is_correct: boolean;
  feedback: string;
  iat: number;
  exp: number;
}

export interface CreateGradeProofInput {
  quizId: string;
  /** Required by proof v2; optional only for source compatibility during migration. */
  sessionId?: string;
  questionIndex: number;
  answerRevision?: number;
  question: unknown;
  studentAnswer: unknown;
  solutionSnapshots?: unknown;
  snapshotDigest?: string;
  gradeStatus?: GradeStatus;
  scoreFraction: number;
  /** Ignored as an authority; correctness is derived from normalized score. */
  isCorrect?: boolean;
  feedback?: string;
  issuedAt?: number;
  expiresAt?: number;
}

export interface ExpectedGradeProofIdentity {
  quizId: string;
  sessionId?: string;
  questionIndex: number;
  answerRevision?: number;
  question: unknown;
  studentAnswer: unknown;
  solutionSnapshots?: unknown;
  snapshotDigest?: string;
}

export interface VerifiedGradeProof extends AnswerAttemptIdentity {
  gradeStatus: 'graded';
  isCorrect: boolean;
  scoreFraction: number;
  feedback: string;
  questionDigest: string;
  issuedAt: number;
  expiresAt: number;
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

export function stableDigestValue(value: unknown, depth = 0): unknown {
  if (depth > 20) return '[MAX_DEPTH]';
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(item => stableDigestValue(item, depth + 1));
  if (typeof value === 'object') {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      normalized[key] = stableDigestValue((value as Record<string, unknown>)[key], depth + 1);
    }
    return normalized;
  }
  return String(value);
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableDigestValue(value));
}

export function stableDigest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('base64url');
}

export function createAnswerDigest(studentAnswer: unknown): string {
  return stableDigest(studentAnswer);
}

export function sanitizeSnapshotsForDigest(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const snapshots: string[] = [];
  let aggregateChars = 0;
  for (const snapshot of value.slice(0, MAX_SNAPSHOT_COUNT)) {
    if (
      typeof snapshot !== 'string'
      || !/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(snapshot)
      || aggregateChars + snapshot.length > MAX_SNAPSHOT_CHARS
    ) {
      continue;
    }
    snapshots.push(snapshot);
    aggregateChars += snapshot.length;
  }
  return snapshots;
}

export function createSnapshotDigest(solutionSnapshots: unknown): string {
  return stableDigest(sanitizeSnapshotsForDigest(solutionSnapshots));
}

export function createQuestionDigest(question: unknown): string {
  const normalized = normalizeQuestion(question);
  if (normalized.valid) {
    const canonical = normalized.question;
    return stableDigest({
      id: canonical.id,
      type: canonical.type,
      question: canonical.question,
      options: canonical.options,
      answer: canonical.answer,
      points: canonical.points,
      grading_mode: canonical.grading_mode ?? null,
      solution: canonical.solution ?? '',
      answer_policy: canonical.answer_policy ?? null
    });
  }
  // Invalid questions cannot produce an authoritative grade, but a stable digest
  // remains useful for diagnostics and explicit invalid-response identities.
  return stableDigest(question);
}

function sign(encodedPayload: string): string {
  return createHmac('sha256', proofSecret())
    .update('quizmoko-grade-proof-v2\0')
    .update(encodedPayload)
    .digest('base64url');
}

function signaturesMatch(actual: string, expected: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(actual)) return false;
  const actualBuffer = Buffer.from(actual, 'ascii');
  const expectedBuffer = Buffer.from(expected, 'ascii');
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function validIdentityPart(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && /^[A-Za-z0-9_-]+$/.test(value);
}

function resolvedSnapshotDigest(input: { solutionSnapshots?: unknown; snapshotDigest?: string }): string {
  if (input.solutionSnapshots !== undefined) return createSnapshotDigest(input.solutionSnapshots);
  return typeof input.snapshotDigest === 'string' && /^[A-Za-z0-9_-]{43}$/.test(input.snapshotDigest)
    ? input.snapshotDigest
    : createSnapshotDigest([]);
}

function truncateUtf8(value: string, maximumBytes: number): string {
  let output = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maximumBytes) break;
    output += character;
    bytes += size;
  }
  return output;
}

export function createGradeProof(input: CreateGradeProofInput): string {
  if ((input.gradeStatus ?? 'graded') !== 'graded') {
    throw new Error('Only authoritative graded results may receive a grade proof.');
  }
  if (!validIdentityPart(input.quizId) || !validIdentityPart(input.sessionId)) {
    throw new Error('Invalid grade proof quiz/session identity.');
  }
  if (!Number.isInteger(input.questionIndex) || input.questionIndex < 0) {
    throw new Error('Invalid grade proof question index.');
  }
  const answerRevision = input.answerRevision ?? 0;
  if (!Number.isInteger(answerRevision) || answerRevision < 0) {
    throw new Error('Invalid grade proof answer revision.');
  }
  const scoreFraction = normalizeGradeScore(input.scoreFraction);
  if (scoreFraction === null) throw new Error('Grade proof score must be finite.');
  const questionValidation = normalizeQuestion(input.question);
  if (!questionValidation.valid) throw new Error('Cannot sign a grade for an invalid question.');

  const issuedAt = input.issuedAt ?? Date.now();
  const expiresAt = input.expiresAt ?? issuedAt + PROOF_TTL_MS;
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt || expiresAt > issuedAt + PROOF_TTL_MS) {
    throw new Error('Invalid grade proof lifetime.');
  }
  const feedback = typeof input.feedback === 'string'
    ? truncateUtf8(input.feedback, MAX_PROOF_FEEDBACK_LENGTH)
    : '';
  const payload: GradeProofPayloadV2 = {
    v: PROOF_VERSION,
    quiz_id: input.quizId,
    session_id: input.sessionId ?? '',
    question_index: input.questionIndex,
    answer_revision: answerRevision,
    answer_digest: createAnswerDigest(input.studentAnswer),
    snapshot_digest: resolvedSnapshotDigest(input),
    question_digest: createQuestionDigest(input.question),
    grade_status: 'graded',
    score_fraction: scoreFraction,
    is_correct: scoreFraction === 1,
    feedback,
    iat: issuedAt,
    exp: expiresAt
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `qmg2.${encoded}.${sign(encoded)}`;
}

export function verifyGradeProof(
  token: unknown,
  expected: ExpectedGradeProofIdentity
): VerifiedGradeProof | null {
  if (typeof token !== 'string' || token.length > MAX_PROOF_LENGTH) return null;
  const parts = token.split('.');
  if (
    parts.length !== 3
    || parts[0] !== 'qmg2'
    || !/^[A-Za-z0-9_-]+$/.test(parts[1])
    || !signaturesMatch(parts[2], sign(parts[1]))
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Partial<GradeProofPayloadV2>;
    const now = Date.now();
    const expectedRevision = expected.answerRevision ?? 0;
    const expectedSessionId = expected.sessionId ?? '';
    const expectedSnapshotDigest = resolvedSnapshotDigest(expected);
    const normalizedScore = normalizeGradeScore(payload.score_fraction);
    const issuedAt = payload.iat;
    const expiresAt = payload.exp;
    if (
      payload.v !== PROOF_VERSION
      || payload.quiz_id !== expected.quizId
      || payload.session_id !== expectedSessionId
      || payload.question_index !== expected.questionIndex
      || payload.answer_revision !== expectedRevision
      || payload.answer_digest !== createAnswerDigest(expected.studentAnswer)
      || payload.snapshot_digest !== expectedSnapshotDigest
      || payload.question_digest !== createQuestionDigest(expected.question)
      || payload.grade_status !== 'graded'
      || normalizedScore === null
      || payload.score_fraction !== normalizedScore
      || payload.is_correct !== (normalizedScore === 1)
      || typeof payload.feedback !== 'string'
      || Buffer.byteLength(payload.feedback, 'utf8') > MAX_PROOF_FEEDBACK_LENGTH
      || typeof issuedAt !== 'number'
      || !Number.isFinite(issuedAt)
      || typeof expiresAt !== 'number'
      || !Number.isFinite(expiresAt)
      || issuedAt > now + 60_000
      || expiresAt <= now
      || expiresAt <= issuedAt
      || expiresAt > issuedAt + PROOF_TTL_MS
    ) {
      return null;
    }
    return {
      quiz_id: payload.quiz_id,
      session_id: payload.session_id,
      question_index: payload.question_index,
      answer_revision: payload.answer_revision,
      answer_digest: payload.answer_digest,
      snapshot_digest: payload.snapshot_digest,
      gradeStatus: 'graded',
      isCorrect: normalizedScore === 1,
      scoreFraction: normalizedScore,
      feedback: payload.feedback,
      questionDigest: payload.question_digest,
      issuedAt,
      expiresAt
    };
  } catch {
    return null;
  }
}
