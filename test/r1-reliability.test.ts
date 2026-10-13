import { parseServiceAccount, hasFirebaseAdminCredentials } from '../src/services/firebaseAdmin.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { demoDataEnabled, validateRuntimeConfig } from '../src/services/runtimeConfig.ts';
import { isFirestoreRequired, results, quizzes, users } from '../src/store/db.ts';
import { createSessionToken } from '../src/middleware/auth.ts';
import { generateGeminiContent, resetGeminiRateLimiterForTests } from '../src/services/geminiRateLimiter.ts';
import { acquireAiWork, resetAiWorkGuardForTests } from '../src/services/aiWorkGuard.ts';
import { validateWorksheetUploads } from '../src/services/worksheetUploadSafety.ts';
import { registerRoutes } from '../src/routes/index.ts';
import { errorHandler } from '../src/middleware/errorHandler.ts';
import { pruneInactiveLiveSessions, updateLiveSession } from '../src/services/socket.ts';
import { liveSessions } from '../src/store/db.ts';

test('production rejects weak/missing secrets, demo auth and persistence bypass', () => {
  const previous = { ...process.env };
  try {
    process.env.RENDER = 'true'; process.env.NODE_ENV = 'production';
    delete process.env.SESSION_SECRET; delete process.env.REQUIRE_FIRESTORE;
    process.env.ALLOW_DEMO_AUTH = 'true';
    assert.equal(demoDataEnabled(), false);
    assert.equal(isFirestoreRequired(), true);
    assert.throws(validateRuntimeConfig, /SESSION_SECRET/);
    process.env.SESSION_SECRET = 'a'.repeat(64);
    assert.throws(validateRuntimeConfig, /SESSION_SECRET/);
    process.env.SESSION_SECRET = randomBytes(32).toString('hex');
    assert.throws(validateRuntimeConfig, /Demo/);
    process.env.ALLOW_DEMO_AUTH = 'false'; process.env.REQUIRE_FIRESTORE = 'false';
    assert.throws(validateRuntimeConfig, /Firestore/);
    process.env.REQUIRE_FIRESTORE = 'true'; process.env.TRUSTED_ORIGINS = 'https://quiz.example.invalid';
    assert.doesNotThrow(validateRuntimeConfig);
  } finally { process.env = previous; }
});

test('hung provider is cancelled, permanent errors run once and upstream HTTP-date Retry-After survives', async () => {
  resetGeminiRateLimiterForTests();
  const before = process.env.GEMINI_REQUEST_TIMEOUT_MS;
  process.env.GEMINI_REQUEST_TIMEOUT_MS = '25';
  try {
    let signal: AbortSignal;
    await assert.rejects(generateGeminiContent({ models: { generateContent(req: any) {
      signal = req.config.abortSignal; return new Promise(() => {});
    } } }, { model: 'gemini-3.5-flash-lite' }), { name: 'TimeoutError' });
    assert.equal(signal!.aborted, true);
    let calls = 0;
    await assert.rejects(generateGeminiContent({ models: { generateContent() {
      calls++; throw Object.assign(new Error('secret must not be logged'), { status: 401 });
    } } }, { model: 'gemini-3.1-flash-lite' }), { status: 401 });
    assert.equal(calls, 1);
    await assert.rejects(generateGeminiContent({ models: { generateContent() {
      throw { status: 429, response: { headers: { 'retry-after': new Date(Date.now() + 90_000).toUTCString() } } };
    } } }, { model: 'gemini-3.1-flash-lite' }), (error: any) => error.retryAfterSeconds >= 89);
  } finally {
    if (before === undefined) delete process.env.GEMINI_REQUEST_TIMEOUT_MS; else process.env.GEMINI_REQUEST_TIMEOUT_MS = before;
    resetGeminiRateLimiterForTests();
  }
});

test('duplicate AI work is rejected and lease release is idempotent', () => {
  resetAiWorkGuardForTests();
  const lease = acquireAiWork({ userId: 'test', workKey: 'same' });
  assert.throws(() => acquireAiWork({ userId: 'test', workKey: 'same' }), /already running/);
  lease.release(); lease.release();
  const next = acquireAiWork({ userId: 'test', workKey: 'same' }); next.release();
});

test('upload preflight rejects spoofed signatures, oversized dimensions and aggregate decoded work', async () => {
  await assert.rejects(validateWorksheetUploads([{ buffer: Buffer.from('not PDF'), mimetype: 'application/pdf' }]), /signature/);
  const tiny = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } }).png().toBuffer();
  await validateWorksheetUploads([{ buffer: tiny, mimetype: 'image/png' }]);
  await assert.rejects(validateWorksheetUploads([{ buffer: tiny, mimetype: 'image/jpeg' }]), /signature/);
  process.env.WORKSHEET_DECODED_BYTES = '10';
  try { await assert.rejects(validateWorksheetUploads([{ buffer: tiny, mimetype: 'image/png' }]), /budget/); }
  finally { delete process.env.WORKSHEET_DECODED_BYTES; }
  const wide = await sharp({ create: { width: 10001, height: 1, channels: 3, background: 'white' } }).png().toBuffer();
  await assert.rejects(validateWorksheetUploads([{ buffer: wide, mimetype: 'image/png' }]), /dimensions/);
});

test('result privacy uses exact identity and capabilities; public quiz and owner access remain compatible', async () => {
  const quizId = 'r1_privacy_quiz'; const resultId = 'res_r1_private';
  const owner = { uid: 'r1_owner', name: 'Same Name', email: 'same@example.invalid', role: 'student' as const };
  const other = { ...owner, uid: 'r1_other' };
  users.set(owner.uid, owner); users.set(other.uid, other);
  quizzes.set(quizId, { id: quizId, title: 'Public quiz', user_id: 'teacher_owner', questions: [{ question: 'Choose.', type: 'multiple_choice', options: ['Alpha', 'Beta'], answer: 'A' }] } as any);
  results.set(resultId, { id: resultId, quiz_id: quizId, user_id: owner.uid, student_name: owner.email, is_in_progress: false, access_token_hash: 'unusable' } as any);
  const app = express(); app.use(express.json()); registerRoutes(app); app.use(errorHandler);
  const server = http.createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const headers = (u: typeof owner) => ({ Authorization: `Bearer ${createSessionToken(u, 60_000)}` });
  try {
    assert.equal((await fetch(`${base}/api/get_result/${resultId}`, { headers: headers(other) })).status, 404);
    results.get(resultId)!.student_name = owner.name;
    assert.equal((await fetch(`${base}/api/get_result/${resultId}`, { headers: headers(other) })).status, 404);
    assert.equal((await fetch(`${base}/api/get_result/${resultId}`, { headers: headers(owner) })).status, 200);
    const quiz = await fetch(`${base}/api/quiz/${quizId}`); assert.equal(quiz.status, 200);
    const payload = await quiz.text(); assert.ok(!payload.includes('"answer"'));
    const denied = await fetch(`${base}/api/load_progressive_result`, { method: 'POST', headers: { ...headers(other), 'Content-Type': 'application/json' }, body: JSON.stringify({ quiz_id: quizId, session_id: 'r1_private' }) });
    assert.equal(denied.status, 403);
    const previous = { ...process.env };
    try {
      process.env.NODE_ENV = 'production'; process.env.RENDER = 'true';
      const unrelated = await fetch(`${base}/api/unrelated_route`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quiz_id: quizId, session_id: 'weak' }) });
      assert.equal(unrelated.status, 404, 'Attempt guard must not intercept unrelated AI/worksheet routes.');
    } finally { process.env = previous; }
    const health = await fetch(`${base}/healthz`); const healthBody = await health.text();
    assert.ok(!healthBody.includes('Directory')); assert.ok(!healthBody.includes('lastError'));
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    quizzes.delete(quizId); results.delete(resultId); users.delete(owner.uid); users.delete(other.uid);
  }
});

test('inactive live sessions are pruned without discarding classroom controls', () => {
  const quizId = 'r1_live_cleanup'; quizzes.set(quizId, { id: quizId } as any);
  liveSessions.set(quizId, { paused: true, terminated: false, sessions: { old: { last_active: 1 }, active: { last_active: Date.now() } } } as any);
  pruneInactiveLiveSessions();
  assert.equal(liveSessions.get(quizId)!.paused, true);
  assert.equal(liveSessions.get(quizId)!.sessions.old, undefined);
  assert.ok(liveSessions.get(quizId)!.sessions.active);
  liveSessions.get(quizId)!.terminated = true;
  results.set('res_r1_completed', { id: 'res_r1_completed', quiz_id: quizId, is_in_progress: false, total_score: 0 } as any);
  const updated = updateLiveSession(quizId, { session_id: 'r1_completed', status: 'started' });
  assert.equal(updated.liveState!.terminated, true);
  assert.equal(updated.session!.status, 'Completed');
  results.delete('res_r1_completed');
  quizzes.delete(quizId); pruneInactiveLiveSessions(); assert.equal(liveSessions.has(quizId), false);
});

test('isolated production startup never listens without credentials or seeds demo records', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'quizmoko-startup-'));
  const env = { ...process.env, NODE_ENV: 'production', RENDER: 'true', REQUIRE_FIRESTORE: '',
    ALLOW_DEMO_AUTH: 'false', FIREBASE_ADMIN_ENABLED: 'false', FIREBASE_WEB_FALLBACK: 'false',
    FIREBASE_JSON: '', FIREBASE_SERVICE_ACCOUNT_JSON: '', FIREBASE_SERVICE_ACCOUNT_BASE64: '', GOOGLE_APPLICATION_CREDENTIALS: '',
    AI_STUDIO_SANDBOX: 'false', AIS_SANDBOX: 'false', QUIZMOKO_DATA_DIR: directory };
  try {
    const output = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'test/r1-startup-child.ts'], { env, timeout: 60_000 });
    assert.match(output.stdout, /startup rejected/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('legacy Render FIREBASE_JSON is recognized without logging or migrating credentials', () => {
  const previous = { ...process.env };
  try {
    process.env.AI_STUDIO_SANDBOX = 'false'; process.env.FIREBASE_ADMIN_ENABLED = 'true';
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON; delete process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    process.env.FIREBASE_JSON = JSON.stringify({ type: 'service_account', project_id: 'offline-test', private_key: 'synthetic-key', client_email: 'test@example.invalid' });
    assert.equal(hasFirebaseAdminCredentials(), true);
    assert.equal(parseServiceAccount()?.project_id, 'offline-test');
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'canonical-wins' });
    assert.equal(parseServiceAccount()?.project_id, 'canonical-wins');
  } finally { process.env = previous; }
});
