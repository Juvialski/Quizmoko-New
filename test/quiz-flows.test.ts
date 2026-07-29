import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test, { after, before } from 'node:test';
import express from 'express';
import cookieParser from 'cookie-parser';
import { JSDOM } from 'jsdom';

let server: ReturnType<ReturnType<typeof express>['listen']>;
let baseUrl = '';
let originalCwd = '';
let tempRoot = '';
let quizzes: Map<string, any>;
let results: Map<string, any>;
let users: Map<string, any>;
let liveSessions: Map<string, any>;
let flushPendingPersistence: (timeoutMs?: number) => Promise<boolean>;
let createSessionToken: (user: any, expiresInMs: number) => string;
let createGradeProof: (input: {
  quizId: string;
  questionIndex: number;
  question: any;
  studentAnswer: any;
  isCorrect: boolean;
  scoreFraction: number;
}) => string;

const quizId = 'quiz_flow_test';
const sensitiveValue = 'SHOULD_NEVER_LEAK_FROM_QUIZ';
const ownerOnlySolution = 'OWNER_ONLY_WORKED_SOLUTION';
const ownerOnlyGoldenReference = 'OWNER_ONLY_GOLDEN_REFERENCE';

async function requestJson(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; body: any; contentType: string }> {
  const response = await fetch(`${baseUrl}${url}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers || {})
    },
    redirect: 'manual'
  });
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();
  let body: any = text;

  if (contentType.includes('application/json') && text) {
    body = JSON.parse(text);
  }

  return { status: response.status, body, contentType };
}

before(async () => {
  originalCwd = process.cwd();
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quizmoko-flow-'));
  process.chdir(tempRoot);

  process.env.NODE_ENV = 'test';
  process.env.ALLOW_DEMO_AUTH = 'true';
  process.env.SESSION_SECRET = 'quizmoko-test-session-secret-32-characters';
  process.env.QUIZMOKO_DATA_DIR = path.join(tempRoot, 'data');

  const db = await import('../src/store/db.ts');
  const [
    quizRoutes,
    gradingRoutes,
    resultsRoutes,
    aiRoutes,
    liveRoutes,
    worksheetRoutes,
    gradeProof,
    auth
  ] = await Promise.all([
    import('../src/routes/quizRoutes.ts'),
    import('../src/routes/gradingRoutes.ts'),
    import('../src/routes/resultsRoutes.ts'),
    import('../src/routes/aiRoutes.ts'),
    import('../src/routes/liveRoutes.ts'),
    import('../src/routes/worksheetRoutes.ts'),
    import('../src/services/gradeProof.ts'),
    import('../src/middleware/auth.ts')
  ]);
  createGradeProof = gradeProof.createGradeProof;
  createSessionToken = auth.createSessionToken;

  quizzes = db.quizzes;
  results = db.results;
  users = db.users;
  liveSessions = db.liveSessions;
  flushPendingPersistence = db.flushPendingPersistence;
  quizzes.clear();
  results.clear();

  quizzes.set(quizId, {
    id: quizId,
    user_id: 'teacher_test',
    title: 'Quiz Flow Stability',
    subject: 'Science',
    time_limit: 10,
    quiz_mode: 'back_and_forth',
    created_at: '2026-07-29T00:00:00.000Z',
    api_key: sensitiveValue,
    golden_reference: { 1: ownerOnlyGoldenReference },
    answer_key: { 1: 'B' },
    questions: [
      {
        question: 'Which organelle is the powerhouse of the cell?',
        options: ['A) Nucleus', 'B) Mitochondria', 'C) Ribosome', 'D) Golgi apparatus'],
        answer: 'B) Mitochondria',
        solution: ownerOnlySolution,
        explanation: 'The keyed choice identifies the organelle.',
        answer_explanation: 'Mitochondria release usable cellular energy.',
        type: 'multiple_choice'
      },
      {
        question: 'What is the additive identity?',
        options: [],
        answer: '0',
        type: 'identification'
      }
    ]
  });

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(originalCwd, 'views'));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use(quizRoutes.default);
  app.use(gradingRoutes.default);
  app.use(resultsRoutes.default);
  app.use(aiRoutes.default);
  app.use(liveRoutes.default);
  app.use(worksheetRoutes.default);
  app.get('/api/test/protected', auth.tokenRequired, (req, res) => {
    res.json({ success: true, uid: (req as any).user?.uid });
  });
  app.all('/api/*', (req, res) => {
    res.status(404).json({ success: false, error: `API route ${req.originalUrl} not found` });
  });

  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    server.close();
    await once(server, 'close');
  }

  if (flushPendingPersistence) {
    await flushPendingPersistence(5_000);
  }
  process.chdir(originalCwd);
  const resolvedTemp = path.resolve(tempRoot);
  const resolvedSystemTemp = path.resolve(os.tmpdir());
  if (resolvedTemp.startsWith(`${resolvedSystemTemp}${path.sep}`)) {
    try {
      fs.rmSync(resolvedTemp, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100
      });
    } catch (error: any) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error?.code)) throw error;
      console.warn(`Temporary test directory is still locked and will be left for OS cleanup: ${resolvedTemp}`);
    }
  }
});

test('quiz creation and taking contracts remain stable', async (t) => {
  await t.test('student share links and grading work without a teacher session', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousDemoAuth = process.env.ALLOW_DEMO_AUTH;
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_DEMO_AUTH = 'false';

    try {
      const quizResponse = await fetch(`${baseUrl}/quiz/${quizId}`, { redirect: 'manual' });
      assert.equal(quizResponse.status, 200);

      const gradeResponse = await requestJson('/api/grade_individual', {
        method: 'POST',
        body: JSON.stringify({
          quiz_id: quizId,
          q_index: 0,
          student_answer: 'Mitochondria'
        })
      });
      assert.equal(gradeResponse.status, 200);
      assert.equal(gradeResponse.body.is_correct, true);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      process.env.ALLOW_DEMO_AUTH = previousDemoAuth;
    }
  });

  await t.test('public live pings reject unknown or malformed IDs before allocating state', async () => {
    const beforeSize = liveSessions.size;
    const unknown = await requestJson('/ping', {
      method: 'POST',
      body: JSON.stringify({ quiz_id: 'quiz_does_not_exist', session_id: 'sess_1' })
    });
    assert.equal(unknown.status, 404);
    assert.equal(liveSessions.size, beforeSize);

    const malformed = await requestJson('/ping', {
      method: 'POST',
      body: JSON.stringify({ quiz_id: quizId, session_id: 'bad/session' })
    });
    assert.equal(malformed.status, 400);
    assert.equal(liveSessions.has(quizId), false);

    const valid = await requestJson('/ping', {
      method: 'POST',
      body: JSON.stringify({
        quiz_id: quizId,
        session_id: 'sess_valid',
        student_name: 'S'.repeat(500),
        current_q: 999,
        score: 999
      })
    });
    assert.equal(valid.status, 200);
    assert.equal(liveSessions.get(quizId).sessions.sess_valid.student_name.length, 120);
    assert.equal(liveSessions.get(quizId).sessions.sess_valid.current_q, 2);
    assert.equal(liveSessions.get(quizId).sessions.sess_valid.score, 2);
  });

  await t.test('blocked users are rejected even with an existing signed session', async () => {
    const blockedUser = {
      uid: 'blocked_user',
      email: 'blocked@example.invalid',
      name: 'Blocked User',
      role: 'teacher',
      status: 'blocked'
    };
    users.set(blockedUser.uid, blockedUser);
    const sessionToken = createSessionToken(blockedUser, 60_000);
    const cookie = `quizmoko_session=${encodeURIComponent(sessionToken)}`;

    try {
      const denied = await requestJson('/api/test/protected', {
        headers: { Cookie: cookie }
      });
      assert.equal(denied.status, 401);
      assert.equal(denied.body.success, false);

      users.set(blockedUser.uid, { ...blockedUser, status: 'active' });
      const allowed = await requestJson('/api/test/protected', {
        headers: { Cookie: cookie }
      });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.body.uid, blockedUser.uid);
    } finally {
      users.delete(blockedUser.uid);
    }
  });

  await t.test('public quiz payloads never expose answer keys, solutions, or API keys', async () => {
    const response = await requestJson(`/api/quiz/${quizId}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.api_key, undefined);
    assert.equal(response.body.gemini_api_key, undefined);
    assert.equal(response.body.golden_reference, undefined);
    assert.equal(response.body.answer_key, undefined);
    assert.equal(response.body.questions[0].answer, undefined);
    assert.equal(response.body.questions[0].solution, undefined);
    assert.equal(response.body.questions[0].explanation, undefined);
    assert.equal(response.body.questions[0].answer_explanation, undefined);
    assert.doesNotMatch(JSON.stringify(response.body), new RegExp(sensitiveValue));
    assert.doesNotMatch(JSON.stringify(response.body), new RegExp(ownerOnlySolution));
    assert.doesNotMatch(JSON.stringify(response.body), new RegExp(ownerOnlyGoldenReference));
  });

  await t.test('quiz HTML never embeds persisted secrets or solution keys', async () => {
    const response = await fetch(`${baseUrl}/quiz/${quizId}`, { redirect: 'manual' });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.doesNotMatch(html, new RegExp(sensitiveValue));
    assert.doesNotMatch(html, new RegExp(ownerOnlySolution));
    assert.doesNotMatch(html, new RegExp(ownerOnlyGoldenReference));

    const editorResponse = await fetch(`${baseUrl}/edit/${quizId}`, { redirect: 'manual' });
    assert.equal(editorResponse.status, 200);
    const editorHtml = await editorResponse.text();
    assert.match(editorHtml, new RegExp(ownerOnlySolution));
    assert.match(editorHtml, new RegExp(ownerOnlyGoldenReference));
  });

  await t.test('multiple-choice grading accepts exact option text', async () => {
    const response = await requestJson('/api/grade_individual', {
      method: 'POST',
      body: JSON.stringify({
        quiz_id: quizId,
        q_index: 0,
        student_answer: 'Mitochondria'
      })
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.is_correct, true);
  });

  await t.test('progressive results are bounded and deterministically rescored', async () => {
    const response = await requestJson('/api/save_progressive_result', {
      method: 'POST',
      body: JSON.stringify({
        quiz_id: quizId,
        session_id: 'progressive-spoof',
        student_name: 'P'.repeat(500),
        score: 999,
        accuracy_pct: 999,
        progressive_results: [
          { user_answer: 'Nucleus', is_correct: true, score_fraction: 1 },
          { user_answer: 0, is_correct: false, score_fraction: 0 },
          { user_answer: 'extra', is_correct: true, score_fraction: 1 }
        ]
      })
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.total_score, 1);
    assert.equal(response.body.max_score, 2);
    const stored = results.get(response.body.result_id);
    assert.equal(stored.graded_details.length, 2);
    assert.equal(stored.student_name.length, 120);
    assert.equal(stored.accuracy_pct, 50);
  });

  await t.test('submission preserves numeric zero answers', async () => {
    const progressive = await requestJson('/api/save_progressive_result', {
      method: 'POST',
      body: JSON.stringify({
        quiz_id: quizId,
        session_id: 'numeric-zero',
        student_name: 'Flow Test',
        progressive_results: [
          { user_answer: 'Mitochondria' },
          { user_answer: 0 }
        ]
      })
    });
    assert.equal(progressive.status, 200);
    assert.equal(progressive.body.result_id, 'res_numeric-zero');

    const response = await requestJson('/submit', {
      method: 'POST',
      body: JSON.stringify({
        quiz_id: quizId,
        session_id: 'numeric-zero',
        student_name: 'Flow Test',
        answers: {
          0: 'Mitochondria',
          1: 0
        }
      })
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.total_score, 2);
    assert.equal(response.body.max_score, 2);
    assert.equal(response.body.result_id, 'res_numeric-zero');
    assert.ok(results.has(response.body.result_id));
    assert.equal(results.get(response.body.result_id).is_in_progress, false);
  });

  await t.test('submission and progressive saves never overwrite colliding sessions', async () => {
    const collisionId = 'res_collision-session';
    const collisionRecord = {
      id: collisionId,
      quiz_id: 'another_quiz',
      session_id: 'collision-session',
      student_name: 'Original Student',
      is_in_progress: false,
      marker: 'preserve-me'
    };
    results.set(collisionId, collisionRecord as any);

    const progressiveConflict = await requestJson('/api/save_progressive_result', {
      method: 'POST',
      body: JSON.stringify({
        quiz_id: quizId,
        session_id: 'collision-session',
        student_name: 'Attacker',
        progressive_results: []
      })
    });
    assert.equal(progressiveConflict.status, 409);
    assert.equal(results.get(collisionId).marker, 'preserve-me');

    const submit = await requestJson('/submit', {
      method: 'POST',
      body: JSON.stringify({
        quiz_id: quizId,
        session_id: 'collision-session',
        student_name: 'Flow Test',
        answers: { 0: 'Mitochondria', 1: 0 }
      })
    });
    assert.equal(submit.status, 200);
    assert.notEqual(submit.body.result_id, collisionId);
    assert.match(submit.body.result_id, /^res_[a-f0-9]{32}$/);
    assert.equal(results.get(collisionId).marker, 'preserve-me');
    assert.equal(results.get(submit.body.result_id).quiz_id, quizId);
  });

  await t.test('semantic grades require a server-signed proof', async () => {
    const semanticQuizId = 'quiz_semantic_proof';
    const semanticQuestion = {
      question: 'State the force in newtons.',
      answer: 'The force is 10 newtons.',
      type: 'open_ended'
    };
    quizzes.set(semanticQuizId, {
      id: semanticQuizId,
      user_id: 'teacher_test',
      title: 'Semantic Proof',
      questions: [semanticQuestion]
    });

    const forged = await requestJson('/submit', {
      method: 'POST',
      body: JSON.stringify({
        quiz_id: semanticQuizId,
        session_id: 'semantic-forged',
        student_name: 'Flow Test',
        graded_details: [{
          user_answer: '10 N',
          is_correct: true,
          score_fraction: 1,
          grade_proof: 'forged'
        }]
      })
    });
    assert.equal(forged.status, 200);
    assert.equal(forged.body.total_score, 0);

    const validProof = createGradeProof({
      quizId: semanticQuizId,
      questionIndex: 0,
      question: semanticQuestion,
      studentAnswer: '10 N',
      isCorrect: true,
      scoreFraction: 1
    });
    const proven = await requestJson('/submit', {
      method: 'POST',
      body: JSON.stringify({
        quiz_id: semanticQuizId,
        session_id: 'semantic-proven',
        student_name: 'Flow Test',
        graded_details: [{
          user_answer: '10 N',
          is_correct: false,
          score_fraction: 0,
          grade_proof: validProof
        }]
      })
    });
    assert.equal(proven.status, 200);
    assert.equal(proven.body.total_score, 1);
  });

  await t.test('result access supports signed new links and high-entropy legacy links only', async () => {
    const submit = await requestJson('/submit', {
      method: 'POST',
      body: JSON.stringify({
        quiz_id: quizId,
        session_id: 'secure-result-link',
        student_name: 'Flow Test',
        answers: { 0: 'Mitochondria', 1: 0 }
      })
    });
    assert.equal(submit.status, 200);
    assert.ok(submit.body.result_access_token);

    const previousNodeEnv = process.env.NODE_ENV;
    const previousDemoAuth = process.env.ALLOW_DEMO_AUTH;
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_DEMO_AUTH = 'false';
    try {
      const denied = await requestJson(`/api/get_result/${submit.body.result_id}`);
      assert.equal(denied.status, 404);

      const allowed = await requestJson(
        `/api/get_result/${submit.body.result_id}?access_token=${encodeURIComponent(submit.body.result_access_token)}`
      );
      assert.equal(allowed.status, 200);
      assert.equal(allowed.body.access_token_hash, undefined);

      const legacyId = 'AbCdEf1234567890GhIj';
      results.set(legacyId, {
        id: legacyId,
        quiz_id: quizId,
        score: 1,
        total: 1,
        details: [],
        is_in_progress: false
      });
      const legacyAllowed = await requestJson(`/api/get_result/${legacyId}`);
      assert.equal(legacyAllowed.status, 200);

      const guessableHashlessId = 'res_hashless_progress';
      results.set(guessableHashlessId, {
        id: guessableHashlessId,
        quiz_id: quizId,
        score: 0,
        total: 1,
        details: [],
        is_in_progress: false
      });
      const hashlessDenied = await requestJson(`/api/get_result/${guessableHashlessId}`);
      assert.equal(hashlessDenied.status, 404);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      process.env.ALLOW_DEMO_AUTH = previousDemoAuth;
    }
  });

  await t.test('taking formatter removes executable markup while preserving LaTeX and raster images', async () => {
    const response = await fetch(`${baseUrl}/quiz/${quizId}`);
    const html = await response.text();
    const start = html.indexOf('function isSafeDisplayImageSource');
    const end = html.indexOf('function cleanNewlinesInMath');
    assert.ok(start >= 0 && end > start);

    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    dom.window.eval(
      `${html.slice(start, end)}; window.__sanitizeQuizHtml = sanitizeDisplayHtml;`
    );
    const sanitize = (dom.window as any).__sanitizeQuizHtml as (value: string) => string;
    const malicious = '<img src="x" onerror="window.pwned=1"><script>window.pwned=1</script>'
      + '<span onclick="window.pwned=1">$x^2$</span>'
      + '<div class="resizable-image-wrapper"><img src="data:image/png;base64,AAAA" onerror="window.pwned=1"></div>';
    const sanitized = sanitize(malicious);
    assert.doesNotMatch(sanitized, /onerror|onclick|<script|src="x"/i);
    assert.match(sanitized, /\$x\^2\$/);
    assert.match(sanitized, /data:image\/png;base64,AAAA/);
    dom.window.close();

    const solutionsResponse = await fetch(`${baseUrl}/view_solutions/res_numeric-zero`);
    assert.equal(solutionsResponse.status, 200);
    const solutionsHtml = await solutionsResponse.text();
    const solutionsStart = solutionsHtml.indexOf('function isSafeDisplayImageSource');
    const solutionsEnd = solutionsHtml.indexOf('function explainMistakeResults');
    assert.ok(solutionsStart >= 0 && solutionsEnd > solutionsStart);
    const solutionsDom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    solutionsDom.window.eval(
      `${solutionsHtml.slice(solutionsStart, solutionsEnd)}; window.__sanitizeSolutionsHtml = sanitizeDisplayHtml;`
    );
    const sanitizeSolutions = (solutionsDom.window as any).__sanitizeSolutionsHtml as (value: string) => string;
    const sanitizedSolutions = sanitizeSolutions(malicious);
    assert.doesNotMatch(sanitizedSolutions, /onerror|onclick|<script|src="x"/i);
    assert.match(sanitizedSolutions, /\$x\^2\$/);
    assert.match(sanitizedSolutions, /data:image\/png;base64,AAAA/);
    solutionsDom.window.close();
  });

  await t.test('editor and results formatters isolate stored and AI rich text from browser secrets', async () => {
    const editorResponse = await fetch(`${baseUrl}/edit/${quizId}`);
    assert.equal(editorResponse.status, 200);
    const editorHtml = await editorResponse.text();
    assert.doesNotMatch(editorHtml, new RegExp(sensitiveValue));

    const formatterStart = editorHtml.indexOf('function cleanNewlinesInMath');
    const formatterEnd = editorHtml.indexOf('function updatePreview');
    assert.ok(formatterStart >= 0 && formatterEnd > formatterStart);
    const editorDom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    editorDom.window.eval(
      `${editorHtml.slice(formatterStart, formatterEnd)};`
      + 'window.__formatEditorText = formatText;'
      + 'window.__editorImageSourceIsSafe = isSafeDisplayImageSource;'
    );
    const formatEditorText = (editorDom.window as any).__formatEditorText as (value: unknown) => string;
    const editorImageSourceIsSafe = (editorDom.window as any).__editorImageSourceIsSafe as (value: unknown) => boolean;
    const maliciousRichText = '<img src="x" onerror="window.pwned=localStorage.gemini_api_key">'
      + '<script>window.pwned=localStorage.gemini_api_key</script>'
      + '<span onclick="window.pwned=1">$x^2$</span>'
      + '<div class="resizable-image-wrapper bad" style="position:fixed">'
      + '<div class="image-content-box bad" style="width:150%;position:fixed">'
      + '<img src="data:image/png;base64,AAAA" onerror="window.pwned=1"></div></div>'
      + '<img src="https://kroki.io/tikz/svg/AbC_123-" onload="window.pwned=1">'
      + '<img src="data:image/svg+xml;base64,PHN2Zz4=">';
    const formattedEditor = formatEditorText({
      '</strong><img src=x onerror=window.pwned=1>': maliciousRichText,
      answer: 0
    });
    assert.doesNotMatch(formattedEditor, /onerror|onload|onclick|<script|src="x"|svg\+xml|position\s*:/i);
    assert.match(formattedEditor, /\$x\^2\$/);
    assert.match(formattedEditor, /data:image\/png;base64,AAAA/);
    assert.match(formattedEditor, /https:\/\/kroki\.io\/tikz\/svg\/AbC_123-/);
    assert.match(formattedEditor, /style="width: 150%;"/);
    assert.match(formattedEditor, /\b0<\/li>/);
    assert.equal(editorImageSourceIsSafe('data:image/svg+xml;base64,PHN2Zz4='), false);
    editorDom.window.close();

    const contractStart = editorHtml.indexOf('function normalizeQuizListPayload');
    const contractEnd = editorHtml.indexOf("window.addEventListener('DOMContentLoaded'");
    assert.ok(contractStart >= 0 && contractEnd > contractStart);
    const contractDom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    contractDom.window.eval(
      `${editorHtml.slice(contractStart, contractEnd)};`
      + 'window.__normalizeQuizList = normalizeQuizListPayload;'
      + 'window.__normalizeQuizDetails = normalizeQuizDetailsPayload;'
      + 'window.__readJsonResponse = readJsonResponse;'
    );
    const normalizeQuizList = (contractDom.window as any).__normalizeQuizList as (value: unknown) => any[];
    const normalizeQuizDetails = (contractDom.window as any).__normalizeQuizDetails as (value: unknown) => any;
    const readJsonResponse = (contractDom.window as any).__readJsonResponse as (value: any) => Promise<any>;
    const quizList = [{ id: 'one', title: 'One' }];
    const quizDetails = { id: 'one', questions: [] };
    assert.deepEqual(Array.from(normalizeQuizList(quizList), item => ({ ...item })), quizList);
    assert.deepEqual(
      Array.from(normalizeQuizList({ success: true, quizzes: quizList }), item => ({ ...item })),
      quizList
    );
    assert.equal(normalizeQuizDetails(quizDetails).id, 'one');
    assert.equal(normalizeQuizDetails({ success: true, quiz: quizDetails }).id, 'one');
    await assert.rejects(
      () => readJsonResponse({
        ok: false,
        status: 403,
        json: async () => ({ success: false, error: 'Denied by contract' })
      }),
      /Denied by contract/
    );
    contractDom.window.close();

    const resultsResponse = await fetch(`${baseUrl}/results/res_numeric-zero`);
    assert.equal(resultsResponse.status, 200);
    const resultsHtml = await resultsResponse.text();
    const resultsFormatterStart = resultsHtml.indexOf('function isSafeDisplayImageSource');
    const resultsFormatterEnd = resultsHtml.indexOf('async function explainMistake');
    assert.ok(resultsFormatterStart >= 0 && resultsFormatterEnd > resultsFormatterStart);
    const resultsDom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    resultsDom.window.eval(
      `${resultsHtml.slice(resultsFormatterStart, resultsFormatterEnd)};`
      + 'window.__formatResultsText = formatDisplayText;'
    );
    const formatResultsText = (resultsDom.window as any).__formatResultsText as (value: unknown) => string;
    const formattedExplanation = formatResultsText(maliciousRichText);
    assert.doesNotMatch(formattedExplanation, /onerror|onload|onclick|<script|src="x"|svg\+xml|position\s*:/i);
    assert.match(formattedExplanation, /\$x\^2\$/);
    assert.match(formattedExplanation, /data:image\/png;base64,AAAA/);
    assert.match(formattedExplanation, /https:\/\/kroki\.io\/tikz\/svg\/AbC_123-/);
    resultsDom.window.close();
  });

  await t.test('invalid updates are rejected without corrupting quiz shape', async () => {
    const response = await requestJson(`/update/${quizId}`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Broken Update',
        questions: 'not-an-array'
      })
    });

    assert.ok(response.status >= 400 && response.status < 500);
    assert.ok(Array.isArray(quizzes.get(quizId).questions));
  });

  await t.test('valid updates preserve identity and discard sensitive fields', async () => {
    const existing = quizzes.get(quizId);
    delete existing.api_key;
    quizzes.set(quizId, existing);

    const response = await requestJson(`/update/${quizId}`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Updated Quiz Flow Stability',
        api_key: 'ATTACKER_SUPPLIED_KEY',
        questions: existing.questions
      })
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.quiz.id, quizId);
    assert.equal(response.body.quiz.user_id, 'teacher_test');
    assert.equal(response.body.quiz.api_key, undefined);
    assert.equal(quizzes.get(quizId).api_key, undefined);
  });

  await t.test('deleting a quiz cascades its result records', async () => {
    const cascadeQuizId = 'quiz_delete_cascade';
    quizzes.set(cascadeQuizId, {
      id: cascadeQuizId,
      user_id: 'teacher_test',
      title: 'Delete Cascade',
      questions: []
    });
    results.set('res_delete_cascade_1', {
      id: 'res_delete_cascade_1',
      quiz_id: cascadeQuizId,
      score: 0,
      total: 0
    });
    results.set('res_delete_cascade_2', {
      id: 'res_delete_cascade_2',
      quiz_id: cascadeQuizId,
      score: 0,
      total: 0
    });

    const response = await requestJson(`/api/quiz/${cascadeQuizId}`, { method: 'DELETE' });
    assert.equal(response.status, 200);
    assert.equal(response.body.deleted_result_count, 2);
    assert.equal(quizzes.has(cascadeQuizId), false);
    assert.equal(results.has('res_delete_cascade_1'), false);
    assert.equal(results.has('res_delete_cascade_2'), false);
  });

  await t.test('bulk results deletion accepts the dashboard result_ids contract', async () => {
    const resultId = 'res_numeric-zero';
    assert.ok(results.has(resultId));

    const response = await requestJson('/api/delete_results', {
      method: 'POST',
      body: JSON.stringify({ result_ids: [resultId] })
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(results.has(resultId), false);
  });

  await t.test('AI authoring contracts enforce the 50-question cap before model work', async () => {
    const oversizedSingle = await requestJson('/api/generate_ai', {
      method: 'POST',
      body: JSON.stringify({
        topic: 'Science',
        test_type: 'Multiple Choice',
        num_items: 51
      })
    });
    assert.equal(oversizedSingle.status, 400);
    assert.match(oversizedSingle.body.error, /between 1 and 50/i);

    const oversizedMixed = await requestJson('/api/generate_ai', {
      method: 'POST',
      body: JSON.stringify({
        topic: 'Science',
        test_type: 'Mixed',
        num_items: 50,
        mc_count: 30,
        tf_count: 30,
        id_count: 0,
        oe_count: 0,
        gr_count: 0
      })
    });
    assert.equal(oversizedMixed.status, 400);
    assert.match(oversizedMixed.body.error, /more than 50/i);

    const worksheetQuestions = Array.from({ length: 51 }, (_, index) => ({
      question: `Question ${index + 1}`,
      options: [],
      answer: 'Answer',
      type: 'identification'
    }));
    const oversizedWorksheet = await requestJson('/api/solve_worksheet', {
      method: 'POST',
      body: JSON.stringify({ questions: worksheetQuestions })
    });
    assert.equal(oversizedWorksheet.status, 400);
    assert.match(oversizedWorksheet.body.error, /limited to 50/i);
  });

  await t.test('Ollama discovery uses only the configured server endpoint', async () => {
    const ollamaApp = express();
    let tagRequests = 0;
    ollamaApp.get('/api/tags', (_req, res) => {
      tagRequests += 1;
      res.json({ models: [{ name: 'configured-model:latest' }] });
    });
    const ollamaServer = ollamaApp.listen(0, '127.0.0.1');
    await once(ollamaServer, 'listening');
    const ollamaAddress = ollamaServer.address();
    assert.ok(ollamaAddress && typeof ollamaAddress === 'object');

    const previousNodeEnv = process.env.NODE_ENV;
    const previousDemoAuth = process.env.ALLOW_DEMO_AUTH;
    const previousBaseUrl = process.env.OLLAMA_BASE_URL;
    const previousAllowlist = process.env.OLLAMA_ALLOWED_BASE_URLS;
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_DEMO_AUTH = 'true';
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${ollamaAddress.port}`;
    process.env.OLLAMA_ALLOWED_BASE_URLS = '';

    try {
      const config = await requestJson('/api/ai/config');
      assert.equal(config.status, 200);
      assert.equal(typeof config.body.gemini_configured, 'boolean');
      assert.equal(config.body.ollama_configured, true);
      assert.equal(config.body.ollama_url, undefined);
      assert.equal(config.body.ollama_base_url, undefined);

      const discovered = await requestJson('/api/ollama_tags');
      assert.equal(discovered.status, 200);
      assert.deepEqual(discovered.body, {
        success: true,
        installed: true,
        models: ['configured-model:latest']
      });
      assert.equal(tagRequests, 1);

      const untrustedBrowserUrl = await requestJson(
        '/api/ollama_tags?url=http%3A%2F%2F127.0.0.1%3A9'
      );
      assert.equal(untrustedBrowserUrl.status, 503);
      assert.equal(untrustedBrowserUrl.body.success, false);
      assert.deepEqual(untrustedBrowserUrl.body.models, []);
      assert.equal(tagRequests, 1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        ollamaServer.close(error => error ? reject(error) : resolve());
      });
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousDemoAuth === undefined) delete process.env.ALLOW_DEMO_AUTH;
      else process.env.ALLOW_DEMO_AUTH = previousDemoAuth;
      if (previousBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
      else process.env.OLLAMA_BASE_URL = previousBaseUrl;
      if (previousAllowlist === undefined) delete process.env.OLLAMA_ALLOWED_BASE_URLS;
      else process.env.OLLAMA_ALLOWED_BASE_URLS = previousAllowlist;
    }
  });

  await t.test('generator UI exposes no browser Ollama URL or install controls', async () => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /id="ollama-model-group"[^>]*disabled[^>]*hidden/);
    assert.match(html, /ollama_configured/);
    assert.match(html, /name="num_items"[^>]*max="50"/);
    assert.doesNotMatch(html, /modal_ollama_url_input|__install_ollama__|autoInstallModel|\/api\/install_model/);
    assert.doesNotMatch(html, /ollama_tags\?url=/);
  });

  await t.test('legacy AI generation endpoint exists and responds with JSON', async () => {
    const response = await requestJson('/generate_ai', {
      method: 'POST',
      body: JSON.stringify({
        prompt: 'Create one simple science question',
        num_questions: 1
      })
    });

    assert.notEqual(response.status, 404);
    assert.match(response.contentType, /application\/json/);
  });
});

test('AI JSON repair preserves LaTeX and real newlines', async () => {
  const { getRealModelName, safeParseJSON } = await import('../src/services/gemini.ts');
  const raw = String.raw`[
    {
      "answer": "\frac{1}{2} \times 4 \neq 3; \nabla f \notin A; \bar{x} \rightarrow \boxed{\tfrac{1}{2}}",
      "explanation": "First line
Second line"
    }
  ]`;

  const parsed = safeParseJSON(raw);
  assert.ok(Array.isArray(parsed));
  assert.equal(
    parsed[0].answer,
    String.raw`\frac{1}{2} \times 4 \neq 3; \nabla f \notin A; \bar{x} \rightarrow \boxed{\tfrac{1}{2}}`
  );
  assert.equal(parsed[0].explanation, 'First line\nSecond line');

  const escapedNewline = safeParseJSON(String.raw`{"text":"Alpha\nBeta"}`);
  assert.equal(escapedNewline.text, 'Alpha\nBeta');

  assert.equal(getRealModelName('gemini-3.5-flash-lite'), 'gemini-3.5-flash-lite');
  assert.equal(getRealModelName('gemini-3.5-flash'), 'gemini-3.5-flash');
  assert.equal(getRealModelName('gemini-3.0-flash'), 'gemini-3.6-flash');
});

test('AI work guard enforces concurrency and gives BYOK a larger quota', async () => {
  const {
    acquireAiWork,
    AiWorkLimitError,
    resetAiWorkGuardForTests
  } = await import('../src/services/aiWorkGuard.ts');

  process.env.NODE_ENV = 'test';
  resetAiWorkGuardForTests();
  const first = acquireAiWork({ userId: 'guard-user', cost: 1 });
  const second = acquireAiWork({ userId: 'guard-user', cost: 1 });
  assert.throws(
    () => acquireAiWork({ userId: 'guard-user', cost: 1 }),
    (error: unknown) => (
      error instanceof AiWorkLimitError
      && error.code === 'AI_CONCURRENCY_EXCEEDED'
      && error.status === 429
    )
  );
  first.release();
  second.release();

  resetAiWorkGuardForTests();
  const standardQuota = acquireAiWork({ userId: 'standard-user', cost: 120 });
  standardQuota.release();
  assert.throws(
    () => acquireAiWork({ userId: 'standard-user', cost: 1 }),
    (error: unknown) => (
      error instanceof AiWorkLimitError
      && error.code === 'AI_QUOTA_EXCEEDED'
    )
  );

  resetAiWorkGuardForTests();
  const byokQuota = acquireAiWork({ userId: 'byok-user', cost: 121, byok: true });
  byokQuota.release();
  resetAiWorkGuardForTests();
});
