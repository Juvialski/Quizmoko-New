import { createHash, randomUUID } from 'node:crypto';
import type { AuthRequest } from '../middleware/auth.ts';
import type { Response } from 'express';
import { aiJobs, quizzes, syncDocToFirestore, deleteDocFromFirestore } from '../store/db.ts';
import { withRequestAbortSignal, waitWithSignal } from './requestContext.ts';
import type { AiWorkLease } from './aiWorkGuard.ts';
import { safeAiErrorMessage } from './geminiRateLimiter.ts';
import { withAttemptLock } from './resultSession.ts';

import type { JobTask, OwnedJob } from '../types.ts';
export type { JobTask, OwnedJob } from '../types.ts';

const active = new Set<string>();
const claims = new Map<string, Promise<OwnedJob>>();
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_JOBS = 2000;
const persist = (job: OwnedJob) => syncDocToFirestore('ai_jobs', job.id, { ...job });
export function serializeJobRequest(task: JobTask, handler: (req: AuthRequest, res: Response) => any) {
  return async (req: AuthRequest, res: Response) => {
    if (req.body?.async_job !== true) return handler(req,res);
    return withAttemptLock('owned-job',jobKey(req,task),()=>handler(req,res));
  };
}
export function jobKey(req: AuthRequest, task: JobTask): string {
  const key = String(req.body?.idempotency_key || '');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw Object.assign(new Error('A secure idempotency key is required.'), { status: 400 });
  return createHash('sha256').update(`${req.user!.uid}\0${task}\0${key}`).digest('hex');
}
export async function ownedJobs(owner: string): Promise<OwnedJob[]> {
  const now = Date.now();
  for (const [id, job] of aiJobs) {
    if (job.updated_at < now - RETENTION_MS && !active.has(id)) {
      await deleteDocFromFirestore('ai_jobs', id); aiJobs.delete(id); continue;
    }
    if (job.status === 'running' && !active.has(id) && !claims.has(job.idempotency_key)) {
      const quiz = [...quizzes.values()].find(q => q.background_job_id === id);
      const complete = quiz?.background_job_complete === true;
      job.status = complete ? (quiz?.review_required_ids?.length ? 'needs_attention' : 'completed') : 'interrupted';
      if (quiz) job.quiz_id = quiz.id;
      job.error = complete ? undefined : 'Processing was interrupted by a server restart. Open any saved draft before deliberately retrying.';
      job.updated_at = now; await persist(job);
    }
  }
  return [...aiJobs.values()].filter(j => j.owner_uid === owner).sort((a,b) => b.started_at-a.started_at).slice(0,50);
}
export function existingJob(req: AuthRequest, task: JobTask): OwnedJob | undefined {
  const key = jobKey(req, task);
  return [...aiJobs.values()].find(j => j.idempotency_key === key && j.owner_uid === req.user!.uid);
}
export async function checkpointJob(job: OwnedJob, quiz: any, completed: number) {
  if (!active.has(job.id)) throw new Error('Job is no longer active');
  job.quiz_id = quiz.id; job.completed = Math.max(job.completed, completed); job.updated_at = Date.now();
  await persist(job);
}
/** Called only after input/credential validation and work-capacity reservation. */
export async function startOwnedJob(req: AuthRequest, res: Response, task: JobTask, lease: AiWorkLease,
  run: (job: OwnedJob) => Promise<string>): Promise<any> {
  let key: string;
  try { key = jobKey(req, task); } catch (error) { lease.release(); throw error; }
  const previous = existingJob(req, task);
  if (previous) { lease.release(); return res.status(202).json({success:true, job:previous, job_id:previous.id}); }
  if (claims.has(key)) {
    lease.release(); const job = await claims.get(key)!;
    return res.status(202).json({success:true,job,job_id:job.id});
  }
  try { await ownedJobs(req.user!.uid); } catch(error) { lease.release(); throw error; }
  if (aiJobs.size >= MAX_JOBS) { lease.release(); return res.status(429).json({success:false,error:'Task history is full. Retry later.'}); }
  const job: OwnedJob = {id:randomUUID(),owner_uid:req.user!.uid,task,
    label:String(task === 'generation' ? 'Generating Quiz' : 'Checking Answers'),status:'running',
    started_at:Date.now(),updated_at:Date.now(),completed:0,total:Number(req.body.num_items || req.body.questions?.length || 0),idempotency_key:key};
  const creation = persist(job).then(() => { aiJobs.set(job.id, job); return job; });
  claims.set(key, creation);
  try { await creation; } catch (error) { lease.release(); throw error; } finally { claims.delete(key); }
  active.add(job.id);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Task deadline exceeded','TimeoutError')), 12*60*1000);
  // Explicit job context replaces HTTP cancellation before the 202 response.
  void withRequestAbortSignal(controller.signal, async () => {
    try {
      const resultId = await waitWithSignal(run(job), controller.signal);
      if (typeof resultId !== 'string' || quizzes.get(resultId)?.user_id !== job.owner_uid) throw new Error('Task did not create an owned draft');
      job.quiz_id = resultId;
      const quiz = quizzes.get(job.quiz_id);
      job.status = quiz?.review_required_ids?.length ? 'needs_attention' : 'completed';
      job.completed = quiz?.questions.length || job.completed;
    } catch (error) {
      job.status = controller.signal.aborted ? 'interrupted' : 'failed';
      job.error = safeAiErrorMessage(error);
    } finally {
      clearTimeout(timer); lease.release(); active.delete(job.id); job.updated_at = Date.now();
      try { await persist(job); } catch { console.warn('[Jobs] Status persistence unavailable'); }
    }
  });
  return res.status(202).json({success:true,job_id:job.id,job:{...job}});
}

export function jobDiagnostics() {
  return {active:active.size, interrupted:[...aiJobs.values()].filter(j=>j.status==='interrupted').length};
}
