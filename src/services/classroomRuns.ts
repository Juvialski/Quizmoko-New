import { randomUUID } from 'node:crypto';
import { classroomRuns, quizzes, results, liveSessions, syncDocToFirestore, savePersistentData, isFirestoreRequired } from '../store/db.ts';
import { withAttemptLock } from './resultSession.ts';
import type { ClassroomRun, QuizResult } from '../types.ts';

export const runRoom = (quizId: string, runId: string) => `classroom_${quizId}_${runId}`;
const admitting = new Set<string>();
export const lifecycleLock = <T>(quizId: string, action: () => Promise<T>) => withAttemptLock('classroom', quizId, action);

/** Called inside the lifecycle lock. Binding alone never authorizes answer edits. */
export function classroomAnswerClosed(quizId: string, record?: QuizResult): boolean {
  if (!record?.live_run_id) return false;
  const run = classroomRuns.get(quizId);
  return !run || run.id !== record.live_run_id || run.status !== 'active';
}

/** Publish controls only after persistence. Serialize admissions with transitions. */
export async function changeClassroomRun(quizId: string, ownerUid: string, action: 'start' | 'pause' | 'end', expected?: string, replace = false) {
  return lifecycleLock(quizId, async () => {
    const previous = classroomRuns.get(quizId);
    if (expected !== previous?.id) throw Object.assign(new Error('Session changed. Refresh the classroom controls.'), {status:409});
    if (action === 'start' && previous?.status === 'active' && !replace) throw Object.assign(new Error('Confirm ending the current session before starting another.'), {status:409});
    if (action !== 'start' && (!previous || previous.status !== 'active')) throw Object.assign(new Error('Start a new session first.'), {status:409});
    const run: ClassroomRun = action === 'start'
      ? {id: randomUUID(), quiz_id:quizId, owner_uid:ownerUid, started_at:new Date().toISOString(), status:'active', paused:false}
      : {...previous!, paused:action === 'pause' ? !previous!.paused : false, status:action === 'end' ? 'ended' : 'active'};
    // Local fallback must include the mutation in its acknowledged snapshot.
    if(!isFirestoreRequired()) classroomRuns.set(quizId,run);
    try { await syncDocToFirestore('live_runs',quizId,run); }
    catch(error) { if(previous) classroomRuns.set(quizId,previous); else classroomRuns.delete(quizId); savePersistentData(); throw error; }
    classroomRuns.set(quizId,run);
    if(action === 'start') liveSessions.delete(quizId);
    else {const state=liveSessions.get(quizId);if(state){state.run=run;state.paused=run.paused;state.terminated=run.status !== 'active';state.control_state_known=true;}}
    savePersistentData();
    return {run,previous};
  });
}

/** Only new identities bind to the current run. Existing legacy records stay legacy. */
export async function bindClassroomAttempt(quizId: string, sessionId: string, user: any, studentName?: string, admitStandalone = false) {
  const key=`res_${sessionId}`;
  const known=results.get(key);
  if(known && !admitting.has(key)) {
    if(known.quiz_id !== quizId || (known.user_id && known.user_id !== user?.uid)) throw Object.assign(new Error('Attempt access denied'),{status:403});
    return known;
  }
  return lifecycleLock(quizId, () => withAttemptLock(quizId,sessionId,async () => {
    const existing = results.get(`res_${sessionId}`);
    if (existing) {
      if(existing.quiz_id !== quizId || (existing.user_id && existing.user_id !== user?.uid)) throw Object.assign(new Error('Attempt access denied'),{status:403});
      return existing;
    }
    const run = classroomRuns.get(quizId);
    if (!run && !admitStandalone) return undefined;
    // First pings persist standalone identity without changing grading-only legacy writes.
    if (run && run.status !== 'active') throw Object.assign(new Error('This classroom session has ended. Wait for the teacher to start a new session.'),{status:409});
    const count = [...results.values()].filter(r=>r.quiz_id===quizId && r.live_run_id===run?.id).length;
    if(count >= 5000) throw Object.assign(new Error('Classroom participant limit reached'),{status:429});
    const record: QuizResult = {id:`res_${sessionId}`,quiz_id:quizId,session_id:sessionId,
      ...(run ? {live_run_id:run.id, live_run_started_at:run.started_at} : {}),
      ...(user?.uid ? {user_id:user.uid} : {}), student_name:String(studentName || 'Student').slice(0,120),
      created_at:new Date().toISOString(),is_in_progress:true,answers:{},answer_revisions:{},graded_details:[],total_score:0,
      max_score:(quizzes.get(quizId)?.questions || []).reduce((sum,q)=>sum+(Number(q.points)||1),0)};
    admitting.add(key);
    if(!isFirestoreRequired()) results.set(record.id,record);
    try {
      await syncDocToFirestore('results',record.id,record);
      results.set(record.id,record);savePersistentData();return record;
    } catch(error) {results.delete(record.id);savePersistentData();throw error;}
    finally {admitting.delete(key);}
  }));
}

export function attemptControls(quizId:string, sessionId:string) {
  const run = classroomRuns.get(quizId);
  const record = results.get(`res_${sessionId}`);
  if (!run) return record?.live_run_id ? {paused:false,terminated:true} : null;
  const belongs = record?.quiz_id === quizId && record.live_run_id === run.id;
  return {paused:belongs && run.paused, terminated:Boolean(record?.live_run_id) && (!belongs || run.status !== 'active')};
}
