import { Server as SocketIOServer } from 'socket.io';
import { getOrCreateLiveState } from '../store/db.ts';

export function initSocketServer(server: any) {
  const io = new SocketIOServer(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });
  io.on('connection', (socket) => {
    let currentRoom: string | null = null;

    socket.on('join_quiz', ({ quiz_id }) => {
      if (!quiz_id) return;
      currentRoom = `quiz_${quiz_id}`;
      socket.join(currentRoom);

      const liveState = getOrCreateLiveState(quiz_id);
      socket.emit('pause_state', { paused: liveState.paused });
    });

    socket.on('leave_quiz', ({ quiz_id }) => {
      if (quiz_id) {
        socket.leave(`quiz_${quiz_id}`);
      }
    });

    socket.on('ping', (payload) => {
      const { quiz_id, session_id, student_name, current_q, score, status } = payload;
      if (!quiz_id || !session_id) return;

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

      io.to(`quiz_${quiz_id}`).emit('update_session', {
        session_id,
        data: existing,
        paused: liveState.paused,
        terminated: liveState.terminated
      });

      socket.emit('ping_ack', {
        paused: liveState.paused,
        terminated: liveState.terminated,
        whiteboard_disabled: existing.whiteboard_disabled,
        time_remaining: 30
      });
    });

    socket.on('disconnect', () => {
      if (currentRoom) {
        socket.leave(currentRoom);
      }
    });
  });
}
