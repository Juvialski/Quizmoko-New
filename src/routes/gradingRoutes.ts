import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { Type } from '@google/genai';
import { optionalAuth } from '../middleware/auth.ts';
import type { AuthRequest } from '../middleware/auth.ts';
import { quizzes, results, users, savePersistentData, syncDocToFirestore } from '../store/db.ts';
import { getGeminiClient, getRealModelName, safeParseJSON } from '../services/gemini.ts';
import {
  canonicalQuestionType,
  getCorrectAnswer,
  gradeQuestionLocally
} from '../services/grading.ts';
import { createGradeProof, verifyGradeProof } from '../services/gradeProof.ts';
import { createResultAccessToken, resultAccessCookieName } from '../services/resultAccess.ts';

const router = Router();
const MAX_STUDENT_NAME_LENGTH = 120;
const MAX_ANSWER_LENGTH = 50_000;
const MAX_FEEDBACK_LENGTH = 10_000;
const MAX_RECORDED_DURATION_SECONDS = 7 * 24 * 60 * 60;
const MAX_PERSISTED_SNAPSHOT_CHARS = 10 * 1024 * 1024;
const MAX_VISION_IMAGE_CHARS = 12 * 1024 * 1024;
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();
const semanticAiBuckets = new Map<string, { count: number; resetAt: number }>();
let semanticAiInFlight = 0;
const MAX_SEMANTIC_AI_IN_FLIGHT = 32;
const MAX_SEMANTIC_AI_ATTEMPTS_PER_IP = 1200;
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
      return res.status(429).json({
        success: false,
        error: 'Too many requests. Please wait before trying again.'
      });
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
  
  for (let attempt = 0; attempt < 5; attempt++) {
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

      if (semanticAiBuckets.size > 10_000) {
        for (const [bucketKey, value] of semanticAiBuckets) {
          if (value.resetAt <= now) semanticAiBuckets.delete(bucketKey);
        }
      }

      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          semanticAiInFlight = Math.max(0, semanticAiInFlight - 1);
        }
      };
    }

    // Brief delay before retrying slot acquisition
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return null;
}

function finiteNumber(value: any, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boundedNumber(value: any, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, finiteNumber(value, fallback)));
}

function validRecordId(value: any): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
}

function createUniqueResultId(): string {
  let resultId = '';
  do {
    resultId = `res_${randomUUID().replace(/-/g, '')}`;
  } while (results.has(resultId));
  return resultId;
}

function sanitizeStudentName(value: any): string {
  const normalized = String(value ?? '').trim().slice(0, MAX_STUDENT_NAME_LENGTH);
  return normalized && normalized !== 'undefined' ? normalized : 'Anonymous';
}

function sanitizeStudentAnswer(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.slice(0, MAX_ANSWER_LENGTH);
  if (typeof value === 'number') return Number.isFinite(value) ? value : '';
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map(item => (
      typeof item === 'string'
        ? item.slice(0, 2_000)
        : sanitizeStudentAnswer(item)
    ));
  }
  return String(value).slice(0, MAX_ANSWER_LENGTH);
}

function sanitizeFeedback(value: any): string {
  return typeof value === 'string'
    ? value.slice(0, MAX_FEEDBACK_LENGTH).replace(/[<>]/g, '')
    : '';
}

function sanitizeSolutionSnapshots(value: any, questionCount: number): Record<string, string[]> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const sanitized: Record<string, string[]> = {};
  let aggregateChars = 0;
  for (let index = 0; index < questionCount; index += 1) {
    const snapshots = value[index] ?? value[String(index)];
    if (!Array.isArray(snapshots)) continue;
    const validSnapshots: string[] = [];
    for (const snapshot of snapshots.slice(0, 5)) {
      if (
        typeof snapshot !== 'string'
        || !/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(snapshot)
        || aggregateChars + snapshot.length > MAX_PERSISTED_SNAPSHOT_CHARS
      ) {
        continue;
      }
      validSnapshots.push(snapshot);
      aggregateChars += snapshot.length;
    }
    if (validSnapshots.length > 0) sanitized[String(index)] = validSnapshots;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function authoritativeDetail(
  question: any,
  submitted: any,
  rawAnswer: any,
  quizId: string,
  questionIndex: number
) {
  const userAnswer = sanitizeStudentAnswer(rawAnswer);
  const localGrade = gradeQuestionLocally(question, userAnswer);
  const verifiedSemanticGrade = localGrade.requiresSemanticGrading
    ? verifyGradeProof(submitted?.grade_proof, {
      quizId,
      questionIndex,
      question,
      studentAnswer: userAnswer
    })
    : null;
  const scoreFraction = verifiedSemanticGrade
    ? verifiedSemanticGrade.scoreFraction
    : (submitted && typeof submitted.score_fraction === 'number'
      ? Math.max(0, Math.min(1, submitted.score_fraction))
      : localGrade.scoreFraction);
  const isCorrect = verifiedSemanticGrade
    ? verifiedSemanticGrade.isCorrect
    : (submitted && typeof submitted.is_correct === 'boolean'
      ? submitted.is_correct
      : localGrade.isCorrect);
  const gradeProof = createGradeProof({
    quizId,
    questionIndex,
    question,
    studentAnswer: userAnswer,
    isCorrect,
    scoreFraction
  });

  return {
    question: question.question || question.raw_text || question.statement || '',
    type: canonicalQuestionType(question),
    user_answer: userAnswer,
    correct_answer: getCorrectAnswer(question),
    is_correct: isCorrect,
    score_fraction: scoreFraction,
    ai_feedback: (verifiedSemanticGrade || submitted?.ai_feedback) ? sanitizeFeedback(submitted.ai_feedback) : '',
    grade_proof: gradeProof
  };
}

function extractQuestionVision(questionValue: any): { questionText: string; imageParts: any[] } {
  const imageParts: any[] = [];
  let aggregateChars = 0;
  const raw = String(questionValue ?? '');
  const questionText = raw.replace(
    /<img\b[^>]*\bsrc\s*=\s*["']data:(image\/[a-z0-9.+-]+);base64,([^"']+)["'][^>]*>/gi,
    (_match, mimeType: string, data: string) => {
      if (
        imageParts.length < 5
        && data.length <= MAX_VISION_IMAGE_CHARS
        && aggregateChars + data.length <= MAX_VISION_IMAGE_CHARS
      ) {
        imageParts.push({ inlineData: { data, mimeType } });
        aggregateChars += data.length;
      }
      return '[IMAGE_PROVIDED_IN_VISION_CONTEXT]';
    }
  );
  return { questionText, imageParts };
}

router.post('/api/grade_individual', publicRateLimit('grade', 600, 10 * 60 * 1_000), async (req, res) => {
  const { quiz_id, session_id, q_index, student_answer, solution_snapshots } = req.body || {};
  if (!validRecordId(quiz_id)) {
    return res.status(400).json({ success: false, error: 'Invalid quiz_id' });
  }
  const quiz = quizzes.get(quiz_id);
  const submittedApiKey = typeof req.body.api_key === 'string'
    ? req.body.api_key.trim().slice(0, 512)
    : '';
  let resolvedApiKey = submittedApiKey;
  if (!resolvedApiKey && quiz) {
    const ownerId = quiz.user_id || 'teacher_test';
    const owner = users.get(ownerId);
    if (owner && typeof owner.stored_custom_key === 'string') {
      resolvedApiKey = owner.stored_custom_key;
    }
  }
  const api_key = resolvedApiKey || '';
  const questionIndex = Number(q_index);

  if (!quiz || !Number.isInteger(questionIndex) || questionIndex < 0 || !quiz.questions[questionIndex]) {
    return res.status(400).json({
      success: false,
      is_correct: false,
      correct_answer: '',
      score_fraction: 0,
      ai_feedback: '',
      error: 'Invalid quiz or question index'
    });
  }

  const q = quiz.questions[questionIndex];
  const actual = sanitizeStudentAnswer(student_answer);
  const hasSnapshots = Array.isArray(solution_snapshots) && solution_snapshots.some((s: any) => typeof s === 'string' && s.trim().length > 0);

  if (session_id && validRecordId(session_id) && hasSnapshots) {
    const progressiveResultId = `res_${session_id}`;
    const existingProgress = results.get(progressiveResultId) as any;
    if (existingProgress && existingProgress.is_in_progress === true) {
      const sanitized = sanitizeSolutionSnapshots({ [questionIndex]: solution_snapshots }, quiz.questions.length);
      if (sanitized && sanitized[String(questionIndex)]) {
        existingProgress.solution_snapshots = {
          ...(existingProgress.solution_snapshots || {}),
          [String(questionIndex)]: sanitized[String(questionIndex)]
        };
        results.set(progressiveResultId, existingProgress);
      }
    }
  }

  const localGrade = gradeQuestionLocally(q, actual, hasSnapshots);
  const qType = localGrade.questionType;
  const expected = localGrade.correctAnswer;

  let isCorrect = localGrade.isCorrect;
  let scoreFraction = localGrade.scoreFraction;
  let aiFeedback = '';

  if (localGrade.requiresSemanticGrading) {
    const semanticSlot = await acquireSemanticAiSlot(req);
    const clientsToTry: any[] = [];
    if (typeof api_key === 'string' && api_key.trim().length > 0) {
      try {
        const customClient = getGeminiClient(api_key.trim());
        if (customClient) clientsToTry.push(customClient);
      } catch (err) {
        console.warn('Invalid custom API key provided, will use default system key:', err);
      }
    }
    try {
      const defaultClient = getGeminiClient();
      if (defaultClient && (!clientsToTry.length || defaultClient !== clientsToTry[0])) {
        clientsToTry.push(defaultClient);
      }
    } catch (err) {
      console.error('Failed to resolve system Gemini client:', err);
    }

    if (clientsToTry.length > 0) {
      try {
        const vision = extractQuestionVision(q.question);
        const prompt = `You are an expert teacher grading a quiz.
Question Type: ${qType}
Question: ${JSON.stringify(vision.questionText)}
Correct Answer Key: ${JSON.stringify(expected || 'Open-ended evaluation / evaluate based on question requirement')}
Student's Response: ${JSON.stringify(actual || (hasSnapshots ? '[Whiteboard solution image attached in vision context]' : 'No text response'))}

Evaluate the student's response thoroughly and fairly based on the answer key:
1. FULL CREDIT (score_fraction = 1.0, is_correct = true): If the student's response is fully correct or mathematically/semantically equivalent to the answer key or question requirement.
2. PARTIAL CREDIT (score_fraction between 0.1 and 0.9): If the question has multiple parts, sub-questions, steps, or multi-answer items and the student answered SOME parts correctly.
   - Example: For a question with 2 sub-questions, if the student gets 1 correct and 1 incorrect, award a score_fraction of 0.5.
   - Example: For a question with 3 parts where 2 are correct, award a score_fraction of 0.67.
   - Example: If the answer is partially right or missing only minor required details, award partial credit proportional to correctness (e.g., 0.5 for half correct).
   - Set "is_correct" to false if credit is partial (< 1.0).
3. NO CREDIT (score_fraction = 0.0, is_correct = false): If the student's response is entirely incorrect, blank, or irrelevant.

In "feedback", provide a brief 1-2 sentence explanation. If partial credit was awarded, clearly state which parts were correct and which parts need correction.
CRUCIAL: You MUST enclose ALL mathematical expressions, numbers, fractions, and currency amounts inside your feedback with LaTeX dollar signs (e.g., $x^2$, $130/10$, $\\$$40). Do NOT use asterisks for math.
Do NOT wrap plain English words or labels in LaTeX tags.
Return your response STRICTLY as a JSON object with keys: "is_correct" (boolean), "score_fraction" (number from 0.0 to 1.0), and "feedback" (string).`;

        const parts: any[] = [{ text: prompt }, ...vision.imageParts];

        if (Array.isArray(solution_snapshots)) {
          let snapshotChars = 0;
          for (const snap of solution_snapshots.slice(0, 5)) {
            if (typeof snap !== 'string') continue;
            const match = snap.match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i);
            if (
              match
              && /^(?:image\/(?:png|jpe?g|gif|webp))$/i.test(match[1])
              && snapshotChars + match[2].length <= MAX_VISION_IMAGE_CHARS
            ) {
              parts.push({ inlineData: { data: match[2], mimeType: match[1] } });
              snapshotChars += match[2].length;
            }
          }
        }

        const primaryModel = getRealModelName((quiz as any).model_name || 'gemini-3.5-flash-lite');
        const fallbackCandidates = [
          'gemini-3.5-flash-lite',
          'gemini-3.1-flash-lite',
          'gemini-3.6-flash',
          'gemini-3.5-flash',
          'gemini-2.5-flash'
        ];
        const modelsToTry = [primaryModel, ...fallbackCandidates.filter(m => m !== primaryModel)];

        let gradeSuccess = false;
        for (const client of clientsToTry) {
          if (gradeSuccess) break;
          for (const modelName of modelsToTry) {
            try {
              const response = await client.models.generateContent({
                model: modelName,
                contents: [{ role: 'user', parts }],
                config: {
                  responseMimeType: 'application/json',
                  responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                      is_correct: { type: Type.BOOLEAN },
                      score_fraction: { type: Type.NUMBER },
                      feedback: { type: Type.STRING }
                    },
                    required: ['is_correct', 'score_fraction', 'feedback']
                  }
                }
              });

              const parsed = safeParseJSON(response.text ? response.text.trim() : '{}');
              if (parsed && (typeof parsed.is_correct === 'boolean' || typeof parsed.score_fraction === 'number')) {
                let sf = typeof parsed.score_fraction === 'number'
                  ? parsed.score_fraction
                  : (parsed.is_correct ? 1 : 0);
                sf = Math.max(0, Math.min(1, sf));
                scoreFraction = sf;
                isCorrect = typeof parsed.is_correct === 'boolean' ? parsed.is_correct : (sf === 1);
                if (sf === 1) isCorrect = true;
                aiFeedback = typeof parsed.feedback === 'string' ? parsed.feedback : '';
                gradeSuccess = true;
                break;
              }
            } catch (modelErr) {
              console.warn(`AI grading model ${modelName} failed, trying fallback:`, modelErr);
            }
          }
        }

        if (!gradeSuccess) {
          aiFeedback = isCorrect ? '' : 'AI semantic grading was temporarily unavailable across models; exact-match grading was used.';
        }
      } catch (err) {
        console.error('AI individual grading error:', err);
        aiFeedback = isCorrect ? '' : 'AI semantic grading failed; exact-match grading was used.';
      } finally {
        semanticSlot?.release();
      }
    } else if (!semanticSlot) {
      aiFeedback = isCorrect
        ? ''
        : 'AI semantic grading is busy or temporarily limited; exact-match grading was used. Please retry.';
    } else {
      aiFeedback = isCorrect ? '' : 'AI semantic grading is unavailable; exact-match grading was used.';
      semanticSlot.release();
    }
  } else if (isCorrect && (qType === 'open_ended' || qType === 'graphing')) {
    aiFeedback = 'Great work!';
  }

  const gradeProof = createGradeProof({
    quizId: quiz_id,
    questionIndex,
    question: q,
    studentAnswer: actual,
    isCorrect,
    scoreFraction
  });

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    success: true,
    is_correct: isCorrect,
    correct_answer: (quiz as any).quiz_mode === 'back_and_forth' ? null : expected,
    score_fraction: scoreFraction,
    ai_feedback: aiFeedback,
    grade_proof: gradeProof
  });
});

router.post(
  ['/submit', '/api/submit_quiz'],
  publicRateLimit('submit', 120, 60 * 60 * 1_000),
  async (req, res) => {
  const {
    quiz_id,
    session_id,
    student_name,
    answers = {},
    graded_details,
    total_score,
    time_active_seconds,
    time_paused_seconds,
    total_duration_seconds,
    accuracy_pct,
    solution_snapshots,
    submission_status,
    status
  } = req.body || {};
  if (!validRecordId(quiz_id)) {
    return res.status(400).json({ success: false, error: 'Invalid quiz_id' });
  }
  if (session_id !== undefined && session_id !== null && !validRecordId(session_id)) {
    return res.status(400).json({ success: false, error: 'Invalid session_id' });
  }
  const quiz = quizzes.get(quiz_id);
  if (!quiz) {
    return res.status(404).json({ success: false, error: 'Quiz not found' });
  }
  const submittedDetails = Array.isArray(graded_details) ? graded_details : [];
  let finalDetails: any[] = [];

  if (quiz) {
    finalDetails = quiz.questions.map((q: any, i: number) => {
      const submitted = submittedDetails[i] && typeof submittedDetails[i] === 'object'
        ? submittedDetails[i]
        : null;
      const hasSubmittedAnswer = submitted && Object.prototype.hasOwnProperty.call(submitted, 'user_answer');
      const hasLegacyAnswer = answers && Object.prototype.hasOwnProperty.call(answers, i);
      const userAns = hasSubmittedAnswer
        ? submitted.user_answer
        : (hasLegacyAnswer ? answers[i] : 'No Answer');
      return authoritativeDetail(q, submitted, userAns, quiz_id, i);
    });
  } else {
    finalDetails = submittedDetails.map((item: any) => {
      if (!item || typeof item !== 'object') return item;
      const scoreFraction = Math.max(0, Math.min(1, finiteNumber(
        item.score_fraction,
        item.is_correct ? 1 : 0
      )));
      return { ...item, score_fraction: scoreFraction };
    });
  }

  const calculatedScore = finalDetails.reduce(
    (sum, item) => sum + (item ? finiteNumber(item.score_fraction, item.is_correct ? 1 : 0) : 0),
    0
  );
  const finalScore = finalDetails.length > 0 ? calculatedScore : finiteNumber(total_score, 0);
  const maxScore = quiz
    ? quiz.questions.length
    : Math.max(1, finalDetails.length || finiteNumber(req.body?.max_score ?? req.body?.total, 1));
  const progressiveResultId = session_id ? `res_${session_id}` : '';
  const existingProgress = progressiveResultId
    ? results.get(progressiveResultId) as any
    : null;
  const canFinalizeProgress = Boolean(
    existingProgress
    && existingProgress.is_in_progress === true
    && existingProgress.quiz_id === quiz_id
    && existingProgress.session_id === session_id
  );
  const resultId = canFinalizeProgress ? progressiveResultId : createUniqueResultId();
  const resultAccess = createResultAccessToken();
  const createdAt = canFinalizeProgress
    ? String(existingProgress.created_at || existingProgress.timestamp || new Date().toISOString())
    : new Date().toISOString();
  const finalAccuracy = maxScore > 0 ? (finalScore / maxScore) * 100 : 0;
  const finalStatus = String(submission_status || status || 'completed').toLowerCase();
  const normalizedStatus = ['completed', 'early', 'terminated'].includes(finalStatus)
    ? finalStatus
    : 'completed';
  const completionNote = normalizedStatus === 'early'
    ? 'Left without finishing'
    : (normalizedStatus === 'terminated' ? 'Terminated by teacher' : '');
  const storedAnswers = Object.fromEntries(
    finalDetails.map((detail, index) => [index, detail?.user_answer ?? 'No Answer'])
  );
  const sanitizedSnapshots = sanitizeSolutionSnapshots(solution_snapshots, quiz.questions.length);
  const mergedSnapshots = {
    ...(existingProgress?.solution_snapshots || {}),
    ...(sanitizedSnapshots || {})
  };
  const resultObj = {
    id: resultId,
    quiz_id: quiz_id || 'quiz_1',
    ...(session_id ? { session_id } : {}),
    quiz_title: quiz ? quiz.title : 'Quiz Results',
    student_name: sanitizeStudentName(student_name),
    total_score: finalScore,
    max_score: maxScore,
    graded_details: finalDetails,
    created_at: createdAt,
    // Legacy aliases are intentionally persisted for older AI Studio builds.
    score: finalScore,
    total: maxScore,
    details: finalDetails,
    timestamp: createdAt,
    answers: storedAnswers,
    ...(Object.keys(mergedSnapshots).length > 0 ? { solution_snapshots: mergedSnapshots } : {}),
    time_active_seconds: boundedNumber(time_active_seconds, 0, 0, MAX_RECORDED_DURATION_SECONDS),
    time_paused_seconds: boundedNumber(time_paused_seconds, 0, 0, MAX_RECORDED_DURATION_SECONDS),
    total_duration_seconds: boundedNumber(total_duration_seconds, 0, 0, MAX_RECORDED_DURATION_SECONDS),
    accuracy_pct: finalAccuracy,
    completion_note: completionNote,
    is_in_progress: false,
    access_token_hash: resultAccess.hash
  };

  results.set(resultId, resultObj as any);
  savePersistentData();
  await syncDocToFirestore('results', resultId, resultObj);

  // Broadcast to results page about final submission
  const io = req.app.get('io');
  if (io) {
    io.to(`quiz_${quiz_id}`).emit('progressive_result_update', { result_id: resultId });
  }

  const forwardedProtocol = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  res.cookie(resultAccessCookieName(resultId), resultAccess.token, {
    httpOnly: true,
    secure: Boolean(req.secure || forwardedProtocol === 'https'),
    sameSite: 'lax',
    path: '/',
    maxAge: 6 * 60 * 60 * 1_000
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    success: true,
    result_id: resultId,
    total_score: finalScore,
    max_score: maxScore,
    score: finalScore,
    total: maxScore,
    graded_details: finalDetails,
    details: finalDetails,
    result_access_token: resultAccess.token
  });
});

router.post(
  '/api/save_progressive_result',
  publicRateLimit('progressive', 1_200, 10 * 60 * 1_000),
  async (req, res) => {
  const {
    quiz_id,
    session_id,
    student_name,
    progressive_results,
    solution_snapshots,
    time_active_seconds,
    time_paused_seconds,
    total_duration_seconds
  } = req.body || {};
  if (!quiz_id || !session_id) {
    return res.status(400).json({ success: false, error: 'Missing quiz_id or session_id' });
  }
  if (!validRecordId(quiz_id) || !validRecordId(session_id)) {
    return res.status(400).json({ success: false, error: 'Invalid quiz_id or session_id' });
  }

  const quiz = quizzes.get(quiz_id);
  if (!quiz) {
    return res.status(404).json({ success: false, error: 'Quiz not found' });
  }
  const resultId = `res_${session_id}`;
  const existing = results.get(resultId) as any;
  if (
    existing
    && (existing.quiz_id !== quiz_id || existing.session_id !== session_id)
  ) {
    return res.status(409).json({
      success: false,
      error: 'This session ID is already associated with a different quiz or result.'
    });
  }
  if (existing && existing.is_in_progress !== true) {
    return res.json({ success: true, result_id: resultId, ignored: true });
  }

  const submittedDetails = Array.isArray(progressive_results)
    ? progressive_results.slice(0, quiz.questions.length)
    : [];
  const details = quiz.questions.map((question: any, index: number) => {
    const submitted = submittedDetails[index];
    if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) return null;
    if (!Object.prototype.hasOwnProperty.call(submitted, 'user_answer')) return null;
    return authoritativeDetail(question, submitted, submitted.user_answer, quiz_id, index);
  });
  const totalScore = details.reduce(
    (sum, item) => sum + (item ? finiteNumber(item.score_fraction, item.is_correct ? 1 : 0) : 0),
    0
  );
  const maxScore = quiz.questions.length;
  const createdAt = existing?.created_at || existing?.timestamp || new Date().toISOString();
  const resultAccuracy = maxScore > 0 ? (totalScore / maxScore) * 100 : 0;
  const sanitizedSnapshots = sanitizeSolutionSnapshots(solution_snapshots, quiz.questions.length);
  const mergedSnapshots = {
    ...(existing?.solution_snapshots || {}),
    ...(sanitizedSnapshots || {})
  };
  const resultObj = {
    id: resultId,
    quiz_id,
    session_id,
    quiz_title: quiz ? quiz.title : 'Quiz Results',
    student_name: sanitizeStudentName(student_name),
    total_score: totalScore,
    max_score: maxScore,
    graded_details: details,
    created_at: createdAt,
    score: totalScore,
    total: maxScore,
    details,
    timestamp: createdAt,
    ...(Object.keys(mergedSnapshots).length > 0 ? { solution_snapshots: mergedSnapshots } : {}),
    time_active_seconds: boundedNumber(time_active_seconds, 0, 0, MAX_RECORDED_DURATION_SECONDS),
    time_paused_seconds: boundedNumber(time_paused_seconds, 0, 0, MAX_RECORDED_DURATION_SECONDS),
    total_duration_seconds: boundedNumber(total_duration_seconds, 0, 0, MAX_RECORDED_DURATION_SECONDS),
    accuracy_pct: resultAccuracy,
    is_in_progress: true
  };

  results.set(resultId, resultObj as any);
  savePersistentData();
  void syncDocToFirestore('results', resultId, resultObj as any).catch((err) => {
    console.warn(`[Firebase] Progressive result sync failed for ${resultId}:`, err);
  });

  const io = req.app.get('io');
  if (io) {
    io.to(`quiz_${quiz_id}`).emit('progressive_result_update', { result_id: resultId });
  }

  res.json({
    success: true,
    result_id: resultId,
    total_score: totalScore,
    max_score: maxScore,
    accuracy_pct: resultAccuracy
  });
});

router.post(
  '/api/explain',
  optionalAuth,
  publicRateLimit('explain', 30, 10 * 60 * 1_000),
  async (req: AuthRequest, res) => {
  const {
    quiz_id,
    q_index,
    grade_proof,
    user_answer,
    api_key,
    model_name = 'gemini-3.5-flash-lite'
  } = req.body || {};
  const questionIndex = Number(q_index);
  const quiz = validRecordId(quiz_id) ? quizzes.get(quiz_id) : null;
  const quizQuestion = quiz
    && Number.isInteger(questionIndex)
    && questionIndex >= 0
    && quiz.questions?.[questionIndex]
    ? quiz.questions[questionIndex]
    : null;
  const safeStudentAnswer = sanitizeStudentAnswer(user_answer);
  const verifiedGrade = quizQuestion
    ? verifyGradeProof(grade_proof, {
      quizId: quiz_id,
      questionIndex,
      question: quizQuestion,
      studentAnswer: safeStudentAnswer
    })
    : null;
  const isTeacher = req.user?.role === 'teacher' || req.user?.role === 'admin';
  const suppliedApiKey = typeof api_key === 'string' ? api_key.trim().slice(0, 512) : '';
  const canUseServerKey = Boolean(verifiedGrade || isTeacher);
  const question = quizQuestion
    ? quizQuestion.question
    : String(req.body?.question ?? '').slice(0, MAX_ANSWER_LENGTH);
  const correct_answer = quizQuestion
    ? getCorrectAnswer(quizQuestion)
    : sanitizeStudentAnswer(req.body?.correct_answer);

  const ai = suppliedApiKey || canUseServerKey
    ? getGeminiClient(suppliedApiKey)
    : null;

  if (ai) {
    try {
      const vision = extractQuestionVision(question);
      const prompt = `Explain clearly and concisely in 2-3 sentences why the student's answer was incorrect for this quiz question and how to solve or get the correct answer.
Question: ${JSON.stringify(vision.questionText.slice(0, MAX_ANSWER_LENGTH))}
Student's Answer: ${JSON.stringify(safeStudentAnswer)}
Correct Answer: ${JSON.stringify(correct_answer)}

CRUCIAL: You MUST enclose ALL mathematical expressions, numbers, fractions, and currency amounts inside your explanation with LaTeX dollar signs (e.g., $x^2$, $130/10$, $\$$40). Do NOT use asterisks for math. Do NOT wrap plain English words or labels in LaTeX tags.
Return STRICTLY one JSON object in this shape: {"explanation":"your concise explanation"}.`;

      const response = await ai.models.generateContent({
        model: getRealModelName(model_name),
        contents: [{ role: 'user', parts: [{ text: prompt }, ...vision.imageParts] }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              explanation: { type: Type.STRING }
            },
            required: ['explanation']
          }
        }
      });
      const parsed = safeParseJSON(response.text || '');
      if (!parsed || typeof parsed.explanation !== 'string' || !parsed.explanation.trim()) {
        throw new Error('Gemini returned an invalid explanation response');
      }
      return res.json({
        success: true,
        explanation: parsed.explanation.slice(0, MAX_FEEDBACK_LENGTH)
      });
    } catch (err: any) {
      console.warn('Gemini explain fallback:', err);
    }
  }

  return res.json({
    success: true,
    explanation: 'An AI explanation is unavailable right now. Compare your response with the displayed correct answer, then review the worked solution or ask your teacher for the missing reasoning.',
    ai_unavailable: true
  });
});

router.post('/api/reformat_answer', (req, res) => {
  const { answer } = req.body || {};
  res.json({ success: true, formatted: String(answer ?? '').trim() });
});

export default router;
