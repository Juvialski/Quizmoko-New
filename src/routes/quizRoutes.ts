import { Router } from 'express';
import { tokenRequired, AuthRequest } from '../middleware/auth.ts';
import {
  quizzes,
  savePersistentData,
  syncDocToFirestore,
  deleteDocFromFirestore,
  getQuizTimestamp,
  getUniqueQuizTitle
} from '../store/db.ts';

const router = Router();

// --- DASHBOARD ROUTE ---
router.get('/', tokenRequired, (req: AuthRequest, res) => {
  const user = req.user || {};
  const isTeacherOrAdmin = user.role === 'admin' || user.role === 'teacher' || user.uid === 'teacher_test' || !user.role;
  const userQuizzes = isTeacherOrAdmin
    ? Array.from(quizzes.values())
    : Array.from(quizzes.values()).filter(q => q.user_id === user.uid || q.user_id === 'fbnuU0JRjqbPLUjdFpoVSEwOT733' || q.user_id === 'local_test_user');

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
router.get('/quiz/:quiz_id', tokenRequired, (req, res) => {
  const quiz = quizzes.get(req.params.quiz_id);
  if (!quiz) {
    return res.status(404).send('Quiz not found');
  }
  res.render('quiz', { quiz, quiz_id: req.params.quiz_id });
});

router.get(['/edit/:quiz_id', '/edit_quiz/:quiz_id'], tokenRequired, (req, res) => {
  const quiz = quizzes.get(req.params.quiz_id);
  if (!quiz) {
    return res.status(404).send('Quiz not found');
  }
  res.render('edit_quiz', { quiz, quiz_id: req.params.quiz_id });
});

router.get('/api/quiz/:quiz_id', (req, res) => {
  const quiz = quizzes.get(req.params.quiz_id);
  if (!quiz) {
    return res.status(404).json({ error: 'Quiz not found' });
  }
  res.json(quiz);
});

router.post(['/update/:quiz_id', '/api/quiz/:quiz_id/update'], tokenRequired, (req, res) => {
  const quizId = req.params.quiz_id;
  const existing = quizzes.get(quizId) || { id: quizId, created_at: new Date().toISOString() };
  if (req.body && req.body.title) {
    req.body.title = getUniqueQuizTitle(req.body.title, quizId);
  }
  const updated = { ...existing, ...req.body, id: quizId };
  quizzes.set(quizId, updated);
  savePersistentData();
  syncDocToFirestore('quizzes', quizId, updated);
  res.json({ success: true, quiz_id: quizId, quiz: updated, redirect: `/edit/${quizId}` });
});

router.post('/delete/:quiz_id', tokenRequired, (req, res) => {
  quizzes.delete(req.params.quiz_id);
  savePersistentData();
  deleteDocFromFirestore('quizzes', req.params.quiz_id);
  res.redirect('/');
});

router.delete('/api/quiz/:quiz_id', tokenRequired, (req, res) => {
  quizzes.delete(req.params.quiz_id);
  savePersistentData();
  deleteDocFromFirestore('quizzes', req.params.quiz_id);
  res.json({ success: true });
});

router.get('/create_blank', tokenRequired, (req: AuthRequest, res) => {
  const title = (req.query.title as string) || 'Untitled Quiz';
  const uniqueTitle = getUniqueQuizTitle(title);
  const subject = (req.query.subject as string) || 'General';
  const newId = `quiz_${Date.now()}`;
  const newQuiz = {
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
  };
  quizzes.set(newId, newQuiz);
  savePersistentData();
  syncDocToFirestore('quizzes', newId, newQuiz);
  res.redirect(`/edit/${newId}`);
});

router.post('/merge', tokenRequired, (req: AuthRequest, res) => {
  const { quiz_ids = [], new_title = 'Merged Quiz' } = req.body;
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
  const newQuiz = {
    id: newId,
    user_id: req.user ? req.user.uid : 'teacher_test',
    title: uniqueTitle,
    subject,
    time_limit: 30,
    quiz_mode: 'back_and_forth',
    require_solution: false,
    created_at: new Date().toISOString(),
    questions: mergedQuestions.length > 0 ? mergedQuestions : [
      { question: 'Sample Merged Question', options: ['A', 'B'], answer: 'A', type: 'multiple_choice' }
    ]
  };

  quizzes.set(newId, newQuiz);
  savePersistentData();
  syncDocToFirestore('quizzes', newId, newQuiz);
  res.json({ success: true, new_quiz_id: newId });
});

router.post('/api/move_quiz', tokenRequired, (req, res) => {
  const { quiz_id, subject } = req.body;
  const quiz = quizzes.get(quiz_id);
  if (quiz) {
    quiz.subject = subject || 'General';
    quizzes.set(quiz_id, quiz);
    savePersistentData();
    syncDocToFirestore('quizzes', quiz_id, quiz);
    return res.json({ success: true });
  }
  res.status(404).json({ success: false, error: 'Quiz not found' });
});

router.get('/api/list_quizzes', (req, res) => {
  const list = Array.from(quizzes.values());
  list.sort((a, b) => getQuizTimestamp(b) - getQuizTimestamp(a));
  res.json(list);
});

router.get('/api/get_quiz_details/:id', (req, res) => {
  const quiz = quizzes.get(req.params.id);
  if (quiz) res.json(quiz);
  else res.status(404).json({ error: 'Quiz not found' });
});

export default router;
