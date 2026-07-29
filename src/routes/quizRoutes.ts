import { Router, type NextFunction, type Response } from 'express';
import { tokenRequired } from '../middleware/auth.ts';
import type { AuthRequest } from '../middleware/auth.ts';
import {
  quizzes,
  results,
  liveSessions,
  savePersistentData,
  syncDocToFirestore,
  deleteDocFromFirestore,
  getQuizTimestamp,
  getUniqueQuizTitle
} from '../store/db.ts';
import {
  canonicalQuestionType,
  getQuestionOptions
} from '../services/grading.ts';

const router = Router();

function asyncRoute(
  handler: (req: AuthRequest, res: Response) => Promise<unknown>
) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

const SENSITIVE_QUIZ_FIELDS = [
  'api_key',
  'apiKey',
  'gemini_api_key',
  'geminiApiKey',
  'google_api_key',
  'googleApiKey',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'authorization',
  'service_account',
  'serviceAccount'
];
const ANSWER_KEY_FIELDS = [
  'answer',
  'correct_answer',
  'correctAnswer',
  'correct_answer_letter',
  'correctAnswerLetter'
];
const PUBLIC_QUIZ_ANSWER_FIELDS = [
  'golden_reference',
  'goldenReference',
  'answer_key',
  'answerKey',
  'answers',
  'correct_answers',
  'correctAnswers',
  'solutions',
  'solution',
  'explanation'
];
const PUBLIC_QUESTION_ANSWER_FIELDS = [
  ...ANSWER_KEY_FIELDS,
  ...PUBLIC_QUIZ_ANSWER_FIELDS,
  'feedback',
  'rationale',
  'answer_explanation',
  'answerExplanation',
  'solution_steps',
  'solutionSteps',
  'worked_solution',
  'workedSolution'
];

async function deleteQuizWithResults(quizId: string): Promise<number> {
  const deletedQuiz = quizzes.get(quizId);
  const deletedLiveSession = liveSessions.get(quizId);
  const resultIds = Array.from(results.entries())
    .filter(([, result]) => result.quiz_id === quizId)
    .map(([resultId]) => resultId);
  const deletedResults = resultIds.map((resultId) => [
    resultId,
    results.get(resultId)!
  ] as const);

  quizzes.delete(quizId);
  liveSessions.delete(quizId);
  for (const resultId of resultIds) results.delete(resultId);
  savePersistentData();
  try {
    await Promise.all([
      deleteDocFromFirestore('quizzes', quizId),
      ...resultIds.map(resultId => deleteDocFromFirestore('results', resultId))
    ]);
  } catch (error) {
    if (deletedQuiz) quizzes.set(quizId, deletedQuiz);
    if (deletedLiveSession) liveSessions.set(quizId, deletedLiveSession);
    for (const [resultId, result] of deletedResults) {
      results.set(resultId, result);
    }
    savePersistentData();
    throw error;
  }
  return resultIds.length;
}

function canManageQuiz(user: any, quiz: any): boolean {
  if (!user || !quiz) return false;
  if (user.role === 'admin') return true;
  if (quiz.user_id && quiz.user_id === user.uid) return true;
  return !quiz.user_id && user.uid === 'teacher_test';
}

function rejectQuizAccess(res: any) {
  return res.status(403).json({ success: false, error: 'You do not have access to this quiz' });
}

function validateQuizUpdate(body: any): { valid: boolean; error?: string; value?: any } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, error: 'Quiz update must be a JSON object' };
  }

  const value = sanitizeQuiz(body);
  if (value.title !== undefined) {
    if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200) {
      return { valid: false, error: 'title must be a non-empty string of at most 200 characters' };
    }
    value.title = value.title.trim();
  }
  if (value.subject !== undefined && (typeof value.subject !== 'string' || value.subject.length > 100)) {
    return { valid: false, error: 'subject must be a string of at most 100 characters' };
  }
  if (value.time_limit !== undefined) {
    const timeLimit = Number(value.time_limit);
    if (!Number.isFinite(timeLimit) || timeLimit <= 0 || timeLimit > 86_400) {
      return { valid: false, error: 'time_limit must be between 1 and 86400 seconds' };
    }
    value.time_limit = timeLimit;
  }
  if (value.quiz_mode !== undefined) {
    const normalizedMode = String(value.quiz_mode).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!['back_and_forth', 'sequential'].includes(normalizedMode)) {
      return { valid: false, error: 'quiz_mode must be back_and_forth or sequential' };
    }
    value.quiz_mode = normalizedMode;
  }
  if (value.require_solution !== undefined && typeof value.require_solution !== 'boolean') {
    return { valid: false, error: 'require_solution must be a boolean' };
  }
  if (value.questions !== undefined) {
    if (!Array.isArray(value.questions)) {
      return { valid: false, error: 'questions must be an array' };
    }
    if (value.questions.length > 2_000) {
      return { valid: false, error: 'questions cannot contain more than 2000 items' };
    }
    for (let index = 0; index < value.questions.length; index += 1) {
      const question = value.questions[index];
      if (!question || typeof question !== 'object' || Array.isArray(question)) {
        return { valid: false, error: `questions[${index}] must be an object` };
      }
      const text = question.question ?? question.prompt ?? question.text;
      if (typeof text !== 'string' || !text.trim()) {
        return { valid: false, error: `questions[${index}] must include non-empty question text` };
      }
      if (question.options !== undefined && !Array.isArray(question.options)) {
        return { valid: false, error: `questions[${index}].options must be an array` };
      }
      if (question.options?.some((option: any) => typeof option !== 'string')) {
        return { valid: false, error: `questions[${index}].options must contain only strings` };
      }
      if (question.type !== undefined && typeof question.type !== 'string') {
        return { valid: false, error: `questions[${index}].type must be a string` };
      }
    }
  }

  return { valid: true, value };
}

function sanitizeRecord<T extends Record<string, any>>(value: T): T {
  const sanitized: Record<string, any> = { ...value };
  for (const field of SENSITIVE_QUIZ_FIELDS) delete sanitized[field];
  return sanitized as T;
}

function sanitizeQuiz(quiz: any): any {
  if (!quiz || typeof quiz !== 'object') return quiz;
  const sanitized = sanitizeRecord(quiz);
  if (Array.isArray(sanitized.questions)) {
    sanitized.questions = sanitized.questions.map((question: any) => (
      question && typeof question === 'object' ? sanitizeRecord(question) : question
    ));
  }
  return sanitized;
}

function publicQuiz(quiz: any): any {
  const sanitized = sanitizeQuiz(quiz);
  if (!sanitized || typeof sanitized !== 'object') return sanitized;
  const publicRecord = { ...sanitized };
  for (const field of PUBLIC_QUIZ_ANSWER_FIELDS) delete publicRecord[field];
  return {
    ...publicRecord,
    questions: Array.isArray(sanitized.questions)
      ? sanitized.questions.map((question: any) => {
        if (!question || typeof question !== 'object') return question;
        const publicQuestion = { ...question };
        for (const field of PUBLIC_QUESTION_ANSWER_FIELDS) delete publicQuestion[field];
        return publicQuestion;
      })
      : []
  };
}

function quizFirestorePayload(quiz: any): any {
  const tombstones = Object.fromEntries(SENSITIVE_QUIZ_FIELDS.map(field => [field, null]));
  return { ...sanitizeQuiz(quiz), ...tombstones };
}

function quizForTaking(quiz: any): any {
  const sanitized = publicQuiz(quiz);
  const parsedLimit = Number(sanitized?.time_limit ?? sanitized?.timeLimit);
  const rawMode = String(sanitized?.quiz_mode ?? sanitized?.quizMode ?? 'back_and_forth')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const quizMode = rawMode === 'sequential' ? 'sequential' : 'back_and_forth';
  const rawQuestions = Array.isArray(sanitized?.questions) ? sanitized.questions : [];

  return {
    ...sanitized,
    time_limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 30,
    quiz_mode: quizMode,
    require_solution: Boolean(sanitized?.require_solution ?? sanitized?.requireSolution),
    questions: rawQuestions.map((question: any) => {
      const normalizedQuestion = question && typeof question === 'object' ? question : {};
      return {
        ...normalizedQuestion,
        question: String(
          normalizedQuestion.question
          ?? normalizedQuestion.prompt
          ?? normalizedQuestion.text
          ?? ''
        ),
        options: getQuestionOptions(normalizedQuestion),
        type: canonicalQuestionType(normalizedQuestion)
      };
    })
  };
}

// --- DASHBOARD ROUTE ---
router.get('/', tokenRequired, (req: AuthRequest, res) => {
  const user = req.user!;
  const rawUserQuizzes = Array.from(quizzes.values()).filter(q => canManageQuiz(user, q));
  const userQuizzes = rawUserQuizzes.map(publicQuiz);

  userQuizzes.sort((a, b) => getQuizTimestamp(b) - getQuizTimestamp(a));

  const groupedQuizzes: Record<string, any[]> = {};
  const allSubjects = ['General', 'Math', 'Science', 'English', 'History', 'Biology'];

  userQuizzes.forEach(q => {
    const subj = q.subject || 'General';
    if (!groupedQuizzes[subj]) groupedQuizzes[subj] = [];
    groupedQuizzes[subj].push(q);
    if (!allSubjects.includes(subj)) allSubjects.push(subj);
  });

  Object.keys(groupedQuizzes).forEach(subj => {
    groupedQuizzes[subj].sort((a, b) => getQuizTimestamp(b) - getQuizTimestamp(a));
  });

  const sortedGroupedQuizzes: Record<string, any[]> = {};
  const subjectEntries = Object.entries(groupedQuizzes);
  subjectEntries.sort((a, b) => {
    const newestA = a[1].length > 0 ? getQuizTimestamp(a[1][0]) : 0;
    const newestB = b[1].length > 0 ? getQuizTimestamp(b[1][0]) : 0;
    return newestB - newestA;
  });

  subjectEntries.forEach(([subj, list]) => {
    sortedGroupedQuizzes[subj] = list;
  });

  res.render('index', {
    grouped_quizzes: sortedGroupedQuizzes,
    all_subjects: Array.from(new Set(allSubjects)).sort(),
    is_admin: user.role === 'admin',
    is_rmx_authorized: true,
    user: user
  });
});

// --- QUIZ TAKING & EDITING ROUTES ---
router.get('/quiz/:quiz_id', (req, res) => {
  const quiz = quizzes.get(req.params.quiz_id);
  if (!quiz) {
    return res.status(404).send('Quiz not found');
  }
  res.render('quiz', { quiz: quizForTaking(quiz), quiz_id: req.params.quiz_id });
});

router.get(['/edit/:quiz_id', '/edit_quiz/:quiz_id'], tokenRequired, (req: AuthRequest, res) => {
  const quiz = quizzes.get(req.params.quiz_id);
  if (!quiz) {
    return res.status(404).send('Quiz not found');
  }
  if (!canManageQuiz(req.user, quiz)) return res.status(403).send('You do not have access to this quiz');
  res.render('edit_quiz', { quiz: sanitizeQuiz(quiz), quiz_id: req.params.quiz_id });
});

router.get('/api/quiz/:quiz_id', (req, res) => {
  const quiz = quizzes.get(req.params.quiz_id);
  if (!quiz) {
    return res.status(404).json({ error: 'Quiz not found' });
  }
  res.json(publicQuiz(quiz));
});

router.post(['/update/:quiz_id', '/api/quiz/:quiz_id/update'], tokenRequired, asyncRoute(async (req, res) => {
  const quizId = req.params.quiz_id;
  const storedQuiz = quizzes.get(quizId);
  if (!storedQuiz) return res.status(404).json({ success: false, error: 'Quiz not found' });
  if (!canManageQuiz(req.user, storedQuiz)) return rejectQuizAccess(res);
  const existing = sanitizeQuiz(storedQuiz);
  const validation = validateQuizUpdate(req.body);
  if (!validation.valid) {
    return res.status(400).json({ success: false, error: validation.error });
  }
  const incoming = validation.value || {};
  if (incoming.title) {
    incoming.title = getUniqueQuizTitle(incoming.title, quizId);
  }
  const updated = sanitizeQuiz({
    ...existing,
    ...incoming,
    id: quizId,
    user_id: existing.user_id,
    created_at: existing.created_at || new Date().toISOString()
  });
  quizzes.set(quizId, updated);
  savePersistentData();
  try {
    await syncDocToFirestore('quizzes', quizId, quizFirestorePayload(updated));
  } catch (error) {
    quizzes.set(quizId, storedQuiz);
    savePersistentData();
    throw error;
  }
  res.json({ success: true, quiz_id: quizId, quiz: updated, redirect: `/edit/${quizId}` });
}));

router.post('/delete/:quiz_id', tokenRequired, asyncRoute(async (req, res) => {
  const quiz = quizzes.get(req.params.quiz_id);
  if (!quiz) return res.status(404).send('Quiz not found');
  if (!canManageQuiz(req.user, quiz)) return res.status(403).send('You do not have access to this quiz');
  await deleteQuizWithResults(req.params.quiz_id);
  res.redirect('/');
}));

router.delete('/api/quiz/:quiz_id', tokenRequired, asyncRoute(async (req, res) => {
  const quiz = quizzes.get(req.params.quiz_id);
  if (!quiz) return res.status(404).json({ success: false, error: 'Quiz not found' });
  if (!canManageQuiz(req.user, quiz)) return rejectQuizAccess(res);
  const deletedResultCount = await deleteQuizWithResults(req.params.quiz_id);
  res.json({ success: true, deleted_result_count: deletedResultCount });
}));

router.get('/create_blank', tokenRequired, asyncRoute(async (req, res) => {
  const title = (req.query.title as string) || 'Untitled Quiz';
  const uniqueTitle = getUniqueQuizTitle(title);
  const subject = (req.query.subject as string) || 'General';
  const newId = `quiz_${Date.now()}`;
  const newQuiz = sanitizeQuiz({
    id: newId,
    user_id: req.user ? req.user.uid : 'teacher_test',
    title: uniqueTitle,
    subject,
    time_limit: 30,
    quiz_mode: 'back_and_forth',
    require_solution: false,
    created_at: new Date().toISOString(),
    questions: [
      {
        question: 'Question 1: Enter your question here',
        options: ['A) Option 1', 'B) Option 2', 'C) Option 3', 'D) Option 4'],
        answer: 'A) Option 1',
        type: 'multiple_choice'
      }
    ]
  });
  quizzes.set(newId, newQuiz);
  savePersistentData();
  try {
    await syncDocToFirestore('quizzes', newId, quizFirestorePayload(newQuiz));
  } catch (error) {
    quizzes.delete(newId);
    savePersistentData();
    throw error;
  }
  res.redirect(`/edit/${newId}`);
}));

router.post('/merge', tokenRequired, asyncRoute(async (req, res) => {
  const { quiz_ids = [], new_title = 'Merged Quiz' } = req.body;
  if (!Array.isArray(quiz_ids) || quiz_ids.length === 0) {
    return res.status(400).json({ success: false, error: 'Select at least one quiz to merge' });
  }
  const sourceQuizzes = quiz_ids.map((id: string) => quizzes.get(id));
  if (sourceQuizzes.some((quiz: any) => !quiz)) {
    return res.status(404).json({ success: false, error: 'One or more quizzes were not found' });
  }
  if (sourceQuizzes.some((quiz: any) => !canManageQuiz(req.user, quiz))) {
    return rejectQuizAccess(res);
  }
  const uniqueTitle = getUniqueQuizTitle(new_title);
  let mergedQuestions: any[] = [];
  let subject = 'General';

  quiz_ids.forEach((id: string) => {
    const q = quizzes.get(id);
    if (q) {
      if (q.questions) mergedQuestions.push(...q.questions);
      if (q.subject) subject = q.subject;
    }
  });

  const newId = `quiz_merged_${Date.now()}`;
  const newQuiz = sanitizeQuiz({
    id: newId,
    user_id: req.user ? req.user.uid : 'teacher_test',
    title: uniqueTitle,
    subject,
    time_limit: 30,
    quiz_mode: 'back_and_forth',
    require_solution: false,
    created_at: new Date().toISOString(),
    questions: mergedQuestions
  });

  quizzes.set(newId, newQuiz);
  savePersistentData();
  try {
    await syncDocToFirestore('quizzes', newId, quizFirestorePayload(newQuiz));
  } catch (error) {
    quizzes.delete(newId);
    savePersistentData();
    throw error;
  }
  res.json({ success: true, new_quiz_id: newId });
}));

router.post('/api/move_quiz', tokenRequired, asyncRoute(async (req, res) => {
  const { quiz_id, subject } = req.body;
  const quiz = quizzes.get(quiz_id);
  if (quiz) {
    if (!canManageQuiz(req.user, quiz)) return rejectQuizAccess(res);
    const updated = sanitizeQuiz({ ...quiz, subject: subject || 'General' });
    quizzes.set(quiz_id, updated);
    savePersistentData();
    try {
      await syncDocToFirestore('quizzes', quiz_id, quizFirestorePayload(updated));
    } catch (error) {
      quizzes.set(quiz_id, quiz);
      savePersistentData();
      throw error;
    }
    return res.json({ success: true });
  }
  return res.status(404).json({ success: false, error: 'Quiz not found' });
}));

router.get('/api/list_quizzes', tokenRequired, (req: AuthRequest, res) => {
  const list = Array.from(quizzes.values())
    .filter(quiz => canManageQuiz(req.user, quiz))
    .map(sanitizeQuiz);
  list.sort((a, b) => getQuizTimestamp(b) - getQuizTimestamp(a));
  res.json(list);
});

router.get('/api/get_quiz_details/:id', tokenRequired, (req: AuthRequest, res) => {
  const quiz = quizzes.get(req.params.id);
  if (quiz && canManageQuiz(req.user, quiz)) res.json(sanitizeQuiz(quiz));
  else if (quiz) rejectQuizAccess(res);
  else res.status(404).json({ error: 'Quiz not found' });
});

export default router;
