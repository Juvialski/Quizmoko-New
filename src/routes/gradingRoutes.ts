import { Router } from 'express';
import { Type } from '@google/genai';
import { optionalAuth } from '../middleware/auth.ts';
import type { AuthRequest } from '../middleware/auth.ts';
import type { GradeStatus, GradedDetail, QuizResult } from '../types.ts';
import {
  quizzes,
  results,
  savePersistentData,
  syncDocToFirestore
} from '../store/db.ts';
import { getRealModelName, safeParseJSON } from '../services/gemini.ts';
import { getQuizCreatorGeminiClients } from '../services/quizCreatorAi.ts';
import { hasBalancedLatexDelimiters, normalizeAiLatexText } from '../services/latex.ts';
import {
  canonicalQuestionType,
  getCorrectAnswer,
  gradeQuestionLocally,
  isSemanticQuestion,
  normalizeGradeScore,
  normalizeQuestion,
  sanitizeStudentAnswer,
  scoreQuizDetails
} from '../services/grading.ts';
import {
  createAnswerDigest,
  createGradeProof,
  createQuestionDigest,
  createSnapshotDigest,
  sanitizeSnapshotsForDigest,
  verifyGradeProof
} from '../services/gradeProof.ts';
import { gradeSemanticQuestion, type SemanticGradeOutcome } from '../services/semanticGrading.ts';
import {
  clearAttemptRevisionState,
  getCurrentAnswerRevision,
  inspectAnswerRevision,
  isLatestAnswerRevision,
  observeAnswerRevision,
  withAttemptLock
} from '../services/resultSession.ts';
import {
  createResultAccessTokenForSession,
  resultAccessCookieName
} from '../services/resultAccess.ts';

const router = Router();
const MAX_STUDENT_NAME_LENGTH = 120;
const MAX_FEEDBACK_LENGTH = 10_000;
const MAX_RECORDED_DURATION_SECONDS = 7 * 24 * 60 * 60;
const MAX_PERSISTED_SNAPSHOT_CHARS = 10 * 1024 * 1024;
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();
const semanticAiBuckets = new Map<string, { count: number; resetAt: number }>();
let semanticAiInFlight = 0;
const MAX_SEMANTIC_AI_IN_FLIGHT = 32;
const MAX_SEMANTIC_AI_ATTEMPTS_PER_IP = 1_200;
const SEMANTIC_AI_WINDOW_MS = 10 * 60 * 1_000;

function publicRateLimit(prefix: string, maxRequests: number, windowMs: number) {
  return (req: any, res: any, next: any) => {
    const now = Date.now();
    const client = String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 200);
    const key = `${prefix}:${client}`;
    let bucket = rateLimitBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      rateLimitBuckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > maxRequests) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000))));
      return res.status(429).json({ success: false, error: 'Too many requests. Please wait before trying again.' });
    }
    if (rateLimitBuckets.size > 10_000) {
      for (const [bucketKey, value] of rateLimitBuckets) {
        if (value.resetAt <= now) rateLimitBuckets.delete(bucketKey);
      }
    }
    next();
  };
}

async function acquireSemanticAiSlot(req: any): Promise<{ release(): void } | null> {
  const client = String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 200);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const now = Date.now();
    let bucket = semanticAiBuckets.get(client);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + SEMANTIC_AI_WINDOW_MS };
      semanticAiBuckets.set(client, bucket);
    }
    if (bucket.count >= MAX_SEMANTIC_AI_ATTEMPTS_PER_IP) return null;
    if (semanticAiInFlight < MAX_SEMANTIC_AI_IN_FLIGHT) {
      bucket.count += 1;
      semanticAiInFlight += 1;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          semanticAiInFlight = Math.max(0, semanticAiInFlight - 1);
        }
      };
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return null;
}

function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, finiteNumber(value, fallback)));
}

function validRecordId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
}

function parsedRevision(value: unknown, fallback = 0): number | null {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function sanitizeStudentName(value: unknown): string {
  const normalized = String(value ?? '').trim().slice(0, MAX_STUDENT_NAME_LENGTH);
  return normalized && normalized !== 'undefined' ? normalized : 'Anonymous';
}

function sanitizeFeedback(value: unknown): string {
  return typeof value === 'string'
    ? value.slice(0, MAX_FEEDBACK_LENGTH).replace(/[<>]/g, '')
    : '';
}

function hasOwn(record: unknown, key: string | number): boolean {
  return Boolean(record && typeof record === 'object' && Object.prototype.hasOwnProperty.call(record, key));
}

function valueAt(record: unknown, index: number): unknown {
  if (!record || typeof record !== 'object') return undefined;
  return (record as Record<string, unknown>)[String(index)];
}

function sanitizeSolutionSnapshots(
  value: unknown,
  questionCount: number
): { snapshots: Record<string, string[]>; errors: string[] } {
  if (value === undefined || value === null) return { snapshots: {}, errors: [] };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { snapshots: {}, errors: ['solution_snapshots must be an object keyed by question index.'] };
  }
  const source = value as Record<string, unknown>;
  const sanitized: Record<string, string[]> = {};
  const errors: string[] = [];
  for (const key of Object.keys(source)) {
    if (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= questionCount) {
      errors.push(`solution_snapshots contains an unknown question index: ${key}.`);
    }
  }
  let aggregateChars = 0;
  for (let index = 0; index < questionCount; index += 1) {
    if (!hasOwn(source, index)) continue;
    const rawSnapshots = source[String(index)];
    if (!Array.isArray(rawSnapshots)) {
      errors.push(`Question ${index + 1} solution snapshots must be an array.`);
      continue;
    }
    const snapshots = sanitizeSnapshotsForDigest(rawSnapshots);
    if (snapshots.length !== rawSnapshots.length) {
      errors.push(`Question ${index + 1} contains an invalid, oversized, or unsupported solution snapshot.`);
      continue;
    }
    const snapshotChars = snapshots.reduce((sum, snapshot) => sum + snapshot.length, 0);
    if (aggregateChars + snapshotChars > MAX_PERSISTED_SNAPSHOT_CHARS) {
      errors.push('The combined solution snapshots exceed the per-attempt upload limit.');
      continue;
    }
    sanitized[String(index)] = snapshots;
    aggregateChars += snapshotChars;
  }
  return { snapshots: sanitized, errors };
}

function snapshotsAt(value: Record<string, string[]> | undefined, index: number): string[] {
  return Array.isArray(value?.[String(index)]) ? value![String(index)] : [];
}

function detailIdentityMatches(
  detail: any,
  answerRevision: number,
  answerDigest: string,
  snapshotDigest: string,
  questionDigest: string
): boolean {
  return Boolean(
    detail
    && detail.grade_status === 'graded'
    && detail.answer_revision === answerRevision
    && detail.answer_digest === answerDigest
    && (detail.snapshot_digest || createSnapshotDigest([])) === snapshotDigest
    && detail.question_digest === questionDigest
    && normalizeGradeScore(detail.score_fraction) !== null
  );
}

function deterministicDetail(input: {
  question: any;
  questionIndex: number;
  answer: unknown;
  answerRevision: number;
  answerDigest: string;
  snapshotDigest: string;
  snapshots: string[];
}): GradedDetail {
  const local = gradeQuestionLocally(input.question, input.answer, input.snapshots.length > 0);
  const normalized = normalizeQuestion(input.question);
  const points = normalized.valid ? normalized.question.points : local.points;
  const detail: GradedDetail = {
    question_index: input.questionIndex,
    question: String(input.question?.question ?? input.question?.raw_text ?? input.question?.statement ?? ''),
    type: local.questionType === 'unsupported' ? 'identification' : local.questionType,
    user_answer: input.answer,
    correct_answer: getCorrectAnswer(input.question) as string | string[],
    grade_status: local.gradeStatus,
    answer_revision: input.answerRevision,
    answer_digest: input.answerDigest,
    snapshot_digest: input.snapshotDigest,
    question_digest: createQuestionDigest(input.question),
    points,
    ai_feedback: ''
  };
  if (local.gradeStatus === 'graded') {
    detail.score_fraction = local.scoreFraction;
    detail.is_correct = local.scoreFraction === 1;
    detail.earned_points = local.earnedPoints;
  }
  return detail;
}

function semanticDetail(input: {
  question: any;
  questionIndex: number;
  answer: unknown;
  answerRevision: number;
  answerDigest: string;
  snapshotDigest: string;
  outcome: SemanticGradeOutcome;
  gradeProof?: string;
}): GradedDetail {
  const normalized = normalizeQuestion(input.question);
  const points = normalized.valid ? normalized.question.points : 1;
  const canonicalType = canonicalQuestionType(input.question);
  const detail: GradedDetail = {
    question_index: input.questionIndex,
    question: String(input.question?.question ?? input.question?.raw_text ?? input.question?.statement ?? ''),
    type: canonicalType === 'unsupported' ? 'open_ended' : canonicalType,
    user_answer: input.answer,
    correct_answer: getCorrectAnswer(input.question) as string | string[],
    grade_status: input.outcome.gradeStatus as GradeStatus,
    answer_revision: input.answerRevision,
    answer_digest: input.answerDigest,
    snapshot_digest: input.snapshotDigest,
    question_digest: createQuestionDigest(input.question),
    points,
    ai_feedback: sanitizeFeedback(input.outcome.feedback),
    ...(input.gradeProof ? { grade_proof: input.gradeProof } : {})
  };
  const score = normalizeGradeScore(input.outcome.scoreFraction);
  if (input.outcome.gradeStatus === 'graded' && score !== null) {
    detail.score_fraction = score;
    detail.is_correct = score === 1;
    detail.earned_points = Math.round((points * score + Number.EPSILON) * 10_000) / 10_000;
  }
  return detail;
}

function gradeResponse(detail: GradedDetail, retryable = false) {
  return {
    success: detail.grade_status === 'graded',
    grade_status: detail.grade_status,
    question_index: detail.question_index,
    answer_revision: detail.answer_revision,
    answer_digest: detail.answer_digest,
    snapshot_digest: detail.snapshot_digest,
    ...(detail.grade_status === 'graded' ? {
      is_correct: detail.is_correct,
      score_fraction: detail.score_fraction,
      earned_points: detail.earned_points
    } : {}),
    feedback: detail.ai_feedback || '',
    ai_feedback: detail.ai_feedback || '',
    ...(detail.grade_proof ? { grade_proof: detail.grade_proof } : {}),
    retryable
  };
}

async function persistIndividualProgress(input: {
  quiz: any;
  quizId: string;
  sessionId: string;
  studentName: unknown;
  detail: GradedDetail;
  snapshots: string[];
}): Promise<boolean> {
  return withAttemptLock(input.quizId, input.sessionId, async () => {
    const resultId = `res_${input.sessionId}`;
    const existing = results.get(resultId) as any;
    if (existing && existing.is_in_progress !== true) return false;
    const previousRevision = parsedRevision(existing?.answer_revisions?.[String(input.detail.question_index)], 0) ?? 0;
    if (input.detail.answer_revision < previousRevision) return false;
    const previousDetail = existing?.graded_details?.[input.detail.question_index];
    if (
      previousDetail
      && input.detail.answer_revision === previousRevision
      && (
        previousDetail.answer_digest !== input.detail.answer_digest
        || (previousDetail.snapshot_digest || createSnapshotDigest([])) !== input.detail.snapshot_digest
      )
    ) return false;
    if (!isLatestAnswerRevision({
      quizId: input.quizId,
      sessionId: input.sessionId,
      questionIndex: input.detail.question_index,
      answerRevision: input.detail.answer_revision,
      persistedRevision: previousRevision,
      answerDigest: input.detail.answer_digest,
      snapshotDigest: input.detail.snapshot_digest
    })) return false;
    const details = Array.from({ length: input.quiz.questions.length }, (_, index) => (
      existing?.graded_details?.[index] ?? null
    ));
    details[input.detail.question_index] = input.detail;
    const answerRevisions = { ...(existing?.answer_revisions || {}) };
    answerRevisions[String(input.detail.question_index)] = input.detail.answer_revision;
    const answers = { ...(existing?.answers || {}) };
    answers[String(input.detail.question_index)] = input.detail.user_answer;
    const solutionSnapshots = { ...(existing?.solution_snapshots || {}) };
    if (input.snapshots.length > 0) solutionSnapshots[String(input.detail.question_index)] = input.snapshots;
    else delete solutionSnapshots[String(input.detail.question_index)];
    const score = scoreQuizDetails(input.quiz.questions, details);
    const createdAt = existing?.created_at || new Date().toISOString();
    const record: QuizResult = {
      ...(existing || {}),
      id: resultId,
      quiz_id: input.quizId,
      session_id: input.sessionId,
      quiz_title: input.quiz.title,
      student_name: sanitizeStudentName(input.studentName || existing?.student_name),
      total_score: score.earned_points,
      max_score: score.max_points,
      graded_details: details,
      created_at: createdAt,
      score: score.earned_points,
      total: score.max_points,
      details,
      timestamp: createdAt,
      answers,
      answer_revisions: answerRevisions,
      ...(Object.keys(solutionSnapshots).length > 0 ? { solution_snapshots: solutionSnapshots } : {}),
      accuracy_pct: score.accuracy_pct,
      is_in_progress: true,
      session_revision: finiteNumber(existing?.session_revision, 0)
    };
    results.set(resultId, record);
    savePersistentData();
    void syncDocToFirestore('results', resultId, record).catch(error => {
      console.warn(`[Firebase] Individual grade sync failed for ${resultId}:`, error);
    });
    return true;
  });
}

router.post('/api/grade_individual', publicRateLimit('grade', 600, 10 * 60 * 1_000), async (req, res) => {
  const body = req.body || {};
  const quizId = body.quiz_id;
  const sessionId = body.session_id;
  const questionIndex = Number(body.question_index ?? body.q_index);
  const answerRevision = parsedRevision(body.answer_revision, 0);
  if (!validRecordId(quizId) || !validRecordId(sessionId)) {
    return res.status(400).json({ success: false, error: 'Invalid quiz_id or session_id.' });
  }
  if (answerRevision === null) {
    return res.status(400).json({ success: false, error: 'answer_revision must be a non-negative integer.' });
  }
  const quiz = quizzes.get(quizId);
  if (!quiz || !Number.isInteger(questionIndex) || questionIndex < 0 || !quiz.questions[questionIndex]) {
    return res.status(400).json({ success: false, error: 'Invalid quiz or question index.' });
  }
  const resultId = `res_${sessionId}`;
  const existing = results.get(resultId) as any;
  if (existing && (existing.quiz_id !== quizId || existing.session_id !== sessionId)) {
    return res.status(409).json({ success: false, error: 'This session belongs to a different quiz.' });
  }
  if (existing && existing.is_in_progress !== true) {
    return res.status(409).json({ success: false, error: 'This attempt is already finalized.' });
  }

  const answer = sanitizeStudentAnswer(body.student_answer);
  const rawSnapshots = body.solution_snapshots;
  if (rawSnapshots !== undefined && !Array.isArray(rawSnapshots)) {
    return res.status(400).json({ success: false, error: 'solution_snapshots must be an array.' });
  }
  const snapshots = sanitizeSnapshotsForDigest(rawSnapshots);
  if (Array.isArray(rawSnapshots) && snapshots.length !== rawSnapshots.length) {
    return res.status(413).json({
      success: false,
      grade_status: 'invalid_response',
      retryable: false,
      error: 'A solution snapshot is invalid, unsupported, or exceeds the upload limit.'
    });
  }
  const answerDigest = createAnswerDigest(answer);
  const snapshotDigest = createSnapshotDigest(snapshots);
  if (typeof body.answer_digest === 'string' && body.answer_digest !== answerDigest) {
    return res.status(409).json({ success: false, error: 'Answer identity mismatch.', code: 'ANSWER_DIGEST_MISMATCH' });
  }
  if (typeof body.snapshot_digest === 'string' && body.snapshot_digest !== snapshotDigest) {
    return res.status(409).json({ success: false, error: 'Snapshot identity mismatch.', code: 'SNAPSHOT_DIGEST_MISMATCH' });
  }
  const persistedRevision = parsedRevision(existing?.answer_revisions?.[String(questionIndex)], 0) ?? 0;
  const persistedDetail = existing?.graded_details?.[questionIndex];
  const hasPersistedAnswer = hasOwn(existing?.answers, questionIndex);
  const rawPersistedSnapshots = hasOwn(existing?.solution_snapshots, questionIndex)
    ? valueAt(existing.solution_snapshots, questionIndex)
    : [];
  if (
    hasPersistedAnswer
    && (
      !Array.isArray(rawPersistedSnapshots)
      || sanitizeSnapshotsForDigest(rawPersistedSnapshots).length !== rawPersistedSnapshots.length
    )
  ) {
    return res.status(409).json({
      success: false,
      grade_status: 'invalid_response',
      retryable: false,
      error: 'Stored solution snapshot identity is invalid and requires teacher review.'
    });
  }
  const persistedAnswerDigest = typeof persistedDetail?.answer_digest === 'string'
    ? persistedDetail.answer_digest
    : (hasPersistedAnswer ? createAnswerDigest(valueAt(existing.answers, questionIndex)) : null);
  const persistedSnapshotDigest = typeof persistedDetail?.snapshot_digest === 'string'
    ? persistedDetail.snapshot_digest
    : (hasPersistedAnswer
        ? createSnapshotDigest(rawPersistedSnapshots)
        : null);
  if (
    persistedAnswerDigest
    && answerRevision === persistedRevision
    && (
      persistedAnswerDigest !== answerDigest
      || persistedSnapshotDigest !== snapshotDigest
    )
  ) {
    return res.status(409).json({
      success: false,
      grade_status: 'pending',
      stale: true,
      current_revision: persistedRevision,
      error: 'This answer revision is already bound to different answer content.'
    });
  }
  const revisionState = observeAnswerRevision({
    quizId,
    sessionId,
    questionIndex,
    answerRevision,
    persistedRevision,
    answerDigest,
    snapshotDigest
  });
  if (revisionState.capacityExceeded) {
    return res.status(503).json({
      success: false,
      grade_status: 'retryable_error',
      retryable: true,
      error: 'The grading revision guard is temporarily at capacity. Please retry shortly.'
    });
  }
  if (!revisionState.accepted) {
    return res.status(409).json({
      success: false,
      grade_status: 'pending',
      stale: true,
      current_revision: revisionState.currentRevision,
      error: 'A newer answer revision already exists.'
    });
  }

  const question = quiz.questions[questionIndex];
  let detail = deterministicDetail({
    question,
    questionIndex,
    answer,
    answerRevision,
    answerDigest,
    snapshotDigest,
    snapshots
  });
  let retryable = false;

  if (detail.grade_status === 'pending') {
    const slot = await acquireSemanticAiSlot(req);
    if (!slot) {
      detail = semanticDetail({
        question,
        questionIndex,
        answer,
        answerRevision,
        answerDigest,
        snapshotDigest,
        outcome: {
          gradeStatus: 'retryable_error',
          feedback: 'Semantic grading is busy. Please retry shortly.',
          retryable: true
        }
      });
      retryable = true;
    } else {
      try {
        const outcome = await gradeSemanticQuestion({
          clients: getQuizCreatorGeminiClients(quiz),
          question,
          studentAnswer: answer,
          solutionSnapshots: snapshots,
          modelName: quiz.model_name,
          maxModelAttempts: 3
        });
        retryable = outcome.retryable;
        if (!isLatestAnswerRevision({
          quizId,
          sessionId,
          questionIndex,
          answerRevision,
          persistedRevision: parsedRevision((results.get(resultId) as any)?.answer_revisions?.[String(questionIndex)], 0) ?? 0,
          answerDigest,
          snapshotDigest
        })) {
          return res.status(409).json({
            success: false,
            grade_status: 'pending',
            question_index: questionIndex,
            answer_revision: answerRevision,
            answer_digest: answerDigest,
            snapshot_digest: snapshotDigest,
            stale: true,
            error: 'This grading response was superseded by a newer answer.'
          });
        }
        let proof: string | undefined;
        if (outcome.gradeStatus === 'graded' && normalizeGradeScore(outcome.scoreFraction) !== null) {
          proof = createGradeProof({
            quizId,
            sessionId,
            questionIndex,
            answerRevision,
            question,
            studentAnswer: answer,
            solutionSnapshots: snapshots,
            gradeStatus: 'graded',
            scoreFraction: outcome.scoreFraction!,
            feedback: outcome.feedback
          });
        }
        detail = semanticDetail({
          question,
          questionIndex,
          answer,
          answerRevision,
          answerDigest,
          snapshotDigest,
          outcome,
          gradeProof: proof
        });
      } finally {
        slot.release();
      }
    }
  }

  const persisted = await persistIndividualProgress({
    quiz,
    quizId,
    sessionId,
    studentName: body.student_name,
    detail,
    snapshots
  });

  if (!persisted) {
    return res.status(409).json({
      success: false,
      grade_status: 'pending',
      question_index: questionIndex,
      answer_revision: answerRevision,
      answer_digest: answerDigest,
      snapshot_digest: snapshotDigest,
      stale: true,
      error: 'This grading result was superseded or the attempt was already finalized.'
    });
  }

  res.setHeader('Cache-Control', 'no-store');
  const payload: any = gradeResponse(detail, retryable);
  if (detail.grade_status === 'graded' && quiz.quiz_mode !== 'back_and_forth') {
    payload.correct_answer = getCorrectAnswer(question);
  }
  const statusCode = detail.grade_status === 'retryable_error'
    ? 503
    : (detail.grade_status === 'invalid_response' ? 502 : 200);
  return res.status(statusCode).json(payload);
});

function canonicalAttemptInputs(body: any, quiz: any, existing?: any) {
  const errors: string[] = [];
  const isPlainRecord = (value: unknown): value is Record<string, unknown> => (
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  );
  const submittedAnswers = isPlainRecord(body.answers) ? body.answers : {};
  const revisions = isPlainRecord(body.answer_revisions) ? body.answer_revisions : {};
  if (!isPlainRecord(body.answers)) errors.push('answers must be an object keyed by question index.');
  if (!isPlainRecord(body.answer_revisions)) errors.push('answer_revisions must be an object keyed by question index.');
  for (const [field, value] of [
    ['answers', body.answers],
    ['answer_revisions', body.answer_revisions],
    ['answer_digests', body.answer_digests],
    ['snapshot_digests', body.snapshot_digests]
  ] as const) {
    if (value === undefined && (field === 'answer_digests' || field === 'snapshot_digests')) continue;
    if (!isPlainRecord(value)) {
      if (field === 'answer_digests' || field === 'snapshot_digests') {
        errors.push(`${field} must be an object keyed by question index when supplied.`);
      }
      continue;
    }
    for (const key of Object.keys(value)) {
      if (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= quiz.questions.length) {
        errors.push(`${field} contains an unknown question index: ${key}.`);
      }
    }
  }
  const submittedSnapshotResult = sanitizeSolutionSnapshots(body.solution_snapshots, quiz.questions.length);
  const submittedSnapshots = submittedSnapshotResult.snapshots;
  const snapshots: Record<string, string[]> = {};
  const answers: Record<string, unknown> = {};
  const answerRevisions: Record<string, number> = {};
  const answerDigests: Record<string, string> = {};
  const snapshotDigests: Record<string, string> = {};
  errors.push(...submittedSnapshotResult.errors);
  let canonicalSnapshotChars = 0;
  for (let index = 0; index < quiz.questions.length; index += 1) {
    const answer = sanitizeStudentAnswer(hasOwn(submittedAnswers, index) ? valueAt(submittedAnswers, index) : 'No Answer');
    const revision = parsedRevision(valueAt(revisions, index), 0);
    if (revision === null) {
      errors.push(`Question ${index + 1} has an invalid answer revision.`);
      continue;
    }
    let currentSnapshots: string[] = [];
    if (hasOwn(body.solution_snapshots, index)) {
      currentSnapshots = snapshotsAt(submittedSnapshots, index);
    } else if (hasOwn(existing?.solution_snapshots, index)) {
      const rawExistingSnapshots = valueAt(existing.solution_snapshots, index);
      if (!Array.isArray(rawExistingSnapshots)) {
        errors.push(`Question ${index + 1} has malformed stored solution snapshots.`);
      } else {
        const sanitizedExistingSnapshots = sanitizeSnapshotsForDigest(rawExistingSnapshots);
        if (sanitizedExistingSnapshots.length !== rawExistingSnapshots.length) {
          errors.push(`Question ${index + 1} has invalid or oversized stored solution snapshots.`);
        } else {
          currentSnapshots = sanitizedExistingSnapshots;
        }
      }
    }
    canonicalSnapshotChars += currentSnapshots.reduce((sum, snapshot) => sum + snapshot.length, 0);
    if (canonicalSnapshotChars > MAX_PERSISTED_SNAPSHOT_CHARS) {
      errors.push('The combined canonical solution snapshots exceed the per-attempt upload limit.');
    }
    const answerDigest = createAnswerDigest(answer);
    const snapshotDigest = createSnapshotDigest(currentSnapshots);
    if (hasOwn(body.answer_digests, index) && valueAt(body.answer_digests, index) !== answerDigest) {
      errors.push(`Question ${index + 1} has an answer digest mismatch.`);
    }
    if (hasOwn(body.snapshot_digests, index) && valueAt(body.snapshot_digests, index) !== snapshotDigest) {
      errors.push(`Question ${index + 1} has a snapshot digest mismatch.`);
    }
    answers[String(index)] = answer;
    answerRevisions[String(index)] = revision;
    answerDigests[String(index)] = answerDigest;
    snapshotDigests[String(index)] = snapshotDigest;
    if (currentSnapshots.length > 0) snapshots[String(index)] = currentSnapshots;
  }
  return { answers, answerRevisions, answerDigests, snapshotDigests, snapshots, errors };
}

function canonicalRevisionConflicts(input: {
  canonical: ReturnType<typeof canonicalAttemptInputs>;
  existing: any;
  quizId: string;
  sessionId: string;
  questionCount: number;
}): string[] {
  const conflicts: string[] = [];
  for (let index = 0; index < input.questionCount; index += 1) {
    const revision = input.canonical.answerRevisions[String(index)];
    const persistedRevision = parsedRevision(input.existing?.answer_revisions?.[String(index)], 0) ?? 0;
    const currentRevision = getCurrentAnswerRevision({
      quizId: input.quizId,
      sessionId: input.sessionId,
      questionIndex: index,
      persistedRevision
    });
    const inspected = inspectAnswerRevision({
      quizId: input.quizId,
      sessionId: input.sessionId,
      questionIndex: index,
      answerRevision: revision,
      persistedRevision,
      answerDigest: input.canonical.answerDigests[String(index)],
      snapshotDigest: input.canonical.snapshotDigests[String(index)]
    });
    if (!inspected.accepted) {
      conflicts.push(`Question ${index + 1} revision ${revision} is stale; current revision is ${currentRevision}.`);
      continue;
    }

    const existingDetail = input.existing?.graded_details?.[index];
    const hasStoredAnswer = hasOwn(input.existing?.answers, index);
    const storedAnswerDigest = typeof existingDetail?.answer_digest === 'string'
      ? existingDetail.answer_digest
      : (hasStoredAnswer ? createAnswerDigest(valueAt(input.existing.answers, index)) : null);
    const storedSnapshotDigest = typeof existingDetail?.snapshot_digest === 'string'
      ? existingDetail.snapshot_digest
      : (hasStoredAnswer
          ? createSnapshotDigest(snapshotsAt(input.existing?.solution_snapshots, index))
          : null);
    if (
      revision === persistedRevision
      && storedAnswerDigest
      && (
        storedAnswerDigest !== input.canonical.answerDigests[String(index)]
        || storedSnapshotDigest !== input.canonical.snapshotDigests[String(index)]
      )
    ) {
      conflicts.push(`Question ${index + 1} reused revision ${revision} for different answer content.`);
    }
  }
  return conflicts;
}

function observeCanonicalRevisions(input: {
  canonical: ReturnType<typeof canonicalAttemptInputs>;
  existing: any;
  quizId: string;
  sessionId: string;
  questionCount: number;
}): void {
  for (let index = 0; index < input.questionCount; index += 1) {
    observeAnswerRevision({
      quizId: input.quizId,
      sessionId: input.sessionId,
      questionIndex: index,
      answerRevision: input.canonical.answerRevisions[String(index)],
      persistedRevision: parsedRevision(input.existing?.answer_revisions?.[String(index)], 0) ?? 0,
      answerDigest: input.canonical.answerDigests[String(index)],
      snapshotDigest: input.canonical.snapshotDigests[String(index)]
    });
  }
}

function verifiedSemanticDetail(input: {
  submitted: any;
  existing: any;
  quizId: string;
  sessionId: string;
  question: any;
  questionIndex: number;
  answer: unknown;
  answerRevision: number;
  answerDigest: string;
  snapshotDigest: string;
  snapshots: string[];
}): GradedDetail | null {
  const expectedIdentity = {
    quizId: input.quizId,
    sessionId: input.sessionId,
    questionIndex: input.questionIndex,
    answerRevision: input.answerRevision,
    question: input.question,
    studentAnswer: input.answer,
    solutionSnapshots: input.snapshots
  };
  const existingIdentityMatches = detailIdentityMatches(
    input.existing,
    input.answerRevision,
    input.answerDigest,
    input.snapshotDigest,
    createQuestionDigest(input.question)
  );
  const proofCandidates = [
    ...(existingIdentityMatches && typeof input.existing?.grade_proof === 'string'
      ? [input.existing.grade_proof]
      : []),
    ...(typeof input.submitted?.grade_proof === 'string'
      ? [input.submitted.grade_proof]
      : [])
  ];

  for (const gradeProof of [...new Set(proofCandidates)]) {
    const verified = verifyGradeProof(gradeProof, expectedIdentity);
    if (!verified) continue;
    return semanticDetail({
      question: input.question,
      questionIndex: input.questionIndex,
      answer: input.answer,
      answerRevision: input.answerRevision,
      answerDigest: input.answerDigest,
      snapshotDigest: input.snapshotDigest,
      outcome: {
        gradeStatus: 'graded',
        scoreFraction: verified.scoreFraction,
        isCorrect: verified.isCorrect,
        feedback: verified.feedback,
        retryable: false
      },
      gradeProof
    });
  }
  return null;
}

function setResultCookie(req: any, res: any, resultId: string, token: string): void {
  const forwardedProtocol = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  res.cookie(resultAccessCookieName(resultId), token, {
    httpOnly: true,
    secure: Boolean(req.secure || forwardedProtocol === 'https'),
    sameSite: 'lax',
    path: '/',
    maxAge: 6 * 60 * 60 * 1_000
  });
}

function finalResponse(req: any, res: any, result: any, idempotent: boolean) {
  const access = createResultAccessTokenForSession(result.id, result.quiz_id, result.session_id);
  setResultCookie(req, res, result.id, access.token);
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    success: true,
    idempotent,
    result_id: result.id,
    total_score: result.total_score,
    max_score: result.max_score,
    score: result.total_score,
    total: result.max_score,
    accuracy_pct: result.accuracy_pct,
    graded_details: result.graded_details,
    details: result.graded_details,
    result_access_token: access.token
  });
}

router.post(
  ['/submit', '/api/submit_quiz'],
  publicRateLimit('submit', 120, 60 * 60 * 1_000),
  async (req, res) => {
    const body = req.body || {};
    const quizId = body.quiz_id;
    const sessionId = body.session_id;
    if (!validRecordId(quizId) || !validRecordId(sessionId)) {
      return res.status(400).json({ success: false, error: 'A valid quiz_id and session_id are required.' });
    }
    const quiz = quizzes.get(quizId);
    if (!quiz) return res.status(404).json({ success: false, error: 'Quiz not found.' });

    return withAttemptLock(quizId, sessionId, async () => {
      const resultId = `res_${sessionId}`;
      const existing = results.get(resultId) as any;
      if (existing && (existing.quiz_id !== quizId || existing.session_id !== sessionId)) {
        return res.status(409).json({ success: false, error: 'This session belongs to a different quiz.' });
      }
      if (existing && existing.is_in_progress !== true) {
        return finalResponse(req, res, existing, true);
      }

      const currentSessionRevision = parsedRevision(existing?.session_revision, 0) ?? 0;
      const submittedSessionRevision = parsedRevision(body.session_revision, currentSessionRevision);
      if (submittedSessionRevision === null) {
        return res.status(400).json({ success: false, error: 'session_revision must be a non-negative integer.' });
      }
      if (submittedSessionRevision < currentSessionRevision) {
        return res.status(409).json({
          success: false,
          grading_incomplete: true,
          stale: true,
          current_session_revision: currentSessionRevision,
          error: 'Final submission was superseded by newer saved progress.'
        });
      }

      const canonical = canonicalAttemptInputs(body, quiz, existing);
      if (canonical.errors.length > 0) {
        return res.status(409).json({
          success: false,
          grading_incomplete: true,
          error: 'The submitted answer identity is invalid.',
          details: canonical.errors
        });
      }
      const revisionConflicts = canonicalRevisionConflicts({
        canonical,
        existing,
        quizId,
        sessionId,
        questionCount: quiz.questions.length
      });
      if (revisionConflicts.length > 0) {
        return res.status(409).json({
          success: false,
          grading_incomplete: true,
          stale: true,
          error: 'Final submission contains a stale or conflicting answer revision.',
          details: revisionConflicts
        });
      }
      observeCanonicalRevisions({
        canonical,
        existing,
        quizId,
        sessionId,
        questionCount: quiz.questions.length
      });
      const submittedDetails = Array.isArray(body.graded_details) ? body.graded_details : [];
      const finalDetails: Array<GradedDetail | null> = Array.from({ length: quiz.questions.length }, () => null);
      const incomplete: Array<{ question_index: number; grade_status: GradeStatus; retryable: boolean; reason: string }> = [];
      const clients = getQuizCreatorGeminiClients(quiz);

      for (let index = 0; index < quiz.questions.length; index += 1) {
        const question = quiz.questions[index];
        const answer = canonical.answers[String(index)];
        const answerRevision = canonical.answerRevisions[String(index)];
        const answerDigest = canonical.answerDigests[String(index)];
        const snapshotDigest = canonical.snapshotDigests[String(index)];
        const snapshots = snapshotsAt(canonical.snapshots, index);
        let detail = deterministicDetail({
          question,
          questionIndex: index,
          answer,
          answerRevision,
          answerDigest,
          snapshotDigest,
          snapshots
        });

        if (detail.grade_status === 'pending') {
          const verified = verifiedSemanticDetail({
            submitted: submittedDetails[index],
            existing: existing?.graded_details?.[index],
            quizId,
            sessionId,
            question,
            questionIndex: index,
            answer,
            answerRevision,
            answerDigest,
            snapshotDigest,
            snapshots
          });
          if (verified) {
            detail = verified;
          } else {
            const slot = await acquireSemanticAiSlot(req);
            const outcome = slot
              ? await gradeSemanticQuestion({
                clients,
                question,
                studentAnswer: answer,
                solutionSnapshots: snapshots,
                modelName: quiz.model_name,
                maxModelAttempts: 2
              }).finally(() => slot.release())
              : {
                gradeStatus: 'retryable_error' as const,
                feedback: 'Semantic grading is busy. Please retry final submission.',
                retryable: true
              };
            let proof: string | undefined;
            if (outcome.gradeStatus === 'graded' && normalizeGradeScore(outcome.scoreFraction) !== null) {
              proof = createGradeProof({
                quizId,
                sessionId,
                questionIndex: index,
                answerRevision,
                question,
                studentAnswer: answer,
                solutionSnapshots: snapshots,
                scoreFraction: outcome.scoreFraction!,
                feedback: outcome.feedback
              });
            }
            detail = semanticDetail({
              question,
              questionIndex: index,
              answer,
              answerRevision,
              answerDigest,
              snapshotDigest,
              outcome,
              gradeProof: proof
            });
          }
        }
        finalDetails[index] = detail;
        if (detail.grade_status !== 'graded') {
          incomplete.push({
            question_index: index,
            grade_status: detail.grade_status,
            retryable: detail.grade_status === 'retryable_error',
            reason: detail.ai_feedback || 'Authoritative grading is incomplete.'
          });
        }
      }

      const completionConflicts = canonicalRevisionConflicts({
        canonical,
        existing,
        quizId,
        sessionId,
        questionCount: quiz.questions.length
      });
      if (completionConflicts.length > 0) {
        return res.status(409).json({
          success: false,
          grading_incomplete: true,
          stale: true,
          error: 'Final submission was superseded while grading was in progress.',
          details: completionConflicts
        });
      }

      if (incomplete.length > 0) {
        const score = scoreQuizDetails(quiz.questions, finalDetails);
        const createdAt = existing?.created_at || new Date().toISOString();
        const progress: QuizResult = {
          ...(existing || {}),
          id: resultId,
          quiz_id: quizId,
          session_id: sessionId,
          quiz_title: quiz.title,
          student_name: sanitizeStudentName(body.student_name),
          total_score: score.earned_points,
          max_score: score.max_points,
          graded_details: finalDetails,
          created_at: createdAt,
          score: score.earned_points,
          total: score.max_points,
          details: finalDetails,
          timestamp: createdAt,
          answers: canonical.answers,
          answer_revisions: canonical.answerRevisions,
          solution_snapshots: canonical.snapshots,
          session_revision: submittedSessionRevision,
          accuracy_pct: score.accuracy_pct,
          is_in_progress: true
        };
        results.set(resultId, progress);
        savePersistentData();
        void syncDocToFirestore('results', resultId, progress).catch(error => {
          console.warn(`[Firebase] Incomplete final grading sync failed for ${resultId}:`, error);
        });
        const retryable = incomplete.some(item => item.retryable);
        return res.status(retryable ? 503 : 409).json({
          success: false,
          grading_incomplete: true,
          retryable,
          error: 'The quiz was not finalized because one or more answers do not yet have an authoritative grade.',
          incomplete_questions: incomplete
        });
      }

      const score = scoreQuizDetails(quiz.questions, finalDetails);
      const now = new Date().toISOString();
      const statusValue = String(body.submission_status || body.status || 'completed').toLowerCase();
      const normalizedStatus = ['completed', 'early', 'terminated'].includes(statusValue) ? statusValue : 'completed';
      const completionNote = normalizedStatus === 'early'
        ? 'Left without finishing'
        : (normalizedStatus === 'terminated' ? 'Terminated by teacher' : '');
      const access = createResultAccessTokenForSession(resultId, quizId, sessionId);
      const record: QuizResult = {
        id: resultId,
        quiz_id: quizId,
        session_id: sessionId,
        quiz_title: quiz.title,
        student_name: sanitizeStudentName(body.student_name),
        total_score: score.earned_points,
        max_score: score.max_points,
        graded_details: finalDetails,
        created_at: existing?.created_at || now,
        finalized_at: now,
        score: score.earned_points,
        total: score.max_points,
        details: finalDetails,
        timestamp: existing?.created_at || now,
        answers: canonical.answers,
        answer_revisions: canonical.answerRevisions,
        ...(Object.keys(canonical.snapshots).length > 0 ? { solution_snapshots: canonical.snapshots } : {}),
        session_revision: submittedSessionRevision,
        time_active_seconds: boundedNumber(body.time_active_seconds, 0, 0, MAX_RECORDED_DURATION_SECONDS),
        time_paused_seconds: boundedNumber(body.time_paused_seconds, 0, 0, MAX_RECORDED_DURATION_SECONDS),
        total_duration_seconds: boundedNumber(body.total_duration_seconds, 0, 0, MAX_RECORDED_DURATION_SECONDS),
        accuracy_pct: score.accuracy_pct,
        completion_note: completionNote,
        is_in_progress: false,
        access_token_hash: access.hash
      };

      results.set(resultId, record);
      savePersistentData();
      try {
        await syncDocToFirestore('results', resultId, record);
      } catch (error) {
        if (existing) results.set(resultId, existing);
        else results.delete(resultId);
        savePersistentData();
        throw error;
      }
      const io = req.app.get('io');
      if (io) io.to(`quiz_${quizId}`).emit('progressive_result_update', {
        result_id: resultId,
        session_id: sessionId,
        total_score: record.total_score,
        max_score: record.max_score,
        accuracy_pct: record.accuracy_pct,
        finalized: true
      });
      clearAttemptRevisionState(quizId, sessionId);
      return finalResponse(req, res, record, false);
    });
  }
);

router.post(
  '/api/save_progressive_result',
  publicRateLimit('progressive', 1_200, 10 * 60 * 1_000),
  async (req, res) => {
    const body = req.body || {};
    const quizId = body.quiz_id;
    const sessionId = body.session_id;
    const sessionRevision = parsedRevision(body.session_revision, 0);
    if (!validRecordId(quizId) || !validRecordId(sessionId) || sessionRevision === null) {
      return res.status(400).json({ success: false, error: 'Invalid quiz/session revision identity.' });
    }
    const quiz = quizzes.get(quizId);
    if (!quiz) return res.status(404).json({ success: false, error: 'Quiz not found.' });

    return withAttemptLock(quizId, sessionId, async () => {
      const resultId = `res_${sessionId}`;
      const existing = results.get(resultId) as any;
      if (existing && (existing.quiz_id !== quizId || existing.session_id !== sessionId)) {
        return res.status(409).json({ success: false, error: 'This session belongs to a different quiz.' });
      }
      if (existing && existing.is_in_progress !== true) {
        return res.json({ success: true, result_id: resultId, ignored: true, finalized: true });
      }
      const currentSessionRevision = parsedRevision(existing?.session_revision, -1) ?? -1;
      if (existing && sessionRevision <= currentSessionRevision) {
        return res.json({
          success: true,
          result_id: resultId,
          ignored: true,
          stale: true,
          current_session_revision: currentSessionRevision
        });
      }

      const canonical = canonicalAttemptInputs(body, quiz, existing);
      if (canonical.errors.length > 0) {
        return res.status(409).json({ success: false, error: 'Progress identity mismatch.', details: canonical.errors });
      }
      const revisionConflicts = canonicalRevisionConflicts({
        canonical,
        existing,
        quizId,
        sessionId,
        questionCount: quiz.questions.length
      });
      if (revisionConflicts.length > 0) {
        return res.status(409).json({
          success: false,
          stale: true,
          error: 'Progress contains a stale or conflicting answer revision.',
          details: revisionConflicts
        });
      }
      observeCanonicalRevisions({
        canonical,
        existing,
        quizId,
        sessionId,
        questionCount: quiz.questions.length
      });
      const submittedDetails = Array.isArray(body.progressive_results) ? body.progressive_results : [];
      const details: Array<GradedDetail | null> = Array.from({ length: quiz.questions.length }, (_, index) => (
        existing?.graded_details?.[index] ?? null
      ));
      const storedAnswers = { ...(existing?.answers || {}) };
      const storedRevisions = { ...(existing?.answer_revisions || {}) };
      const storedSnapshots = { ...(existing?.solution_snapshots || {}) };

      for (let index = 0; index < quiz.questions.length; index += 1) {
        const revision = canonical.answerRevisions[String(index)];
        const previousRevision = parsedRevision(storedRevisions[String(index)], 0) ?? 0;
        if (revision < previousRevision) continue;
        const question = quiz.questions[index];
        const answer = canonical.answers[String(index)];
        const answerDigest = canonical.answerDigests[String(index)];
        const snapshotDigest = canonical.snapshotDigests[String(index)];
        const snapshots = snapshotsAt(canonical.snapshots, index);
        let detail = deterministicDetail({
          question,
          questionIndex: index,
          answer,
          answerRevision: revision,
          answerDigest,
          snapshotDigest,
          snapshots
        });
        if (detail.grade_status === 'pending') {
          detail = verifiedSemanticDetail({
            submitted: submittedDetails[index],
            existing: details[index],
            quizId,
            sessionId,
            question,
            questionIndex: index,
            answer,
            answerRevision: revision,
            answerDigest,
            snapshotDigest,
            snapshots
          }) || detail;
        }
        details[index] = detail;
        storedAnswers[String(index)] = answer;
        storedRevisions[String(index)] = revision;
        if (snapshots.length > 0) storedSnapshots[String(index)] = snapshots;
        else delete storedSnapshots[String(index)];
        observeAnswerRevision({
          quizId,
          sessionId,
          questionIndex: index,
          answerRevision: revision,
          persistedRevision: previousRevision,
          answerDigest,
          snapshotDigest
        });
      }

      const score = scoreQuizDetails(quiz.questions, details);
      const createdAt = existing?.created_at || new Date().toISOString();
      const record: QuizResult = {
        ...(existing || {}),
        id: resultId,
        quiz_id: quizId,
        session_id: sessionId,
        quiz_title: quiz.title,
        student_name: sanitizeStudentName(body.student_name),
        total_score: score.earned_points,
        max_score: score.max_points,
        graded_details: details,
        created_at: createdAt,
        score: score.earned_points,
        total: score.max_points,
        details,
        timestamp: createdAt,
        answers: storedAnswers,
        answer_revisions: storedRevisions,
        ...(Object.keys(storedSnapshots).length > 0 ? { solution_snapshots: storedSnapshots } : {}),
        session_revision: sessionRevision,
        time_active_seconds: boundedNumber(body.time_active_seconds, existing?.time_active_seconds || 0, 0, MAX_RECORDED_DURATION_SECONDS),
        time_paused_seconds: boundedNumber(body.time_paused_seconds, existing?.time_paused_seconds || 0, 0, MAX_RECORDED_DURATION_SECONDS),
        total_duration_seconds: boundedNumber(body.total_duration_seconds, existing?.total_duration_seconds || 0, 0, MAX_RECORDED_DURATION_SECONDS),
        accuracy_pct: score.accuracy_pct,
        is_in_progress: true
      };
      results.set(resultId, record);
      savePersistentData();
      void syncDocToFirestore('results', resultId, record).catch(error => {
        console.warn(`[Firebase] Progressive result sync failed for ${resultId}:`, error);
      });
      const io = req.app.get('io');
      if (io) io.to(`quiz_${quizId}`).emit('progressive_result_update', {
        result_id: resultId,
        session_id: sessionId,
        total_score: record.total_score,
        max_score: record.max_score,
        accuracy_pct: record.accuracy_pct,
        finalized: false
      });
      return res.json({
        success: true,
        result_id: resultId,
        session_revision: sessionRevision,
        total_score: score.earned_points,
        max_score: score.max_points,
        accuracy_pct: score.accuracy_pct,
        grading_complete: score.grading_complete
      });
    });
  }
);

router.post('/api/load_progressive_result', publicRateLimit('restore', 300, 10 * 60 * 1_000), (req, res) => {
  const quizId = req.body?.quiz_id;
  const sessionId = req.body?.session_id;
  if (!validRecordId(quizId) || !validRecordId(sessionId)) {
    return res.status(400).json({ success: false, error: 'Invalid quiz/session identity.' });
  }
  const resultId = `res_${sessionId}`;
  const record = results.get(resultId) as any;
  if (!record || record.quiz_id !== quizId || record.session_id !== sessionId) {
    return res.status(404).json({ success: false, error: 'Progress was not found.' });
  }
  if (record.is_in_progress !== true) {
    return res.json({ success: true, finalized: true, result_id: resultId });
  }
  const publicDetails = (Array.isArray(record.graded_details) ? record.graded_details : []).map((detail: any) => {
    if (!detail || typeof detail !== 'object') return detail;
    const { correct_answer: _answer, ...safe } = detail;
    return safe;
  });
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    success: true,
    finalized: false,
    result_id: resultId,
    answers: record.answers || {},
    answer_revisions: record.answer_revisions || {},
    progressive_results: publicDetails,
    solution_snapshots: record.solution_snapshots || {},
    session_revision: record.session_revision || 0,
    total_score: record.total_score || 0,
    max_score: record.max_score || 0,
    time_active_seconds: record.time_active_seconds || 0,
    time_paused_seconds: record.time_paused_seconds || 0,
    total_duration_seconds: record.total_duration_seconds || 0
  });
});

router.post(
  '/api/explain',
  optionalAuth,
  publicRateLimit('explain', 30, 10 * 60 * 1_000),
  async (req: AuthRequest, res) => {
    const body = req.body || {};
    const quizId = body.quiz_id;
    const sessionId = body.session_id;
    const questionIndex = Number(body.question_index ?? body.q_index);
    const answerRevision = parsedRevision(body.answer_revision, 0);
    const quiz = validRecordId(quizId) ? quizzes.get(quizId) : null;
    const question = quiz && Number.isInteger(questionIndex) && questionIndex >= 0
      ? quiz.questions?.[questionIndex]
      : null;
    if (!question || !isSemanticQuestion(question)) {
      return res.status(400).json({
        success: false,
        ai_skipped: true,
        error: 'AI explanations are available only for open-ended and graphing questions.'
      });
    }
    const answer = sanitizeStudentAnswer(body.user_answer);
    const snapshots = sanitizeSnapshotsForDigest(body.solution_snapshots);
    const verified = question && validRecordId(sessionId) && answerRevision !== null
      ? verifyGradeProof(body.grade_proof, {
        quizId,
        sessionId,
        questionIndex,
        answerRevision,
        question,
        studentAnswer: answer,
        solutionSnapshots: snapshots
      })
      : null;
    const isTeacher = req.user?.role === 'teacher' || req.user?.role === 'admin';
    const ai = (verified || isTeacher) && quiz
      ? getQuizCreatorGeminiClients(quiz)[0] ?? null
      : null;
    if (ai && question) {
      try {
        const prompt = `Explain clearly in 2-3 sentences why this submitted answer did not receive full credit and how to reach the correct answer.
Question: ${JSON.stringify(String(question.question || '').slice(0, 50_000))}
Student answer: ${JSON.stringify(answer)}
Correct answer: ${JSON.stringify(getCorrectAnswer(question))}

CRUCIAL: You MUST enclose ALL mathematical expressions, numbers, equations, counts, measurements, percentages, and standalone numbers (except for Identification answers) inside your feedback with LaTeX dollar signs (e.g., $x^2$, $130/10$, $\\text{\\$40}$, $15\\%$, $-42$, $10$ meters). Do NOT use asterisks for math.
LATEX DELIMITER CHECK: Every inline expression must have exactly one opening and one closing '$'. Verify all delimiters are balanced before returning JSON. Write '$b = 6$ or $b = -6$', never 'b = 6$ or $b = -6'.
Return only {"explanation":"..."}.`;
        const response = await ai.models.generateContent({
          model: getRealModelName(body.model_name || 'gemini-3.5-flash-lite'),
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: { explanation: { type: Type.STRING } },
              required: ['explanation']
            }
          }
        });
        const parsed = safeParseJSON(response.text || '');
        if (
          parsed
          && typeof parsed.explanation === 'string'
          && parsed.explanation.trim()
          && hasBalancedLatexDelimiters(parsed.explanation)
        ) {
          return res.json({
            success: true,
            explanation: normalizeAiLatexText(parsed.explanation.slice(0, MAX_FEEDBACK_LENGTH))
          });
        }
      } catch (error) {
        console.warn('[Grading] AI explanation unavailable:', error);
      }
    }
    return res.json({
      success: true,
      explanation: 'An AI explanation is unavailable right now. Review the worked solution or ask your teacher for clarification.',
      ai_unavailable: true
    });
  }
);

router.post('/api/reformat_answer', (req, res) => {
  res.json({ success: true, formatted: String(req.body?.answer ?? '').trim() });
});

export default router;
