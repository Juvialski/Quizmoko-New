import { Router } from 'express';
import { optionalAuth, tokenRequired } from '../middleware/auth.ts';
import type { AuthRequest } from '../middleware/auth.ts';
import {
  quizzes,
  results,
  deleteDocFromFirestore,
  savePersistentData,
  syncDocToFirestore,
  getQuizTimestamp
} from '../store/db.ts';
import {
  canonicalQuestionType,
  getCorrectAnswer,
  gradeQuestionLocally
} from '../services/grading.ts';
import {
  createResultAccessToken,
  resultAccessCookieName,
  verifyResultAccessToken
} from '../services/resultAccess.ts';

const router = Router();

function canManageQuiz(user: any, quiz: any): boolean {
  if (!user || !quiz) return false;
  if (user.role === 'admin') return true;
  if (quiz.user_id && quiz.user_id === user.uid) return true;
  return !quiz.user_id && user.uid === 'teacher_test';
}

function canManageResult(user: any, result: any): boolean {
  if (!user || !result) return false;
  if (user.role === 'admin') return true;
  if (result.user_id && result.user_id === user.uid) return true;
  return canManageQuiz(user, quizzes.get(result.quiz_id));
}

function requestResultAccessToken(req: any, resultId: string): string {
  const queryToken = typeof req.query?.access_token === 'string' ? req.query.access_token : '';
  const headerToken = typeof req.headers?.['x-result-access-token'] === 'string'
    ? req.headers['x-result-access-token']
    : '';
  const cookieToken = req.cookies?.[resultAccessCookieName(resultId)];
  return queryToken || headerToken || (typeof cookieToken === 'string' ? cookieToken : '');
}

function isLegacyCapabilityResult(result: any, resultId: string): boolean {
  // Older Firestore documents used 20-character random document IDs as the
  // capability URL and predate per-result token hashes. Keep only that
  // high-entropy legacy contract; new `res_*`/progressive IDs remain private.
  return Boolean(
    result
    && !result.access_token_hash
    && result.is_in_progress !== true
    && /^[A-Za-z0-9]{20}$/.test(resultId)
  );
}

function hasResultAccess(req: any, result: any, resultId: string): boolean {
  return canManageResult(req.user, result)
    || isLegacyCapabilityResult(result, resultId)
    || verifyResultAccessToken(requestResultAccessToken(req, resultId), result?.access_token_hash);
}

function setResultAccessCookie(req: any, res: any, resultId: string, token: string) {
  const forwardedProtocol = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  res.cookie(resultAccessCookieName(resultId), token, {
    httpOnly: true,
    secure: Boolean(req.secure || forwardedProtocol === 'https'),
    sameSite: 'lax',
    path: '/',
    maxAge: 6 * 60 * 60 * 1000
  });
}

function finiteNumber(value: any, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resultDetails(result: any): any[] {
  if (Array.isArray(result?.graded_details)) return result.graded_details;
  if (Array.isArray(result?.details)) return result.details;
  return [];
}

function resultScore(result: any): number {
  if (result?.total_score !== undefined && result?.total_score !== null) {
    return finiteNumber(result.total_score, 0);
  }
  return finiteNumber(result?.score, 0);
}

function resultTotal(result: any, details = resultDetails(result)): number {
  if (result?.max_score !== undefined && result?.max_score !== null) {
    return finiteNumber(result.max_score, details.length);
  }
  if (result?.total !== undefined && result?.total !== null) {
    return finiteNumber(result.total, details.length);
  }
  return details.length;
}

function timestampIso(value: any): string {
  const millis = getQuizTimestamp({ created_at: value });
  if (millis > 0) return new Date(millis).toISOString();
  if (typeof value === 'string' && value.trim()) return value;
  return new Date().toISOString();
}

function enrichDetails(rawResult: any): any[] {
  const quiz = quizzes.get(rawResult?.quiz_id);
  return resultDetails(rawResult).map((item: any, index: number) => {
    if (!item || typeof item !== 'object') return item;
    const quizQuestion = quiz?.questions?.[index];
    const qText = item.question || (quizQuestion ? (quizQuestion.question || quizQuestion.raw_text || quizQuestion.statement) : '');
    return {
      ...item,
      question: qText,
      type: item.type || (quizQuestion ? canonicalQuestionType(quizQuestion) : undefined)
    };
  });
}

function withResultAliases(rawResult: any, fallbackId = ''): any {
  const { access_token_hash: _accessTokenHash, ...safeResult } = rawResult || {};
  const details = enrichDetails(rawResult);
  const score = resultScore(rawResult);
  const total = resultTotal(rawResult, details);
  const createdAt = rawResult?.created_at ?? rawResult?.timestamp ?? new Date().toISOString();
  const accuracy = rawResult?.accuracy_pct !== undefined && rawResult?.accuracy_pct !== null
    ? finiteNumber(rawResult.accuracy_pct, 0)
    : (total > 0 ? (score / total) * 100 : 0);

  return {
    ...safeResult,
    id: rawResult?.id || fallbackId,
    total_score: score,
    max_score: total,
    graded_details: details,
    created_at: createdAt,
    score,
    total,
    details,
    timestamp: rawResult?.timestamp ?? createdAt,
    accuracy_pct: accuracy
  };
}

function recalculateResult(rawResult: any): any {
  const details = resultDetails(rawResult);
  const score = details.reduce((sum, item) => (
    sum + (item ? finiteNumber(item.score_fraction, item.is_correct ? 1 : 0) : 0)
  ), 0);
  const total = resultTotal(rawResult, details);
  rawResult.total_score = score;
  rawResult.max_score = total;
  rawResult.graded_details = details;
  rawResult.score = score;
  rawResult.total = total;
  rawResult.details = details;
  rawResult.accuracy_pct = total > 0 ? (score / total) * 100 : 0;
  return rawResult;
}

router.get('/api/get_result/:result_id', optionalAuth, (req: AuthRequest, res) => {
  const result = results.get(req.params.result_id);
  if (!result || !hasResultAccess(req, result, req.params.result_id)) {
    return res.status(404).json({ success: false, error: 'Result not found' });
  }
  const token = requestResultAccessToken(req, req.params.result_id);
  if (token && verifyResultAccessToken(token, (result as any).access_token_hash)) {
    setResultAccessCookie(req, res, req.params.result_id, token);
  }
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(withResultAliases(result, req.params.result_id));
});

router.post('/api/results/:result_id/edit_answer', tokenRequired, async (req: AuthRequest, res) => {
  const result = results.get(req.params.result_id) as any;
  if (!result) {
    return res.status(404).json({ success: false, error: 'Result not found' });
  }
  if (!canManageResult(req.user, result)) {
    return res.status(403).json({ success: false, error: 'You do not have access to this result' });
  }

  const questionIndex = Number(req.body?.q_index);
  const details = resultDetails(result);
  if (!Number.isInteger(questionIndex) || questionIndex < 0 || !details[questionIndex]) {
    return res.status(400).json({ success: false, error: 'Invalid question index' });
  }

  const detail = details[questionIndex];
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'new_correct_answer')) {
    detail.correct_answer = req.body.new_correct_answer;
  } else if (Object.prototype.hasOwnProperty.call(req.body || {}, 'new_answer')) {
    // Preserve the legacy contract where new_answer meant the submitted answer.
    detail.user_answer = req.body.new_answer;
  } else {
    return res.status(400).json({ success: false, error: 'Missing new answer value' });
  }
  if (req.body?.is_correct !== undefined) detail.is_correct = Boolean(req.body.is_correct);

  recalculateResult(result);
  results.set(req.params.result_id, result);
  savePersistentData();
  await syncDocToFirestore('results', req.params.result_id, result);
  return res.json({ success: true, result: withResultAliases(result, req.params.result_id) });
});

router.post('/api/results/:result_id/recheck', tokenRequired, async (req: AuthRequest, res) => {
  const result = results.get(req.params.result_id) as any;
  if (!result) {
    return res.status(404).json({ success: false, error: 'Result not found' });
  }
  if (!canManageResult(req.user, result)) {
    return res.status(403).json({ success: false, error: 'You do not have access to this result' });
  }

  const questionIndex = Number(req.body?.q_index);
  const details = resultDetails(result);
  const detail = details[questionIndex];
  if (!Number.isInteger(questionIndex) || questionIndex < 0 || !detail) {
    return res.status(400).json({ success: false, error: 'Invalid question index' });
  }

  const quizQuestion: any = quizzes.get(result.quiz_id)?.questions?.[questionIndex] || {};
  const gradingQuestion = {
    ...quizQuestion,
    type: detail.type || quizQuestion.type,
    answer: Object.prototype.hasOwnProperty.call(detail, 'correct_answer')
      ? detail.correct_answer
      : getCorrectAnswer(quizQuestion)
  };
  const grade = gradeQuestionLocally(gradingQuestion, detail.user_answer);

  if (grade.requiresSemanticGrading) {
    return res.status(422).json({
      success: false,
      error: 'This answer requires semantic AI grading and cannot be honestly rechecked with exact matching.'
    });
  }

  detail.is_correct = grade.isCorrect;
  detail.score_fraction = grade.scoreFraction;
  detail.type = grade.questionType;
  detail.correct_answer = grade.correctAnswer;
  recalculateResult(result);
  results.set(req.params.result_id, result);
  savePersistentData();
  await syncDocToFirestore('results', req.params.result_id, result);

  return res.json({
    success: true,
    is_correct: grade.isCorrect,
    score_fraction: grade.scoreFraction,
    ai_feedback: detail.ai_feedback || '',
    result: withResultAliases(result, req.params.result_id)
  });
});

router.post('/api/results/:result_id/reprocess_answers', tokenRequired, async (req: AuthRequest, res) => {
  const result = results.get(req.params.result_id) as any;
  if (!result) {
    return res.status(404).json({ success: false, error: 'Result not found' });
  }
  if (!canManageResult(req.user, result)) {
    return res.status(403).json({ success: false, error: 'You do not have access to this result' });
  }

  const details = resultDetails(result);
  const requestedIndex = req.body?.q_index;
  const indexes = requestedIndex === null || requestedIndex === undefined
    ? details.map((_item, index) => index)
    : [Number(requestedIndex)];

  if (indexes.some(index => !Number.isInteger(index) || index < 0 || !details[index])) {
    return res.status(400).json({ success: false, error: 'Invalid question index' });
  }

  // This endpoint is formatting-only. It must never fabricate a new answer key.
  for (const index of indexes) {
    const detail = details[index];
    if (typeof detail.correct_answer === 'string') {
      detail.correct_answer = detail.correct_answer.replace(/\r\n/g, '\n').trim();
    }
  }

  recalculateResult(result);
  results.set(req.params.result_id, result);
  savePersistentData();
  await syncDocToFirestore('results', req.params.result_id, result);
  return res.json({
    success: true,
    details: enrichDetails(result),
    result: withResultAliases(result, req.params.result_id)
  });
});

router.post('/api/results/:result_id/share_token', tokenRequired, async (req: AuthRequest, res) => {
  const result = results.get(req.params.result_id) as any;
  if (!result) {
    return res.status(404).json({ success: false, error: 'Result not found' });
  }
  if (!canManageResult(req.user, result)) {
    return res.status(403).json({ success: false, error: 'You do not have access to this result' });
  }

  const access = createResultAccessToken();
  result.access_token_hash = access.hash;
  results.set(req.params.result_id, result);
  savePersistentData();
  await syncDocToFirestore('results', req.params.result_id, result);
  return res.json({ success: true, result_access_token: access.token });
});

router.post('/api/delete_results', tokenRequired, async (req: AuthRequest, res) => {
  const singular = req.body?.result_id;
  const plural = Array.isArray(req.body?.result_ids) ? req.body.result_ids : [];
  const requestedIds = [...plural, ...(singular ? [singular] : [])]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  const ids = Array.from(new Set(requestedIds));
  if (ids.length === 0) {
    return res.status(400).json({ success: false, error: 'No result IDs supplied' });
  }
  const inaccessible = ids.some(id => {
    const result = results.get(id);
    return result && !canManageResult(req.user, result);
  });
  if (inaccessible) {
    return res.status(403).json({ success: false, error: 'You do not have access to one or more results' });
  }

  const deletedIds = ids.filter(id => results.delete(id));
  if (deletedIds.length > 0) {
    savePersistentData();
    await Promise.all(deletedIds.map(id => deleteDocFromFirestore('results', id)));
  }
  res.json({ success: true, deleted_count: deletedIds.length, deleted_ids: deletedIds });
});

router.get('/results/:id', tokenRequired, (req: AuthRequest, res) => {
  const id = req.params.id;
  const rawResult = results.get(id);
  if (rawResult && !canManageResult(req.user, rawResult)) {
    return res.status(403).send('You do not have access to this result');
  }

  const formatResult = (r: any) => {
    const normalized = withResultAliases(r, id);
    const displayTimestamp = timestampIso(normalized.created_at ?? normalized.timestamp);
    return {
      id: normalized.id || id,
      quiz_id: normalized.quiz_id,
      quiz_title: normalized.quiz_title || 'Quiz Results',
      student_name: normalized.student_name || 'Student',
      score: normalized.score,
      total: normalized.total,
      accuracy_pct: Math.round(normalized.accuracy_pct),
      details: normalized.details,
      created_at: displayTimestamp,
      timestamp: displayTimestamp,
      completion_note: normalized.completion_note !== undefined
        ? normalized.completion_note
        : (normalized.is_in_progress ? 'In Progress' : ''),
      time_active_seconds: finiteNumber(normalized.time_active_seconds, 0),
      time_paused_seconds: finiteNumber(normalized.time_paused_seconds, 0),
      total_duration_seconds: finiteNumber(normalized.total_duration_seconds, 0)
    };
  };

  if (rawResult) {
    const formatted = formatResult(rawResult);
    return res.render('results', { results: [formatted], result: formatted, title: formatted.quiz_title });
  }

  const quiz = quizzes.get(id);
  if (quiz) {
    if (!canManageQuiz(req.user, quiz)) {
      return res.status(403).send('You do not have access to this quiz');
    }
    const allResults = Array.from(results.values()).filter(r => r.quiz_id === id);
    if (allResults.length > 0) {
      const formattedResults = allResults
        .map(formatResult)
        .sort((a, b) => getQuizTimestamp(b) - getQuizTimestamp(a));
      return res.render('results', { results: formattedResults, result: formattedResults[0], title: quiz.title });
    } else {
      return res.render('results', { results: [], result: null, title: quiz.title });
    }
  }

  res.status(404).send('Result not found');
});

router.get(['/solutions/:result_id', '/view_solutions/:quiz_id'], optionalAuth, (req: AuthRequest, res) => {
  const id = req.params.result_id || req.params.quiz_id;
  const rawResult = results.get(id);
  const quiz = quizzes.get(id) || (rawResult?.quiz_id ? quizzes.get(rawResult.quiz_id) : null);
  if (!rawResult && !quiz) {
    return res.status(404).send('Result not found');
  }
  if (rawResult) {
    if (!hasResultAccess(req, rawResult, id)) {
      return res.status(404).send('Result not found');
    }
    const token = requestResultAccessToken(req, id);
    if (token && verifyResultAccessToken(token, (rawResult as any).access_token_hash)) {
      setResultAccessCookie(req, res, id, token);
      if (typeof req.query.access_token === 'string') {
        const remainingQuery = new URLSearchParams();
        for (const [key, value] of Object.entries(req.query)) {
          if (key === 'access_token') continue;
          if (typeof value === 'string') remainingQuery.append(key, value);
        }
        const suffix = remainingQuery.toString();
        return res.redirect(302, `${req.path}${suffix ? `?${suffix}` : ''}`);
      }
    }
  } else if (!canManageQuiz(req.user, quiz)) {
    return res.status(404).send('Result not found');
  }

  const formatSolutionResult = (r: any) => {
    if (r) {
      const normalized = withResultAliases(r, id);
      return {
        ...normalized,
        timestamp: timestampIso(normalized.created_at ?? normalized.timestamp),
        details: normalized.details,
        solution_snapshots: normalized.solution_snapshots || {}
      };
    }

    const questions = quiz && Array.isArray(quiz.questions) ? quiz.questions : [];
    return {
      id: `res_sol_${id}`,
      quiz_id: quiz ? quiz.id : id,
      quiz_title: quiz ? quiz.title : 'Quiz Solutions',
      student_name: 'Student',
      score: questions.length,
      total: questions.length,
      timestamp: new Date().toISOString(),
      solution_snapshots: {},
      details: questions.map((q: any) => {
        const correctAnswer = getCorrectAnswer(q);
        return {
          question: q.question,
          type: canonicalQuestionType(q),
          user_answer: correctAnswer,
          correct_answer: correctAnswer,
          is_correct: true,
          score_fraction: 1
        };
      })
    };
  };

  const formatted = formatSolutionResult(rawResult);

  res.setHeader('Cache-Control', 'private, no-store');
  res.render('view_solutions', {
    result: formatted,
    quiz: quiz || { title: formatted.quiz_title, questions: [] },
    title: formatted.quiz_title,
    session: { user: req.user }
  });
});

export default router;
