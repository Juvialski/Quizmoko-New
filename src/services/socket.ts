import { verifySessionToken, SESSION_COOKIE_NAME, isDemoAuthEnabled } from '../middleware/auth.ts';
import { users } from '../store/db.ts';
import { isProductionRuntime, trustedSocketOrigins } from './runtimeConfig.ts';
import { Server as SocketIOServer } from 'socket.io';
import { getOrCreateLiveState, quizzes, results, liveSessions } from '../store/db.ts';

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

export const monitoringRoom = (quizId: string) => `monitor_${quizId}`;
export function canMonitorQuiz(user: any, quiz: any): boolean {
  return Boolean(user && quiz && (user.role === 'admin' || (user.role === 'teacher' && quiz.user_id === user.uid)));
}
export function socketUser(socket: any) {
  const cookies = String(socket.handshake.headers.cookie || '').split(';').map(v => v.trim());
  const cookie = cookies.find(v => v.startsWith(SESSION_COOKIE_NAME + '='))?.slice(SESSION_COOKIE_NAME.length + 1);
  let token = String(socket.handshake.headers.authorization || '').replace(/^Bearer\s+/i, '') || cookie || '';
  try { token = decodeURIComponent(token); } catch { return null; }
  if (token.startsWith('qms1.')) return verifySessionToken(token);
  if (isDemoAuthEnabled() && token.startsWith('user_')) return users.get(token.slice(5)) || null;
  return null;
}
export function canUseLiveAttempt(quizId: string, sessionId: string, user: any): boolean {
  const quiz = quizzes.get(quizId);
  if (!quiz || (quiz.is_draft && !canMonitorQuiz(user, quiz))) return false;
  const record = results.get(`res_${sessionId}`);
  if (record && record.quiz_id !== quizId) return false;
  if (record?.user_id) return record.user_id === user?.uid;
  // Anonymous IDs are private bearer capabilities, identical to the grading API.
  return !isProductionRuntime() || /^sess_(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/i.test(sessionId);
}
export function reconcileLiveResults(quizId: string) {
  const recovered = !liveSessions.has(quizId);
  const state = getOrCreateLiveState(quizId);
  for (const record of results.values()) {
    if (record.quiz_id !== quizId || !record.session_id || !isValidLiveRecordId(record.session_id)) continue;
    if (!state.sessions[record.session_id] && Object.keys(state.sessions).length >= MAX_LIVE_SESSIONS_PER_QUIZ) break;
    const recordedAt = Date.parse(record.submitted_at || record.created_at || '');
    if (!state.sessions[record.session_id] && Number.isFinite(recordedAt) && recordedAt < Date.now()-24*60*60*1000) continue;
    if (recovered) state.control_state_known=false;
    const prior = state.sessions[record.session_id];
    const details = record.graded_details || record.details || [];
    const answered = Object.keys(record.answers || {}).length;
    const pending = details.filter((d: any) => d && d.grade_status !== 'graded').length;
    state.sessions[record.session_id] = Object.assign({
      name: record.student_name || 'Student', student_name: record.student_name || 'Student',
      current_q: prior?.current_q || Math.max(1, answered), current_question: prior?.current_q || Math.max(1, answered),
      total_questions: quizzes.get(quizId)?.questions.length || 0,
      max_score: record.max_score ?? record.total ?? 0, score: record.total_score ?? record.score ?? 0,
      status: record.is_in_progress !== true ? 'Completed' : pending ? 'Waiting to be checked' : 'Active',
      last_active: prior?.last_active || 0, whiteboard_disabled: prior?.whiteboard_disabled || false,
      }, prior || {}, {
      // Persisted grades/finalization always win over ping claims.
      ...{score: record.total_score ?? record.score ?? 0, pending_grades: pending,
        failed_grades: details.filter((d: any) => d && ['retryable_error','invalid_response'].includes(d.grade_status)).length,
        status: record.is_in_progress !== true ? 'Completed' : pending ? 'Waiting to be checked' : 'Active'}
    });
  }
  return state;
}
export function emitLiveResult(io: any, quizId: string, sessionId: string) {
  const state = reconcileLiveResults(quizId);
  if (io && state.sessions[sessionId]) io.to(monitoringRoom(quizId)).emit('update_session', {
    session_id: sessionId, data: state.sessions[sessionId], paused: state.paused, terminated: state.terminated
  });
}

export function updateLiveSession(quizId: string, payload: any) {
  const sessionId = String(payload?.session_id || '').trim();
  if (!isValidLiveRecordId(quizId) || !quizzes.has(quizId)) {
    return { liveState: null, sessionId: '', session: null, error: 'quiz_not_found' };
  }
  if (!isValidLiveRecordId(sessionId)) {
    return { liveState: null, sessionId: '', session: null, error: 'invalid_session' };
  }

  pruneInactiveLiveSessions();
  const liveState = reconcileLiveResults(quizId);
  const requestedStatus = String(payload?.status || '').trim().slice(0, 64);

  const isNewSession = !Object.prototype.hasOwnProperty.call(liveState.sessions, sessionId);
  if (isNewSession && Object.keys(liveState.sessions).length >= MAX_LIVE_SESSIONS_PER_QUIZ) {
    return { liveState, sessionId, session: null, error: 'session_limit' };
  }

  const quiz = quizzes.get(quizId);
  const totalQuestions = Array.isArray(quiz?.questions) ? quiz.questions.length : 0;
  const maxScore = Array.isArray(quiz?.questions)
    ? quiz.questions.reduce((sum: number, question: any) => {
      const points = Number(question?.points);
      return sum + (Number.isFinite(points) && points > 0 ? points : 1);
    }, 0)
    : totalQuestions;
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
    max_score: maxScore,
    score: 0,
    status: 'Active',
    last_active: Date.now(),
    whiteboard_disabled: false,
    tab_switch_count: 0
  };

  const pingRevision = Number(payload?.ping_revision);
  if (Number.isFinite(pingRevision) && pingRevision < Number(existing.ping_revision || 0)) {
    return {liveState,sessionId,session:existing,error:null};
  }
  if (Number.isFinite(pingRevision)) existing.ping_revision=pingRevision;

  const rawTabSwitches = Number(payload?.tab_switch_count ?? payload?.tab_switches);
  if (Number.isFinite(rawTabSwitches) && rawTabSwitches >= 0) {
    existing.tab_switch_count = Math.max(existing.tab_switch_count || 0, Math.floor(rawTabSwitches));
  }

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
  existing.max_score = maxScore || existing.max_score || existing.total_questions || 0;
  const progressiveResult = results.get(`res_${sessionId}`);
  const authoritativeScore = progressiveResult?.quiz_id === quizId
    ? finiteNumber(progressiveResult.total_score ?? progressiveResult.score, 0)
    : null;
  existing.score = Math.max(
    0,
    Math.min(
      existing.max_score || maxScore || totalQuestions,
      authoritativeScore ?? 0
    )
  );
  existing.status = progressiveResult && progressiveResult.is_in_progress !== true ? 'Completed' : existing.pending_grades ? 'Waiting to be checked' : 'Active';
  existing.last_active = Date.now();
  existing.whiteboard_disabled = Boolean(existing.whiteboard_disabled);

  liveState.sessions[sessionId] = existing;
  return { liveState, sessionId, session: existing, error: null };
}

export function initSocketServer(server: any) {
  const origins = trustedSocketOrigins();
  const io = new SocketIOServer(server, {
    allowRequest: (req, callback) => callback(null, !isProductionRuntime()
      || !req.headers.origin || origins.includes(req.headers.origin)),
    cors: {
      origin: isProductionRuntime() ? trustedSocketOrigins() : "*",
      methods: ["GET", "POST"]
    }
  });
  const cleanup = setInterval(pruneInactiveLiveSessions, 60_000);
  cleanup.unref();
  io.engine.once('close', () => clearInterval(cleanup));
  io.on('connection', (socket) => {
    let currentRoom: string | null = null;

    socket.on('join_quiz', (payload: any = {}) => {
      const quiz_id = String(payload.quiz_id || '').trim();
      if (!isValidLiveRecordId(quiz_id) || !quizzes.has(quiz_id) || (quizzes.get(quiz_id)?.is_draft && !canMonitorQuiz(socketUser(socket), quizzes.get(quiz_id)))) {
        socket.emit('live_error', { code: 'QUIZ_NOT_FOUND', error: 'Quiz not found' });
        return;
      }
      if (currentRoom && currentRoom !== `quiz_${quiz_id}`) socket.leave(currentRoom);
      currentRoom = `quiz_${quiz_id}`;
      socket.join(currentRoom);

      if (payload.monitor === true) {
        if (!canMonitorQuiz(socketUser(socket), quizzes.get(quiz_id))) {
          socket.emit('live_error', { code: 'FORBIDDEN', error: 'Teacher monitoring access denied' });
          return;
        }
        socket.join(monitoringRoom(quiz_id));
      }
      const liveState = getOrCreateLiveState(quiz_id);
      socket.emit('pause_state', { paused: liveState.paused, terminated: liveState.terminated });
    });

    socket.on('leave_quiz', (payload: any = {}) => {
      const quiz_id = String(payload.quiz_id || '').trim();
      if (isValidLiveRecordId(quiz_id)) {
        socket.leave(`quiz_${quiz_id}`);
        socket.leave(monitoringRoom(quiz_id));
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

      if (!canUseLiveAttempt(quiz_id, session_id, socketUser(socket))) {
        socket.emit('ping_ack', { success: false, error: 'Attempt access denied' }); return;
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

      io.to(monitoringRoom(quiz_id)).emit('update_session', {
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

export function pruneInactiveLiveSessions(now = Date.now()): void {
  for (const [quizId, state] of liveSessions) {
    for (const [id, session] of Object.entries(state.sessions)) {
      if (now - Number(session.last_active || 0) > 2 * 60 * 60 * 1000) delete state.sessions[id];
    }
    if (!quizzes.has(quizId)) liveSessions.delete(quizId);
  }
}
