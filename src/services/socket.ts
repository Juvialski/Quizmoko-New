import { Server as SocketIOServer } from 'socket.io';
import { getOrCreateLiveState, quizzes } from '../store/db.ts';

const LIVE_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;
const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_LIVE_SESSIONS_PER_QUIZ = 5_000;

function finiteNumber(value: any, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function isValidLiveRecordId(value: any): value is string {
  return typeof value === 'string'
    && LIVE_ID_PATTERN.test(value)
    && !RESERVED_OBJECT_KEYS.has(value);
}

export function updateLiveSession(quizId: string, payload: any) {
  const sessionId = String(payload?.session_id || '').trim();
  if (!isValidLiveRecordId(quizId) || !quizzes.has(quizId)) {
    return { liveState: null, sessionId: '', session: null, error: 'quiz_not_found' };
  }
  if (!isValidLiveRecordId(sessionId)) {
    return { liveState: null, sessionId: '', session: null, error: 'invalid_session' };
  }

  const liveState = getOrCreateLiveState(quizId);
  const requestedStatus = String(payload?.status || '').trim().slice(0, 64);
  if (liveState.terminated && requestedStatus.toLowerCase() === 'started') {
    // A fresh attempt after a terminated run starts a new live lifecycle.
    liveState.terminated = false;
    liveState.paused = false;
    liveState.sessions = {};
  }

  const isNewSession = !Object.prototype.hasOwnProperty.call(liveState.sessions, sessionId);
  if (isNewSession && Object.keys(liveState.sessions).length >= MAX_LIVE_SESSIONS_PER_QUIZ) {
    return { liveState, sessionId, session: null, error: 'session_limit' };
  }

  const quiz = quizzes.get(quizId);
  const totalQuestions = Array.isArray(quiz?.questions) ? quiz.questions.length : 0;
  const displayNameRaw = String(payload?.student_name ?? '').trim();
  const displayName = displayNameRaw && displayNameRaw !== 'undefined'
    ? displayNameRaw.slice(0, 120)
    : 'Student';
  const existing = liveState.sessions[sessionId] || {
    name: displayName,
    student_name: displayName,
    current_q: 1,
    current_question: 1,
    total_questions: totalQuestions,
    score: 0,
    status: 'Active',
    last_active: Date.now(),
    whiteboard_disabled: false
  };

  const currentQuestion = Math.min(
    Math.max(1, totalQuestions || 1),
    Math.max(1, Math.floor(finiteNumber(
    payload?.current_q ?? payload?.current_question,
    existing.current_q || existing.current_question || 1
    )))
  );
  existing.name = displayName;
  existing.student_name = displayName;
  existing.current_q = currentQuestion;
  existing.current_question = currentQuestion;
  existing.total_questions = totalQuestions || existing.total_questions || 0;
  existing.score = Math.max(
    0,
    Math.min(totalQuestions, finiteNumber(payload?.score, finiteNumber(existing.score, 0)))
  );
  existing.status = requestedStatus || existing.status || 'Active';
  existing.last_active = Date.now();
  existing.whiteboard_disabled = Boolean(existing.whiteboard_disabled);

  liveState.sessions[sessionId] = existing;
  return { liveState, sessionId, session: existing, error: null };
}

export function initSocketServer(server: any) {
  const io = new SocketIOServer(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });
  io.on('connection', (socket) => {
    let currentRoom: string | null = null;

    socket.on('join_quiz', (payload: any = {}) => {
      const quiz_id = String(payload.quiz_id || '').trim();
      if (!isValidLiveRecordId(quiz_id) || !quizzes.has(quiz_id)) {
        socket.emit('live_error', { code: 'QUIZ_NOT_FOUND', error: 'Quiz not found' });
        return;
      }
      if (currentRoom && currentRoom !== `quiz_${quiz_id}`) socket.leave(currentRoom);
      currentRoom = `quiz_${quiz_id}`;
      socket.join(currentRoom);

      const liveState = getOrCreateLiveState(quiz_id);
      socket.emit('pause_state', { paused: liveState.paused, terminated: liveState.terminated });
    });

    socket.on('leave_quiz', (payload: any = {}) => {
      const quiz_id = String(payload.quiz_id || '').trim();
      if (isValidLiveRecordId(quiz_id)) {
        socket.leave(`quiz_${quiz_id}`);
        if (currentRoom === `quiz_${quiz_id}`) currentRoom = null;
      }
    });

    socket.on('ping', (payload: any = {}) => {
      const quiz_id = String(payload.quiz_id || '').trim();
      const session_id = String(payload.session_id || '').trim();
      if (!isValidLiveRecordId(quiz_id) || !quizzes.has(quiz_id)) {
        socket.emit('ping_ack', { success: false, error: 'Quiz not found' });
        return;
      }
      if (!isValidLiveRecordId(session_id)) {
        socket.emit('ping_ack', { success: false, error: 'Invalid session_id' });
        return;
      }

      const updated = updateLiveSession(quiz_id, payload);
      if (!updated.session || !updated.liveState) {
        socket.emit('ping_ack', {
          success: false,
          error: updated.error === 'session_limit'
            ? 'Live session limit reached'
            : 'Unable to update live session'
        });
        return;
      }
      socket.join(`quiz_session_${quiz_id}_${updated.sessionId}`);

      socket.emit('update_session', {
        session_id: updated.sessionId,
        data: updated.session,
        paused: updated.liveState.paused,
        terminated: updated.liveState.terminated
      });

      const timeRemaining = finiteNumber(payload.time_remaining, -1);
      socket.emit('ping_ack', {
        success: true,
        paused: updated.liveState.paused,
        terminated: updated.liveState.terminated,
        whiteboard_disabled: updated.session.whiteboard_disabled,
        ...(timeRemaining >= 0 ? { time_remaining: timeRemaining } : {})
      });
    });

    socket.on('disconnect', () => {
      if (currentRoom) {
        socket.leave(currentRoom);
      }
    });
  });

  return io;
}
