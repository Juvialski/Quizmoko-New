import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction, CookieOptions } from 'express';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import type { User } from '../types.ts';
import {
  users,
  savePersistentData,
  syncDocToFirestore
} from '../store/db.ts';
import { getFirebaseAdminApp } from '../services/firebaseAdmin.ts';

export interface AuthRequest extends Request {
  user?: User;
}

export const SESSION_COOKIE_NAME = 'quizmoko_session';
const LEGACY_COOKIE_NAME = 'token';
const SESSION_VERSION = 1;
const VALID_ROLES = new Set<User['role']>(['admin', 'teacher', 'student']);
const REQUEST_AI_KEY_FIELDS = [
  'api_key',
  'apiKey',
  'gemini_api_key',
  'geminiApiKey',
  'google_api_key',
  'googleApiKey'
] as const;

let generatedSessionSecret: Buffer | null = null;
let warnedAboutGeneratedSecret = false;

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase());
}

export function isDemoAuthEnabled(): boolean {
  return process.env.NODE_ENV === 'test' || envFlag('ALLOW_DEMO_AUTH', false);
}

function sessionSecret(): Buffer {
  const configured = process.env.SESSION_SECRET;
  if (configured) {
    if (configured.length < 32 && !warnedAboutGeneratedSecret) {
      console.warn('[Auth] SESSION_SECRET should contain at least 32 characters.');
      warnedAboutGeneratedSecret = true;
    }
    return Buffer.from(configured, 'utf8');
  }

  if (!generatedSessionSecret) generatedSessionSecret = randomBytes(32);
  if (!warnedAboutGeneratedSecret) {
    console.warn('[Auth] SESSION_SECRET is not set; sessions will be invalidated whenever this process restarts.');
    warnedAboutGeneratedSecret = true;
  }
  return generatedSessionSecret;
}

function normalizeRole(value: unknown, fallback: User['role'] = 'teacher'): User['role'] {
  return VALID_ROLES.has(value as User['role']) ? value as User['role'] : fallback;
}

function isBlockedUser(user: User | undefined | null): boolean {
  return String(user?.status || '').trim().toLowerCase() === 'blocked';
}

export function stripStudentSuppliedAiKeys(
  body: unknown,
  user: Pick<User, 'role'> | null | undefined
): void {
  if (user?.role !== 'student' || !body || typeof body !== 'object' || Array.isArray(body)) return;
  for (const field of REQUEST_AI_KEY_FIELDS) {
    delete (body as Record<string, unknown>)[field];
  }
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function signPayload(encodedPayload: string): string {
  return createHmac('sha256', sessionSecret()).update(encodedPayload).digest('base64url');
}

function safeSignatureMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function createSessionToken(user: User, expiresInMs: number): string {
  const now = Date.now();
  const encodedPayload = base64UrlJson({
    v: SESSION_VERSION,
    uid: user.uid,
    email: user.email || '',
    name: user.name || user.email || 'User',
    role: normalizeRole(user.role),
    iat: now,
    exp: now + expiresInMs
  });
  return `qms1.${encodedPayload}.${signPayload(encodedPayload)}`;
}

function verifySessionToken(token: string): User | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'qms1') return null;
  if (!safeSignatureMatch(parts[2], signPayload(parts[1]))) return null;

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (
      payload.v !== SESSION_VERSION ||
      typeof payload.uid !== 'string' ||
      !payload.uid ||
      typeof payload.exp !== 'number' ||
      payload.exp <= Date.now()
    ) {
      return null;
    }

    const existing = users.get(payload.uid);
    if (isBlockedUser(existing)) return null;
    return {
      ...(existing || {}),
      uid: payload.uid,
      email: existing?.email || String(payload.email || ''),
      name: existing?.name || String(payload.name || payload.email || 'User'),
      role: normalizeRole(existing?.role || payload.role)
    } as User;
  } catch {
    return null;
  }
}

function cookieIsSecure(req: Request): boolean {
  if (process.env.COOKIE_SECURE !== undefined) return envFlag('COOKIE_SECURE', false);
  const forwardedProtocol = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return req.secure || forwardedProtocol === 'https';
}

function cookieOptions(req: Request, maxAge: number): CookieOptions {
  return {
    httpOnly: true,
    secure: cookieIsSecure(req),
    sameSite: 'lax',
    path: '/',
    maxAge
  };
}

export function setSessionCookie(req: Request, res: Response, user: User, remember = false) {
  const maxAge = remember ? 30 * 24 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000;
  const clearLegacyOptions = cookieOptions(req, 0);
  delete clearLegacyOptions.maxAge;
  res.clearCookie(LEGACY_COOKIE_NAME, clearLegacyOptions);
  res.cookie(SESSION_COOKIE_NAME, createSessionToken(user, maxAge), cookieOptions(req, maxAge));
}

export function clearSessionCookies(req: Request, res: Response) {
  const options = cookieOptions(req, 0);
  delete options.maxAge;
  res.clearCookie(SESSION_COOKIE_NAME, options);
  res.clearCookie(LEGACY_COOKIE_NAME, options);
}

function requestToken(req: Request): string {
  const sessionCookie = req.cookies?.[SESSION_COOKIE_NAME];
  if (typeof sessionCookie === 'string' && sessionCookie) return sessionCookie;

  const authorization = typeof req.headers.authorization === 'string'
    ? req.headers.authorization.trim()
    : '';
  if (authorization) {
    return authorization.replace(/^Bearer\s+/i, '');
  }

  const legacyCookie = req.cookies?.[LEGACY_COOKIE_NAME];
  return typeof legacyCookie === 'string' ? legacyCookie : '';
}

function userFromDecodedToken(decoded: DecodedIdToken): User {
  const existing = users.get(decoded.uid);
  if (isBlockedUser(existing)) {
    throw new Error('This account has been blocked');
  }
  const claimedRole = normalizeRole(decoded.role, 'teacher');
  return {
    ...(existing || {}),
    uid: decoded.uid,
    email: existing?.email || decoded.email || '',
    name: existing?.name || decoded.name || decoded.email || 'User',
    role: normalizeRole(existing?.role, claimedRole)
  } as User;
}

export async function verifyFirebaseIdToken(idToken: string): Promise<User> {
  if (!idToken || idToken.startsWith('qms1.') || idToken.startsWith('user_')) {
    throw new Error('A Firebase ID token is required');
  }
  const adminApp = getFirebaseAdminApp(false);
  if (!adminApp) {
    throw new Error('Firebase token verification is unavailable; check FIREBASE_PROJECT_ID');
  }
  const decoded = await getAuth(adminApp).verifyIdToken(idToken);
  return userFromDecodedToken(decoded);
}

async function persistVerifiedUser(user: User) {
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

function rejectUnauthenticated(req: Request, res: Response) {
  if (req.originalUrl.startsWith('/api/') || req.accepts(['html', 'json']) === 'json') {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }
  const nextPath = req.originalUrl.startsWith('/') ? req.originalUrl : '/';
  res.redirect(302, `/login?next=${encodeURIComponent(nextPath)}`);
}

async function authenticate(req: AuthRequest, res: Response): Promise<User | null> {
  const token = requestToken(req);
  if (token.startsWith('qms1.')) {
    return verifySessionToken(token);
  }

  if (token.startsWith('user_') && isDemoAuthEnabled()) {
    const uid = token.slice('user_'.length);
    const user = users.get(uid) || {
      uid,
      email: `${uid}@example.invalid`,
      name: 'Demo User',
      role: uid === 'teacher_test' ? 'admin' : 'teacher'
    };
    return isBlockedUser(user) ? null : user;
  }

  if (token) {
    let user: User;
    try {
      user = await verifyFirebaseIdToken(token);
    } catch {
      return null;
    }
    await persistVerifiedUser(user);
    setSessionCookie(req, res, user, true);
    return user;
  }

  if (isDemoAuthEnabled()) {
    const user = users.get('teacher_test') || {
      uid: 'teacher_test',
      email: 'teacher@quizmoko.test',
      name: 'Teacher Test',
      role: 'admin'
    };
    return isBlockedUser(user) ? null : user;
  }

  return null;
}

export async function tokenRequired(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const user = await authenticate(req, res);
    if (!user) {
      clearSessionCookies(req, res);
      rejectUnauthenticated(req, res);
      return;
    }
    req.user = user;
    stripStudentSuppliedAiKeys(req.body, user);
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Attaches a verified/demo user when available but never redirects or rejects.
 * Public quiz-taking/result-token routes can layer their own access checks.
 */
export async function optionalAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const user = await authenticate(req, res);
    if (user) {
      req.user = user;
      stripStudentSuppliedAiKeys(req.body, user);
    }
    next();
  } catch {
    next();
  }
}

export async function adminRequired(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const user = await authenticate(req, res);
    if (!user) {
      clearSessionCookies(req, res);
      rejectUnauthenticated(req, res);
      return;
    }
    req.user = user;
    if (user.role !== 'admin') {
      res.status(403).json({ success: false, error: 'Administrator access required' });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
}
