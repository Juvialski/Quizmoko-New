import { Router } from 'express';
import { users } from '../store/db.ts';

const router = Router();

router.get('/login', (req, res) => {
  res.render('login', { message: null });
});

router.get('/register', (req, res) => {
  res.render('register', { message: null });
});

router.get('/logout', (req, res) => {
  res.clearCookie('token');
  res.redirect('/login');
});

router.post('/api/set_session', (req, res) => {
  const { uid, email, name, role } = req.body;
  const user = { uid: uid || 'user_123', email: email || 'user@example.com', name: name || 'User', role: role || 'student' };
  users.set(user.uid, user);
  res.cookie('token', `user_${user.uid}`, { maxAge: 2592000000, httpOnly: true });
  res.json({ success: true, role: user.role });
});

router.post('/api/login_session', (req, res) => {
  res.cookie('token', 'user_teacher_test', { maxAge: 2592000000, httpOnly: true });
  res.json({ success: true });
});

router.post('/api/test_login', (req, res) => {
  const { uid = 'teacher_test', email = 'test@example.com', name = 'Test User' } = req.body;
  const user = { uid, email, name, role: 'admin' };
  users.set(uid, user);
  res.cookie('token', `user_${uid}`, { maxAge: 2592000000, httpOnly: true });
  res.json({ success: true });
});

export default router;
