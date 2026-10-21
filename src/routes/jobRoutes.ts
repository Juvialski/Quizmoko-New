import { Router } from 'express';
import { tokenRequired, type AuthRequest } from '../middleware/auth.ts';
import { aiJobs } from '../store/db.ts';
import { ownedJobs } from '../services/ownedJobs.ts';
const router = Router();
router.get('/api/tasks', tokenRequired, async (req: AuthRequest, res) => {
  res.setHeader('Cache-Control','no-store');
  res.json({success:true,jobs:await ownedJobs(req.user!.uid)});
});
router.get('/api/tasks/:id', tokenRequired, async (req: AuthRequest, res) => {
  await ownedJobs(req.user!.uid);
  const job = aiJobs.get(req.params.id);
  if (!job || job.owner_uid !== req.user!.uid) return res.status(404).json({success:false,error:'Task not found'});
  res.setHeader('Cache-Control','no-store'); res.json({success:true,job});
});
export default router;
