import { Router } from 'express';
import { adminRequired, tokenRequired } from '../middleware/auth.ts';
import {
  users,
  sessionProgress,
  savePersistentData,
  syncDocToFirestore
} from '../store/db.ts';

const router = Router();
const VALID_ROLES = new Set(['admin', 'teacher', 'student']);
const VALID_STATUSES = new Set(['active', 'blocked']);

router.get('/admin', adminRequired, (req, res) => {
  res.render('admin', { users: Array.from(users.values()) });
});

router.get('/api/admin/users', adminRequired, (req, res) => {
  res.json({ success: true, users: Array.from(users.values()) });
});

router.post('/api/admin/update_user_status', adminRequired, async (req, res, next) => {
  const { uid, status, role } = req.body;
  if (typeof uid !== 'string' || !uid.trim()) {
    return res.status(400).json({ success: false, error: 'uid is required' });
  }
  const user = users.get(uid);
  if (!user) {
    return res.status(404).json({ success: false, error: 'User not found' });
  }

  if (role !== undefined && !VALID_ROLES.has(role)) {
    return res.status(400).json({ success: false, error: 'Invalid role' });
  }
  if (status !== undefined && (
    typeof status !== 'string'
    || !VALID_STATUSES.has(status.trim().toLowerCase())
  )) {
    return res.status(400).json({ success: false, error: 'Invalid status' });
  }

  const updatedUser = { ...user };
  if (role) updatedUser.role = role;
  if (status !== undefined) updatedUser.status = status.trim().toLowerCase();
  users.set(uid, updatedUser);
  savePersistentData();
  try {
    await syncDocToFirestore('users', uid, updatedUser);
  } catch (error) {
    users.set(uid, user);
    savePersistentData();
    next(error);
    return;
  }
  res.json({ success: true, user: updatedUser });
});

router.post('/api/install_model', adminRequired, (_req, res) => {
  res.status(501).json({
    success: false,
    error: 'Remote Ollama model installation is unsupported. Install models on the configured Ollama host.'
  });
});

router.get('/api/usage/stats', adminRequired, (req, res) => {
  res.json({ success: true, daily_stats: {} });
});

router.get('/api/usage/sync_history', adminRequired, (req, res) => {
  res.json({ success: true });
});

router.get('/api/progress/:session_id', (req, res) => {
  const data = sessionProgress.get(req.params.session_id) || {
    message: 'Processing...',
    percentage: 10,
    status: 'processing'
  };
  res.json(data);
});

export default router;
