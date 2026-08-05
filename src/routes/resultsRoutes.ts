import { Router } from 'express';
import { optionalAuth, tokenRequired } from '../middleware/auth.ts';
import type { AuthRequest } from '../middleware/auth.ts';
import { getQuizCreatorGeminiClients } from '../services/quizCreatorAi.ts';
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
  gradeQuestionLocally,
  normalizeGradeScore,
  normalizeQuestion,
  scoreQuizDetails
} from '../services/grading.ts';
import { gradeSemanticQuestion } from '../services/semanticGrading.ts';
import {
  createAnswerDigest,
  createGradeProof,
  createQuestionDigest,
  createSnapshotDigest,
  sanitizeSnapshotsForDigest
} from '../services/gradeProof.ts';
import { withAttemptLock } from '../services/resultSession.ts';
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
  if (
    user.role === 'student' &&
    result.student_name &&
    ((user.name && result.student_name.trim().toLowerCase() === user.name.trim().toLowerCase()) ||
     (user.email && result.student_name.trim().toLowerCase() === user.email.trim().toLowerCase()))
  ) {
    return true;
  }
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
  if (canManageResult(req.user, result)) return true;
  if (isLegacyCapabilityResult(result, resultId)) return true;
  if (verifyResultAccessToken(requestResultAccessToken(req, resultId), result?.access_token_hash)) return true;
  if (req.user && result) {
    if (result.user_id && result.user_id === req.user.uid) return true;
    if (
      result.student_name &&
      ((req.user.name && result.student_name.trim().toLowerCase() === req.user.name.trim().toLowerCase()) ||
       (req.user.email && result.student_name.trim().toLowerCase() === req.user.email.trim().toLowerCase()))
    ) {
      return true;
    }
  }
  return false;
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
      type: item.type || (quizQuestion ? canonicalQuestionType(quizQuestion) : undefined),
      solution: item.solution || quizQuestion?.solution || ''
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
    : (total > 0
        ? Math.round((((score / total) * 100) + Number.EPSILON) * 10_000) / 10_000
        : 0);

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
  const quiz = quizzes.get(rawResult?.quiz_id);
  // Finalized attempts are historical records: formatting or metadata repairs
  // must not silently rescore them against a later edit of the quiz.  A teacher
  // recheck updates the selected detail explicitly before this calculation.
  const summary = rawResult?.is_in_progress === true && quiz
    ? scoreQuizDetails(quiz.questions, details)
    : null;
  const historical = details.reduce((acc, item) => {
    if (!item) return acc;
    const points = Math.max(0, finiteNumber(item.points, 1));
    acc.max += points;
    if (!item.grade_status || item.grade_status === 'graded') {
      const fraction = normalizeGradeScore(item.score_fraction ?? (item.is_correct ? 1 : 0)) ?? 0;
      acc.earned += Math.round((points * fraction + Number.EPSILON) * 10_000) / 10_000;
    }
    return acc;
  }, { earned: 0, max: 0 });
  const score = summary?.earned_points
    ?? Math.round((historical.earned + Number.EPSILON) * 10_000) / 10_000;
  const total = summary?.max_points
    ?? Math.round((historical.max + Number.EPSILON) * 10_000) / 10_000;
  rawResult.total_score = score;
  rawResult.max_score = total;
  rawResult.graded_details = details;
  rawResult.score = score;
  rawResult.total = total;
  rawResult.details = details;
  rawResult.accuracy_pct = summary?.accuracy_pct ?? (
    total > 0
      ? Math.round((((score / total) * 100) + Number.EPSILON) * 10_000) / 10_000
      : 0
  );
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

  // Legacy clients used this route to write a new key/correctness flag directly
  // into a result.  Keep the route discoverable, but never accept grade-bearing
  // fields from a browser.  Teachers must correct the authoritative quiz and use
  // the server-side recheck workflow.
  return res.status(409).json({
    success: false,
    error: 'Direct result answer-key and correctness edits are disabled. Correct the authoritative quiz for future attempts; a historical regrade requires the explicit version-change acknowledgement in Re-check.'
  });
});

router.post('/api/results/:result_id/recheck', tokenRequired, async (req: AuthRequest, res) => {
  const original = results.get(req.params.result_id) as any;
  if (!original) return res.status(404).json({ success: false, error: 'Result not found' });
  if (!canManageResult(req.user, original)) {
    return res.status(403).json({ success: false, error: 'You do not have access to this result' });
  }

  const questionIndex = Number(req.body?.q_index);
  if (!Number.isInteger(questionIndex) || questionIndex < 0) {
    return res.status(400).json({ success: false, error: 'Invalid question index' });
  }

  const attemptSessionId = String(original.session_id || original.id || req.params.result_id);
  return withAttemptLock(original.quiz_id, attemptSessionId, async () => {
    const latest = results.get(req.params.result_id) as any;
    if (!latest || !canManageResult(req.user, latest)) {
      return res.status(404).json({ success: false, error: 'Result not found' });
    }
    const working = structuredClone(latest);
    const details = resultDetails(working);
    const detail = details[questionIndex];
    if (!detail) return res.status(400).json({ success: false, error: 'Invalid question index' });

    const quiz = quizzes.get(working.quiz_id);
    const quizQuestion = quiz?.questions?.[questionIndex];
    const normalized = normalizeQuestion(quizQuestion);
    if (!quiz || !quizQuestion || !normalized.valid) {
      return res.status(422).json({
        success: false,
        grade_status: 'invalid_response',
        error: 'The authoritative quiz question is missing or invalid and cannot be regraded.',
        validation_errors: normalized.valid ? [] : normalized.errors
      });
    }

    const questionDigest = createQuestionDigest(normalized.question);
    const previousQuestionDigest = typeof detail.question_digest === 'string'
      ? detail.question_digest
      : '';
    const questionVersionNeedsAcknowledgement = (
      !previousQuestionDigest || previousQuestionDigest !== questionDigest
    );
    if (
      questionVersionNeedsAcknowledgement
      && req.body?.acknowledge_question_change !== true
    ) {
      return res.status(409).json({
        success: false,
        review_required: true,
        grade_status: 'invalid_response',
        error: 'The historical question version is missing or differs from the current quiz. Teacher acknowledgement is required before changing the finalized grade.'
      });
    }

    const rawSnapshots = working.solution_snapshots?.[questionIndex]
      ?? working.solution_snapshots?.[String(questionIndex)]
      ?? [];
    if (!Array.isArray(rawSnapshots)) {
      return res.status(422).json({
        success: false,
        grade_status: 'invalid_response',
        error: 'Stored solution snapshots are malformed and require teacher review.'
      });
    }
    const solutionSnapshots = sanitizeSnapshotsForDigest(rawSnapshots);
    if (solutionSnapshots.length !== rawSnapshots.length) {
      return res.status(422).json({
        success: false,
        grade_status: 'invalid_response',
        error: 'Stored solution snapshots are invalid or exceed the supported proof limit.'
      });
    }

    const hasCanonicalAnswer = Boolean(
      working.answers
      && typeof working.answers === 'object'
      && Object.prototype.hasOwnProperty.call(working.answers, String(questionIndex))
    );
    const studentAnswer = hasCanonicalAnswer
      ? working.answers[String(questionIndex)]
      : detail.user_answer;
    const answerRevision = Number(
      working.answer_revisions?.[String(questionIndex)] ?? detail.answer_revision ?? 0
    );
    if (!Number.isSafeInteger(answerRevision) || answerRevision < 0) {
      return res.status(422).json({
        success: false,
        grade_status: 'invalid_response',
        error: 'The stored answer revision is invalid and requires teacher review.'
      });
    }

    const localGrade = gradeQuestionLocally(
      normalized.question,
      studentAnswer,
      solutionSnapshots.length > 0
    );
    if (localGrade.gradeStatus === 'invalid_response') {
      return res.status(422).json({
        success: false,
        grade_status: localGrade.gradeStatus,
        retryable: false,
        error: 'The authoritative question cannot be graded until its validation errors are resolved.',
        validation_errors: localGrade.errors
      });
    }

    let scoreFraction = normalizeGradeScore(localGrade.scoreFraction) ?? 0;
    let feedback = '';
    let gradeProof: string | undefined;
    if (localGrade.gradeStatus !== 'graded') {
      const semanticGrade = await gradeSemanticQuestion({
        clients: getQuizCreatorGeminiClients(quiz),
        question: normalized.question,
        studentAnswer,
        solutionSnapshots,
        modelName: (quiz as any).model_name,
        maxModelAttempts: 3
      });
      if (semanticGrade.gradeStatus !== 'graded') {
        return res.status(semanticGrade.retryable ? 503 : 422).json({
          success: false,
          grade_status: semanticGrade.gradeStatus,
          retryable: semanticGrade.retryable,
          error: semanticGrade.error || semanticGrade.feedback,
          feedback: semanticGrade.feedback
        });
      }
      const normalizedScore = normalizeGradeScore(semanticGrade.scoreFraction);
      if (normalizedScore === null) {
        return res.status(422).json({
          success: false,
          grade_status: 'invalid_response',
          retryable: false,
          error: 'The semantic grader returned an invalid score.'
        });
      }
      scoreFraction = normalizedScore;
      feedback = semanticGrade.feedback;
      gradeProof = createGradeProof({
        quizId: working.quiz_id,
        sessionId: attemptSessionId,
        questionIndex,
        answerRevision,
        question: normalized.question,
        studentAnswer,
        solutionSnapshots,
        gradeStatus: 'graded',
        scoreFraction,
        feedback
      });
    }

    const answerDigest = createAnswerDigest(studentAnswer);
    const snapshotDigest = createSnapshotDigest(solutionSnapshots);
    Object.assign(detail, {
      user_answer: studentAnswer,
      grade_status: 'graded',
      is_correct: scoreFraction === 1,
      score_fraction: scoreFraction,
      points: normalized.question.points,
      earned_points: Math.round(
        (normalized.question.points * scoreFraction + Number.EPSILON) * 10_000
      ) / 10_000,
      type: normalized.question.type,
      correct_answer: normalized.question.answer,
      ai_feedback: feedback,
      answer_revision: answerRevision,
      answer_digest: answerDigest,
      snapshot_digest: snapshotDigest,
      question_digest: questionDigest
    });
    if (questionVersionNeedsAcknowledgement) {
      detail.regrade_audit = {
        action: previousQuestionDigest
          ? 'teacher_acknowledged_question_version_change'
          : 'teacher_acknowledged_unknown_historical_question_version',
        previous_question_digest: previousQuestionDigest || null,
        question_digest: questionDigest,
        actor_uid: req.user?.uid || '',
        at: new Date().toISOString()
      };
    }
    if (gradeProof) detail.grade_proof = gradeProof;
    else delete detail.grade_proof;

    working.answers = { ...(working.answers || {}), [String(questionIndex)]: studentAnswer };
    working.answer_revisions = {
      ...(working.answer_revisions || {}),
      [String(questionIndex)]: answerRevision
    };
    working.graded_details = details;
    working.details = details;
    recalculateResult(working);
    working.updated_at = new Date().toISOString();

    results.set(req.params.result_id, working);
    savePersistentData();
    try {
      await syncDocToFirestore('results', req.params.result_id, working);
    } catch (error) {
      results.set(req.params.result_id, latest);
      savePersistentData();
      throw error;
    }

    return res.json({
      success: true,
      grade_status: 'graded',
      is_correct: detail.is_correct,
      score_fraction: detail.score_fraction,
      earned_points: detail.earned_points,
      max_points: detail.points,
      correct_answer: detail.correct_answer,
      ai_feedback: detail.ai_feedback,
      result: withResultAliases(working, req.params.result_id)
    });
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

router.get('/results/:id', optionalAuth, (req: AuthRequest, res) => {
  const id = req.params.id;
  const rawResult = results.get(id);

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
      accuracy_pct: finiteNumber(normalized.accuracy_pct, 0),
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
    if (!hasResultAccess(req, rawResult, id)) {
      return res.status(403).send('You do not have access to this result');
    }
    const token = requestResultAccessToken(req, id);
    if (token && verifyResultAccessToken(token, rawResult.access_token_hash)) {
      setResultAccessCookie(req, res, id, token);
    }
    const formatted = formatResult(rawResult);
    return res.render('results', {
      results: [formatted],
      result: formatted,
      title: formatted.quiz_title,
      quiz_id: formatted.quiz_id
    });
  }

  const quiz = quizzes.get(id);
  if (quiz) {
    const isTeacherOrAdmin = canManageQuiz(req.user, quiz);
    let userResults: any[] = [];
    if (isTeacherOrAdmin) {
      userResults = Array.from(results.values()).filter(r => r.quiz_id === id);
    } else if (req.user) {
      userResults = Array.from(results.values()).filter(r =>
        r.quiz_id === id && (
          (r.user_id && r.user_id === req.user?.uid) ||
          (r.student_name && req.user?.name && r.student_name.trim().toLowerCase() === req.user.name.trim().toLowerCase()) ||
          (r.student_name && req.user?.email && r.student_name.trim().toLowerCase() === req.user.email.trim().toLowerCase())
        )
      );
    }

    if (userResults.length > 0) {
      const formattedResults = userResults
        .map(formatResult)
        .sort((a, b) => getQuizTimestamp(b) - getQuizTimestamp(a));
      return res.render('results', {
        results: formattedResults,
        result: formattedResults[0],
        title: quiz.title,
        quiz_id: id
      });
    } else if (isTeacherOrAdmin || req.user) {
      return res.render('results', { results: [], result: null, title: quiz.title, quiz_id: id });
    } else {
      return res.status(403).send('You do not have access to this quiz');
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
          score_fraction: 1,
          solution: q.solution || ''
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
