import { Router } from 'express';
import { tokenRequired, AuthRequest } from '../middleware/auth.ts';
import { quizzes, results, deleteDocFromFirestore, savePersistentData } from '../store/db.ts';

const router = Router();

router.get('/api/get_result/:result_id', (req, res) => {
  const result = results.get(req.params.result_id);
  if (result) return res.json(result);
  res.status(404).json({ error: 'Result not found' });
});

router.post('/api/results/:result_id/edit_answer', (req, res) => {
  const result = results.get(req.params.result_id);
  if (result) {
    const { q_index, new_answer, is_correct } = req.body;
    if (result.graded_details && result.graded_details[q_index]) {
      result.graded_details[q_index].user_answer = new_answer;
      if (is_correct !== undefined) result.graded_details[q_index].is_correct = is_correct;
    }
    return res.json({ success: true, result });
  }
  res.status(404).json({ error: 'Result not found' });
});

router.post('/api/results/:result_id/recheck', (req, res) => {
  res.json({ success: true, is_correct: true, score_fraction: 1.0 });
});

router.post('/api/results/:result_id/reprocess_answers', (req, res) => {
  res.json({ success: true });
});

router.post('/api/delete_results', (req, res) => {
  const { result_id } = req.body;
  if (result_id) {
    results.delete(result_id);
    savePersistentData();
    deleteDocFromFirestore('results', result_id);
  }
  res.json({ success: true });
});

router.get('/results/:id', tokenRequired, (req, res) => {
  const id = req.params.id;
  const rawResult = results.get(id);

  const formatResult = (r: any) => ({
    id: r.id || id,
    quiz_id: r.quiz_id,
    quiz_title: r.quiz_title || 'Quiz Results',
    student_name: r.student_name || 'Student',
    score: r.total_score !== undefined ? r.total_score : (r.score || 0),
    total: r.max_score !== undefined ? r.max_score : (r.total || 1),
    accuracy_pct: r.accuracy_pct !== undefined ? Math.round(r.accuracy_pct) : (r.max_score ? Math.round(((r.total_score || 0) / r.max_score) * 100) : 100),
    details: r.graded_details || r.details || [],
    created_at: r.created_at || new Date().toISOString(),
    completion_note: r.completion_note !== undefined ? r.completion_note : (r.is_in_progress ? 'In Progress' : ''),
    time_active_seconds: r.time_active_seconds || 0,
    time_paused_seconds: r.time_paused_seconds || 0,
    total_duration_seconds: r.total_duration_seconds || 0
  });

  if (rawResult) {
    const formatted = formatResult(rawResult);
    return res.render('results', { results: [formatted], result: formatted, title: formatted.quiz_title });
  }

  const quiz = quizzes.get(id);
  if (quiz) {
    const allResults = Array.from(results.values()).filter(r => r.quiz_id === id);
    if (allResults.length > 0) {
      const formattedResults = allResults.map(formatResult).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      return res.render('results', { results: formattedResults, result: formattedResults[0], title: quiz.title });
    } else {
      return res.render('results', { results: [], result: null, title: quiz.title });
    }
  }

  res.status(404).send('Result not found');
});

router.get(['/solutions/:result_id', '/view_solutions/:quiz_id'], tokenRequired, (req: AuthRequest, res) => {
  const id = req.params.result_id || req.params.quiz_id;
  const rawResult = results.get(id);
  const quiz = quizzes.get(id) || (rawResult ? quizzes.get(rawResult.quiz_id) : null);

  const formatSolutionResult = (r: any) => ({
    id: r ? r.id : `res_sol_${id}`,
    quiz_id: r ? r.quiz_id : (quiz ? quiz.id : id),
    quiz_title: r ? r.quiz_title : (quiz ? quiz.title : 'Quiz Solutions'),
    student_name: r ? r.student_name : 'Student',
    score: r ? (r.total_score !== undefined ? r.total_score : r.score) : (quiz ? quiz.questions.length : 0),
    total: r ? (r.max_score !== undefined ? r.max_score : r.total) : (quiz ? quiz.questions.length : 0),
    timestamp: r ? (r.created_at || new Date().toISOString()) : new Date().toISOString(),
    details: r ? (r.graded_details || r.details || []) : (quiz ? quiz.questions.map((q: any) => ({
      question: q.question,
      user_answer: q.answer,
      correct_answer: q.answer,
      is_correct: true,
      score_fraction: 1.0
    })) : [])
  });

  const formatted = formatSolutionResult(rawResult);

  res.render('view_solutions', {
    result: formatted,
    quiz: quiz || { title: formatted.quiz_title, questions: [] },
    title: formatted.quiz_title,
    session: { user: req.user }
  });
});

export default router;
