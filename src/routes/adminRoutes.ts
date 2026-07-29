import { Router } from 'express';
import { tokenRequired } from '../middleware/auth.ts';
import { users, sessionProgress } from '../store/db.ts';

const router = Router();

router.get('/admin', tokenRequired, (req, res) => {
  res.render('admin', { users: Array.from(users.values()) });
});

router.get('/api/admin/users', (req, res) => {
  res.json({ success: true, users: Array.from(users.values()) });
});

router.post('/api/admin/update_user_status', (req, res) => {
  const { uid, status, role } = req.body;
  const user = users.get(uid);
  if (user) {
    if (role) user.role = role;
    if (status) user.status = status;
    users.set(uid, user);
  }
  res.json({ success: true });
});

router.get('/api/ollama_tags', (req, res) => {
  res.json({ success: true, models: [] });
});

router.post('/api/install_model', (req, res) => {
  res.json({ success: true, message: 'Installing model...' });
});

router.get('/api/usage/stats', (req, res) => {
  res.json({ success: true, daily_stats: {} });
});

router.get('/api/usage/sync_history', (req, res) => {
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
