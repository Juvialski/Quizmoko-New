import { Router } from 'express';
import { tokenRequired } from '../middleware/auth.ts';
import { quizzes, getOrCreateLiveState } from '../store/db.ts';

const router = Router();

router.get(['/live/:quiz_id', '/live'], tokenRequired, (req, res) => {
  const quizId = req.params.quiz_id || req.query.quiz_id || Array.from(quizzes.keys())[0] || 'quiz_algebra_101';
  const quiz = quizzes.get(quizId as string) || Array.from(quizzes.values())[0];

  res.render('live', {
    quiz_id: quizId,
    quiz: quiz || { title: 'Live Classroom', questions: [] },
    total_q: quiz ? quiz.questions.length : 0,
    title: quiz ? quiz.title : 'Live Classroom'
  });
});

router.get('/api/live/:quiz_id', (req, res) => {
  const quizId = req.params.quiz_id;
  const liveState = getOrCreateLiveState(quizId);
  res.json({
    success: true,
    paused: liveState.paused,
    terminated: liveState.terminated,
    sessions: liveState.sessions
  });
});

router.post('/api/live/:quiz_id/toggle_pause', (req, res) => {
  const quizId = req.params.quiz_id;
  const liveState = getOrCreateLiveState(quizId);
  liveState.paused = !liveState.paused;

  const io = req.app.get('io');
  if (io) io.to(`quiz_${quizId}`).emit('pause_state', { paused: liveState.paused });
  res.json({ success: true, paused: liveState.paused });
});

router.post('/api/live/:quiz_id/terminate', (req, res) => {
  const quizId = req.params.quiz_id;
  const liveState = getOrCreateLiveState(quizId);
  liveState.terminated = true;

  const io = req.app.get('io');
  if (io) io.to(`quiz_${quizId}`).emit('terminate', { terminated: true });
  res.json({ success: true, terminated: true });
});

router.post('/api/live/:quiz_id/whiteboard/:sid/toggle', (req, res) => {
  const { quiz_id, sid } = req.params;
  const liveState = getOrCreateLiveState(quiz_id);
  if (liveState.sessions[sid]) {
    liveState.sessions[sid].whiteboard_disabled = !liveState.sessions[sid].whiteboard_disabled;
    const io = req.app.get('io');
    if (io) {
      io.to(`quiz_${quiz_id}`).emit('update_session', {
        session_id: sid,
        data: liveState.sessions[sid],
        paused: liveState.paused
      });
    }
  }
  res.json({ success: true, sessions: liveState.sessions });
});

router.post('/ping', (req, res) => {
  const { quiz_id, session_id, student_name, current_q, score, status } = req.body;

  if (quiz_id && session_id) {
    const liveState = getOrCreateLiveState(quiz_id);
    const displayName = student_name && student_name !== 'undefined' ? student_name : 'Student';
    const existing = liveState.sessions[session_id] || {
      name: displayName,
      student_name: displayName,
      current_q: current_q || 1,
      current_question: current_q || 1,
      total_questions: 10,
      score: 0,
      status: 'Active',
      last_active: Date.now(),
      whiteboard_disabled: false
    };

    existing.name = displayName;
    existing.student_name = displayName;
    existing.current_q = current_q !== undefined ? current_q : (existing.current_q || 1);
    existing.current_question = current_q !== undefined ? current_q : (existing.current_question || 1);
    existing.score = score !== undefined ? score : existing.score;
    existing.status = status || existing.status;
    existing.last_active = Date.now();

    liveState.sessions[session_id] = existing;

    const io = req.app.get('io');
    if (io) {
      io.to(`quiz_${quiz_id}`).emit('update_session', {
        session_id,
        data: existing,
        paused: liveState.paused,
        terminated: liveState.terminated
      });
    }

    return res.json({
      success: true,
      paused: liveState.paused,
      terminated: liveState.terminated,
      whiteboard_disabled: existing.whiteboard_disabled,
      time_remaining: 30
    });
  }

  res.json({ success: true, paused: false, time_remaining: 30 });
});

export default router;
