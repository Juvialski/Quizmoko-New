import { changeClassroomRun, bindClassroomAttempt, runRoom } from '../services/classroomRuns.ts';
import { Router } from 'express';
import { tokenRequired, optionalAuth } from '../middleware/auth.ts';
import type { AuthRequest } from '../middleware/auth.ts';
import { quizzes, getOrCreateLiveState, classroomRuns } from '../store/db.ts';
import { isValidLiveRecordId, updateLiveSession, canMonitorQuiz, monitoringRoom, canUseLiveAttempt, reconcileLiveResults } from '../services/socket.ts';

const router = Router();

const canManageQuiz = canMonitorQuiz;

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
  const liveState = reconcileLiveResults(quizId);
  res.json({
    success: true,
    run: liveState.run || null,
    control_state_known: liveState.control_state_known !== false,
    paused: liveState.paused,
    terminated: liveState.terminated,
    sessions: liveState.sessions
  });
});

// Mutations require a matching selected run so stale teacher tabs cannot control a new class.
for (const [path,action] of [['start','start'],['toggle_pause','pause'],['terminate','end']] as const) {
  router.post(`/api/live/:quiz_id/${path}`,tokenRequired,async (req:AuthRequest,res,next)=>{
    try {
      const quizId=req.params.quiz_id, quiz=quizzes.get(quizId);
      if(!quiz) return res.status(404).json({success:false,error:'Quiz not found'});
      if(!canManageQuiz(req.user,quiz)) return res.status(403).json({success:false,error:'You do not have access to this quiz'});
      // Legacy controls remain available only until the teacher explicitly enables runs.
      if(action !== 'start' && !classroomRuns.has(quizId)) {
        const state=getOrCreateLiveState(quizId);state.control_state_known=true;
        if(action==='pause') state.paused=!state.paused;else {state.terminated=true;state.paused=false;}
        req.app.get('io')?.to(`quiz_${quizId}`).emit(action==='pause'?'pause_state':'terminate',{paused:state.paused,terminated:state.terminated});
        return res.json({success:true,paused:state.paused,terminated:state.terminated});
      }
      const {run,previous}=await changeClassroomRun(quizId,req.user!.uid,action,req.body?.expected_run_id,req.body?.confirm_replace===true);
      const io=req.app.get('io');
      if(action==='start') {
        if(previous) io?.to(runRoom(quizId,previous.id)).emit('terminate',{terminated:true});
      } else io?.to(runRoom(quizId,run.id)).emit(action==='pause'?'pause_state':'terminate',{paused:run.paused,terminated:run.status!=='active'});
      io?.to(monitoringRoom(quizId)).emit('classroom_changed',{});
      return res.json({success:true,run,paused:run.paused,terminated:run.status!=='active'});
    }catch(error:any){if([403,409,429].includes(error.status)) return res.status(error.status).json({success:false,error:error.message});next(error);}
  });
}

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

  liveState.sessions[sid].whiteboard_state_known = true;
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

router.post('/ping', optionalAuth, async (req: AuthRequest, res, next) => {
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

    if (!canUseLiveAttempt(normalizedQuizId, normalizedSessionId, req.user)) return res.status(403).json({ success: false, error: 'Attempt access denied' });
    try {await bindClassroomAttempt(normalizedQuizId,normalizedSessionId,req.user,req.body?.student_name,true);}
    catch(error:any) {if([403,409,429].includes(error.status)) return res.status(error.status).json({success:false,error:error.message});return next(error);}
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
    if (io && !updated.oldRun) {
      io.to(monitoringRoom(normalizedQuizId)).emit('update_session', {
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
