import { Router } from 'express';
import { tokenRequired } from '../middleware/auth.ts';
import type { AuthRequest } from '../middleware/auth.ts';
import { quizzes, getOrCreateLiveState } from '../store/db.ts';
import { isValidLiveRecordId, updateLiveSession } from '../services/socket.ts';

const router = Router();

function canManageQuiz(user: any, quiz: any): boolean {
  if (!user || !quiz) return false;
  if (user.role === 'admin') return true;
  if (quiz.user_id && quiz.user_id === user.uid) return true;
  return !quiz.user_id && user.uid === 'teacher_test';
}

router.get(['/live/:quiz_id', '/live'], tokenRequired, (req: AuthRequest, res) => {
  const requestedQuizId = String(req.params.quiz_id || req.query.quiz_id || '').trim();
  const quizId = requestedQuizId || Array.from(quizzes.keys())[0] || 'quiz_algebra_101';
  const quiz = quizzes.get(quizId);
  if (requestedQuizId && !quiz) {
    return res.status(404).send('Quiz not found');
  }
  if (!quiz || !canManageQuiz(req.user, quiz)) {
    return res.status(403).send('You do not have access to this quiz');
  }

  res.render('live', {
    quiz_id: quizId,
    quiz: quiz || { title: 'Live Classroom', questions: [] },
    total_q: quiz ? quiz.questions.length : 0,
    title: quiz ? quiz.title : 'Live Classroom'
  });
});

router.get('/api/live/:quiz_id', tokenRequired, (req: AuthRequest, res) => {
  const quizId = req.params.quiz_id;
  const quiz = quizzes.get(quizId);
  if (!quiz) return res.status(404).json({ success: false, error: 'Quiz not found' });
  if (!canManageQuiz(req.user, quiz)) {
    return res.status(403).json({ success: false, error: 'You do not have access to this quiz' });
  }
  const liveState = getOrCreateLiveState(quizId);
  res.json({
    success: true,
    paused: liveState.paused,
    terminated: liveState.terminated,
    sessions: liveState.sessions
  });
});

router.post('/api/live/:quiz_id/toggle_pause', tokenRequired, (req: AuthRequest, res) => {
  const quizId = req.params.quiz_id;
  const quiz = quizzes.get(quizId);
  if (!quiz) {
    return res.status(404).json({ success: false, error: 'Quiz not found' });
  }
  if (!canManageQuiz(req.user, quiz)) {
    return res.status(403).json({ success: false, error: 'You do not have access to this quiz' });
  }
  const liveState = getOrCreateLiveState(quizId);
  liveState.paused = !liveState.paused;

  const io = req.app.get('io');
  if (io) io.to(`quiz_${quizId}`).emit('pause_state', { paused: liveState.paused });
  res.json({ success: true, paused: liveState.paused });
});

router.post('/api/live/:quiz_id/terminate', tokenRequired, (req: AuthRequest, res) => {
  const quizId = req.params.quiz_id;
  const quiz = quizzes.get(quizId);
  if (!quiz) {
    return res.status(404).json({ success: false, error: 'Quiz not found' });
  }
  if (!canManageQuiz(req.user, quiz)) {
    return res.status(403).json({ success: false, error: 'You do not have access to this quiz' });
  }
  const liveState = getOrCreateLiveState(quizId);
  liveState.terminated = true;
  liveState.paused = false;

  const io = req.app.get('io');
  if (io) io.to(`quiz_${quizId}`).emit('terminate', { terminated: true });
  res.json({ success: true, terminated: true });
});

router.post('/api/live/:quiz_id/whiteboard/:sid/toggle', tokenRequired, (req: AuthRequest, res) => {
  const { quiz_id, sid } = req.params;
  const quiz = quizzes.get(quiz_id);
  if (!quiz) {
    return res.status(404).json({ success: false, error: 'Quiz not found' });
  }
  if (!canManageQuiz(req.user, quiz)) {
    return res.status(403).json({ success: false, error: 'You do not have access to this quiz' });
  }
  const liveState = getOrCreateLiveState(quiz_id);
  if (!liveState.sessions[sid]) {
    return res.status(404).json({ success: false, error: 'Student session not found' });
  }

  liveState.sessions[sid].whiteboard_disabled = !liveState.sessions[sid].whiteboard_disabled;
  const io = req.app.get('io');
  if (io) {
    io.to(`quiz_session_${quiz_id}_${sid}`).emit('update_session', {
      session_id: sid,
      data: liveState.sessions[sid],
      paused: liveState.paused,
      terminated: liveState.terminated
    });
  }
  res.json({ success: true, sessions: liveState.sessions });
});

router.post('/ping', (req, res) => {
  const { quiz_id, session_id } = req.body || {};

  if (quiz_id && session_id) {
    const normalizedQuizId = String(quiz_id).trim();
    const normalizedSessionId = String(session_id).trim();
    if (!isValidLiveRecordId(normalizedQuizId) || !quizzes.has(normalizedQuizId)) {
      return res.status(404).json({ success: false, error: 'Quiz not found' });
    }
    if (!isValidLiveRecordId(normalizedSessionId)) {
      return res.status(400).json({ success: false, error: 'Invalid session_id' });
    }

    const updated = updateLiveSession(normalizedQuizId, req.body);
    if (!updated.session || !updated.liveState) {
      const status = updated.error === 'session_limit' ? 429 : 400;
      return res.status(status).json({
        success: false,
        error: updated.error === 'session_limit'
          ? 'Live session limit reached'
          : 'Unable to update live session'
      });
    }

    const io = req.app.get('io');
    if (io) {
      io.to(`quiz_${normalizedQuizId}`).emit('update_session', {
        session_id: updated.sessionId,
        data: updated.session,
        paused: updated.liveState.paused,
        terminated: updated.liveState.terminated
      });
    }

    const submittedTime = Number(req.body?.time_remaining);
    return res.json({
      success: true,
      paused: updated.liveState.paused,
      terminated: updated.liveState.terminated,
      whiteboard_disabled: updated.session.whiteboard_disabled,
      ...(Number.isFinite(submittedTime) && submittedTime >= 0 ? { time_remaining: submittedTime } : {})
    });
  }

  res.status(400).json({ success: false, paused: false, terminated: false, error: 'Missing quiz_id or session_id' });
});

export default router;
