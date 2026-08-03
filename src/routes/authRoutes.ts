import fs from 'node:fs';
import path from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { User } from '../types.ts';
import {
  users,
  savePersistentData,
  syncDocToFirestore
} from '../store/db.ts';
import {
  clearSessionCookies,
  isDemoAuthEnabled,
  setSessionCookie,
  verifyFirebaseIdToken,
  tokenRequired,
  type AuthRequest
} from '../middleware/auth.ts';
import { loginLimiter } from '../middleware/rateLimit.ts';
import { canUserManageApiKeys } from '../services/quizCreatorAi.ts';

const router = Router();
const VALID_ROLES = new Set<User['role']>(['admin', 'teacher', 'student']);

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

function publicFirebaseConfig(): Record<string, string> {
  try {
    const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
    if (!fs.existsSync(configPath)) return {};
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const allowedKeys = [
      'apiKey',
      'authDomain',
      'projectId',
      'storageBucket',
      'messagingSenderId',
      'appId',
      'measurementId'
    ];
    return Object.fromEntries(
      allowedKeys
        .filter((key) => typeof raw[key] === 'string' && raw[key])
        .map((key) => [key, raw[key]])
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

function firebaseConfigJson(): string {
  return JSON.stringify(publicFirebaseConfig()).replace(/</g, '\\u003c');
}

function safeText(value: unknown, fallback: string, maximumLength = 320): string {
  if (typeof value !== 'string') return fallback;
  const clean = value.trim();
  return clean ? clean.slice(0, maximumLength) : fallback;
}

function safeRole(value: unknown, fallback: User['role'] = 'teacher'): User['role'] {
  return VALID_ROLES.has(value as User['role']) ? value as User['role'] : fallback;
}

async function persistUser(user: User) {
  const previous = users.get(user.uid);
  users.set(user.uid, user);
  savePersistentData();
  try {
    await syncDocToFirestore('users', user.uid, user);
  } catch (error) {
    if (previous) users.set(user.uid, previous);
    else users.delete(user.uid);
    savePersistentData();
    throw error;
  }
}

function tokenFromRequest(req: Request): string {
  const bodyToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (bodyToken) return bodyToken;
  const authorization = typeof req.headers.authorization === 'string'
    ? req.headers.authorization.trim()
    : '';
  return authorization.replace(/^Bearer\s+/i, '');
}

async function establishFirebaseSession(req: Request, res: Response) {
  const idToken = tokenFromRequest(req);
  if (!idToken) {
    res.status(400).json({ success: false, error: 'Firebase ID token is required' });
    return;
  }

  let user: User;
  try {
    user = await verifyFirebaseIdToken(idToken);
  } catch {
    res.status(401).json({ success: false, error: 'Invalid or expired Firebase ID token' });
    return;
  }
  await persistUser(user);
  setSessionCookie(req, res, user, Boolean(req.body?.remember_me));
  res.json({ success: true, uid: user.uid, role: user.role });
}

router.get('/login', (req, res) => {
  res.render('login', { message: null, firebase_config_json: firebaseConfigJson() });
});

router.get('/register', (req, res) => {
  res.render('register', { message: null, firebase_config_json: firebaseConfigJson() });
});

router.get('/api/firebase_config', (req, res) => {
  const config = publicFirebaseConfig();
  if (!config.projectId || !config.apiKey) {
    res.status(503).json({ success: false, error: 'Firebase client configuration is unavailable' });
    return;
  }
  res.json(config);
});

router.get('/logout', (req, res) => {
  clearSessionCookies(req, res);
  res.redirect('/login');
});

/**
 * Legacy AI Studio endpoint. In normal deployments it accepts a verified
 * Firebase token; arbitrary UID-based sessions are available only in explicit
 * test/demo mode.
 */
router.post('/api/set_session', asyncRoute(async (req, res) => {
  if (tokenFromRequest(req)) {
    await establishFirebaseSession(req, res);
    return;
  }
  if (!isDemoAuthEnabled()) {
    res.status(401).json({ success: false, error: 'Verified sign-in is required' });
    return;
  }

  const uid = safeText(req.body?.uid, 'teacher_test', 128);
  const user: User = {
    uid,
    email: safeText(req.body?.email, `${uid}@example.invalid`),
    name: safeText(req.body?.name, 'Demo User'),
    role: safeRole(req.body?.role)
  };
  await persistUser(user);
  setSessionCookie(req, res, user, true);
  res.json({ success: true, uid: user.uid, role: user.role });
}));

router.post('/api/login_session', loginLimiter, asyncRoute(async (req, res) => {
  if (tokenFromRequest(req)) {
    await establishFirebaseSession(req, res);
    return;
  }
  if (!isDemoAuthEnabled()) {
    res.status(400).json({ success: false, error: 'Firebase ID token is required' });
    return;
  }

  const user = users.get('teacher_test')!;
  setSessionCookie(req, res, user, Boolean(req.body?.remember_me));
  res.json({ success: true, uid: user.uid, role: user.role });
}));

router.post('/api/test_login', asyncRoute(async (req, res) => {
  if (!isDemoAuthEnabled()) {
    res.status(404).json({ success: false, error: 'Not found' });
    return;
  }

  const uid = safeText(req.body?.uid, 'teacher_test', 128);
  const user: User = {
    uid,
    email: safeText(req.body?.email, 'test@example.invalid'),
    name: safeText(req.body?.name, 'Test User'),
    role: safeRole(req.body?.role, 'admin')
  };
  await persistUser(user);
  setSessionCookie(req, res, user, true);
  res.json({ success: true, uid: user.uid, role: user.role });
}));

router.post('/api/user/save_api_key', tokenRequired, asyncRoute(async (req: AuthRequest, res) => {
  const { api_key } = req.body || {};
  if (!req.user?.uid) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  if (!canUserManageApiKeys(req.user)) {
    return res.status(403).json({
      success: false,
      error: 'An authenticated user account is required to configure AI API keys.'
    });
  }
  const user = users.get(req.user.uid) || { ...req.user };
  user.stored_custom_key = typeof api_key === 'string' ? api_key.trim().slice(0, 512) : '';
  await persistUser(user);
  res.json({ success: true, message: 'API key updated successfully.' });
}));

export default router;
