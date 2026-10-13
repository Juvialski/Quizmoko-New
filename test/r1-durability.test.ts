import express from 'express';
import http from 'node:http';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs, { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('durability fault injection: ordering, coalescing, failure recovery, restart and chunk integrity', async () => {
  const previous = { ...process.env };
  const directory = mkdtempSync(path.join(os.tmpdir(), 'quizmoko-r1-'));
  process.env.QUIZMOKO_DATA_DIR = directory;
  process.env.AI_STUDIO_SANDBOX = 'false'; process.env.FIREBASE_ADMIN_ENABLED = 'false';
  process.env.REQUIRE_FIRESTORE = 'true';
  delete process.env.RENDER; delete process.env.K_SERVICE; delete process.env.GOOGLE_CLOUD_PROJECT; delete process.env.GCLOUD_PROJECT;
  const db = await import('../src/store/db.ts');
  const remote = new Map<string, any>(); const writes: any[] = [];
  let fail = false; let failChunks = false;
  function collection(prefix: string): any {
    return {
      async get() {
        return { docs: [...remote].filter(([key]) => key.startsWith(prefix + '/') && !key.slice(prefix.length + 1).includes('/'))
          .map(([key, value]) => ({ id: key.slice(prefix.length + 1), data: () => structuredClone(value) })) };
      },
      doc(id: string) {
        const key = `${prefix}/${id}`;
        return {
          async set(value: any) {
            await new Promise(resolve => setTimeout(resolve, 2));
            if (fail || (failChunks && key.includes('_quizmoko_chunks'))) throw new Error('injected failure');
            remote.set(key, structuredClone(value)); writes.push({ key, value: structuredClone(value) });
          },
          async delete() { remote.delete(key); },
          collection(name: string) { return collection(`${key}/${name}`); }
        };
      }
    };
  }
  db.configurePersistenceBackendForTests({ collection });
  try {
    await db.initDatabase();
    await db.syncDocToFirestore('results', 'ordered', { revision: 'A' });
    const first = db.syncDocToFirestore('results', 'ordered', { revision: 'B' });
    const last = db.syncDocToFirestore('results', 'ordered', { revision: 'A' });
    await Promise.all([first, last]);
    assert.equal(remote.get('results/ordered').revision, 'A');
    assert.deepEqual(writes.filter(w => w.key === 'results/ordered').map(w => w.value.revision), ['A', 'B', 'A']);
    const data = { session_revision: 1, answers: { '0': 'Alpha' } };
    const saved = db.checkpointProgressToFirestore('results', 'checkpoint', data, 20);
    data.session_revision = 999;
    const next = db.checkpointProgressToFirestore('results', 'checkpoint', { session_revision: 2, answers: { '0': 'Beta' } }, 20);
    assert.equal(saved, next); await saved;
    assert.equal(remote.get('results/checkpoint').session_revision, 2);
    assert.equal(writes.filter(w => w.key === 'results/checkpoint').length, 1);
    fail = true;
    await assert.rejects(db.persistQuizCreation({ id: 'failed_creation', title: 'Failed creation', questions: [] } as any));
    assert.equal(db.quizzes.has('failed_creation'), false);
    fail = false;
    await db.syncDocToFirestore('quizzes', 'failed_creation', { id: 'failed_creation', is_draft: true });
    fail = true;
    await assert.rejects(db.syncDocToFirestore('results', 'failed', { revision: 3 }), /persist/);
    assert.equal(await db.flushPendingPersistence(), false);
    fail = false;
    await db.syncDocToFirestore('results', 'failed', { revision: 3 });
    assert.equal(await db.flushPendingPersistence(), true);
    const pending = db.checkpointProgressToFirestore('results', 'flush', { revision: 5 }, 60_000);
    assert.equal(await db.flushPendingPersistence(), true); await pending;
    assert.equal(remote.get('results/flush').revision, 5);
    const { registerRoutes } = await import('../src/routes/index.ts');
    const { errorHandler } = await import('../src/middleware/errorHandler.ts');
    const app = express(); app.use(express.json()); registerRoutes(app); app.use(errorHandler);
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    db.quizzes.set('r1_final_quiz', { id: 'r1_final_quiz', title: 'Durable final', questions: [{
      question: 'Choose Alpha.', type: 'multiple_choice', options: ['Alpha', 'Beta'], answer: 'A'
    }] } as any);
    const body = { quiz_id: 'r1_final_quiz', session_id: 'r1_final_session', student_name: 'Student', answers: { '0': 'A' }, answer_revisions: { '0': 1 }, session_revision: 1 };
    const submit = () => fetch(`${base}/api/submit_quiz`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
      fail = true;
      assert.equal((await submit()).status, 503);
      assert.equal(db.results.has('res_r1_final_session'), false);
      fail = false;
      const response = await submit(); assert.equal(response.status, 200);
      const first = await response.json(); const duplicate = await (await submit()).json();
      assert.equal(first.result_id, duplicate.result_id);
      assert.equal(remote.get('results/res_r1_final_session').is_in_progress, false);
      assert.equal(writes.filter(w => w.key === 'results/res_r1_final_session').length, 1);
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await db.syncDocToFirestore('results', 'large', { id: 'large', quiz_id: 'q', payload: 'x'.repeat(800_000) });
    const published = remote.get('results/large'); assert.equal(published._quizmoko_chunked, true);
    failChunks = true;
    await assert.rejects(db.syncDocToFirestore('results', 'large', { id: 'large', quiz_id: 'q', payload: 'y'.repeat(800_000) }));
    assert.deepEqual(remote.get('results/large'), published);
    failChunks = false;
    await db.syncDocToFirestore('results', 'large', { id: 'large', quiz_id: 'q', payload: 'x'.repeat(800_000) });
    // Simulated restart: drop hot state and rehydrate only acknowledged remote records.
    db.results.clear(); assert.equal(await db.loadFromFirestore(), true);
    assert.equal((db.results.get('checkpoint') as any).answers['0'], 'Beta');
    assert.equal((db.results.get('large') as any).payload.length, 800_000);
    assert.equal(await db.flushPendingPersistence(), true);
    db.firestoreDbs.length = 0; process.env.REQUIRE_FIRESTORE = 'false';
    process.env.LOCAL_SAVE_DEBOUNCE_MS = '1';
    const rename = fs.promises.rename;
    let release!: () => void; let notify!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { notify = resolve; });
    let blocked = false;
    fs.promises.rename = async (...args) => {
      if (!blocked && String(args[1]).endsWith('results.json')) { blocked = true; notify(); await gate; }
      return rename(...args);
    };
    try {
      db.results.set('local_ack', { id: 'local_ack', session_revision: 1 } as any);
      db.savePersistentData(); await started;
      const latest = { id: 'local_ack', session_revision: 2 } as any;
      db.results.set('local_ack', latest);
      const acknowledgment = db.syncDocToFirestore('results', 'local_ack', latest);
      release(); await acknowledgment;
      assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'results.json'), 'utf8')).local_ack.session_revision, 2);
    } finally { release(); fs.promises.rename = rename; }
  } finally {
    await db.flushPendingPersistence(2000);
    process.env = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
