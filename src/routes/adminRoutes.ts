import { Router } from 'express';
import { adminRequired, tokenRequired } from '../middleware/auth.ts';
import {
  users,
  quizzes,
  results,
  sessionProgress,
  savePersistentData,
  syncDocToFirestore,
  getPersistenceStatus,
  exportDatabaseSnapshot
} from '../store/db.ts';

const router = Router();
const VALID_ROLES = new Set(['admin', 'teacher', 'student']);
const VALID_STATUSES = new Set(['active', 'blocked']);

router.get('/admin', adminRequired, (req, res) => {
  res.render('admin', { users: Array.from(users.values()) });
});

router.get('/api/admin/system_health', adminRequired, (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    success: true,
    persistence: getPersistenceStatus(),
    counts: {
      quizzes: quizzes.size,
      results: results.size,
      users: users.size
    },
    memory: {
      rss_mb: Math.round(mem.rss / 1024 / 1024 * 10) / 10,
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024 * 10) / 10,
      heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024 * 10) / 10
    },
    uptime_seconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

router.get('/api/admin/export_database', adminRequired, (_req, res) => {
  const snapshot = exportDatabaseSnapshot();
  const filename = `quizmoko-backup-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify(snapshot, null, 2));
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
