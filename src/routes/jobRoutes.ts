import { Router } from 'express';
import { tokenRequired, type AuthRequest } from '../middleware/auth.ts';
import { aiJobs, quizzes } from '../store/db.ts';
import { ownedJobs } from '../services/ownedJobs.ts';
const router = Router();
// Current saved presentation, separate from immutable historical job outcome.
function presentJob(job: any) {
  const quiz = job.quiz_id ? quizzes.get(job.quiz_id) : undefined;
  if (!quiz || quiz.user_id !== job.owner_uid) return {...job, quiz_state: null};
  const review = quiz.questions.some(q => q.verification?.verification_status && q.verification.verification_status !== 'verified');
  return {...job, quiz_state: quiz.is_draft === true || review ? 'draft' : 'published'};
}
router.get('/api/tasks', tokenRequired, async (req: AuthRequest, res) => {
  res.setHeader('Cache-Control','no-store');
  res.json({success:true,jobs:(await ownedJobs(req.user!.uid)).map(presentJob)});
});
router.get('/api/tasks/:id', tokenRequired, async (req: AuthRequest, res) => {
  await ownedJobs(req.user!.uid);
  const job = aiJobs.get(req.params.id);
  if (!job || job.owner_uid !== req.user!.uid) return res.status(404).json({success:false,error:'Task not found'});
  res.setHeader('Cache-Control','no-store'); res.json({success:true,job:presentJob(job)});
});
export default router;
