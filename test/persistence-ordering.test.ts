import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test, { after, before } from 'node:test';

type StoredDocument = Record<string, any>;

class FakeFirestore {
  readonly collections = new Map<string, Map<string, StoredDocument>>();
  readonly failedReads = new Set<string>();
  readonly failedWrites = new Set<string>();
  readonly failedDeletes = new Set<string>();
  readonly events: string[] = [];

  collection(name: string) {
    return new FakeCollection(this, name);
  }

  documents(name: string) {
    let documents = this.collections.get(name);
    if (!documents) {
      documents = new Map();
      this.collections.set(name, documents);
    }
    return documents;
  }
}

class FakeCollection {
  constructor(
    private readonly firestore: FakeFirestore,
    private readonly name: string
  ) {}

  async get() {
    if (this.firestore.failedReads.has(this.name)) {
      throw new Error(`forced ${this.name} read failure`);
    }
    return {
      docs: Array.from(this.firestore.documents(this.name), ([id, value]) => ({
        id,
        data: () => structuredClone(value)
      }))
    };
  }

  doc(id: string) {
    return new FakeDocument(this.firestore, this.name, id);
  }
}

class FakeDocument {
  constructor(
    private readonly firestore: FakeFirestore,
    private readonly collectionName: string,
    private readonly id: string
  ) {}

  async set(value: StoredDocument) {
    if (this.firestore.failedWrites.has(`${this.collectionName}/${this.id}`)) {
      throw new Error(`forced ${this.collectionName}/${this.id} write failure`);
    }
    const delay = Number(value.test_delay_ms || 0);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    this.firestore.documents(this.collectionName).set(this.id, structuredClone(value));
    this.firestore.events.push(`set:${this.collectionName}/${this.id}:${value.revision || ''}`);
  }

  async delete() {
    if (this.firestore.failedDeletes.has(`${this.collectionName}/${this.id}`)) {
      throw new Error(`forced ${this.collectionName}/${this.id} delete failure`);
    }
    this.firestore.documents(this.collectionName).delete(this.id);
    this.firestore.events.push(`delete:${this.collectionName}/${this.id}`);
  }

  collection(name: string) {
    return new FakeCollection(
      this.firestore,
      `${this.collectionName}/${this.id}/${name}`
    );
  }
}

let originalCwd = '';
let tempRoot = '';
let db: typeof import('../src/store/db.ts');
const TEST_ENV_KEYS = [
  'NODE_ENV',
  'FIREBASE_WEB_FALLBACK',
  'QUIZMOKO_DATA_DIR',
  'LOCAL_SAVE_DEBOUNCE_MS',
  'REQUIRE_FIRESTORE'
] as const;
const originalEnvironment = new Map<string, string | undefined>();

before(async () => {
  for (const key of TEST_ENV_KEYS) originalEnvironment.set(key, process.env[key]);
  originalCwd = process.cwd();
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quizmoko-persistence-'));
  process.chdir(tempRoot);
  process.env.NODE_ENV = 'test';
  process.env.FIREBASE_WEB_FALLBACK = 'false';
  process.env.QUIZMOKO_DATA_DIR = path.join(tempRoot, 'data');
  process.env.LOCAL_SAVE_DEBOUNCE_MS = '10';
  db = await import('../src/store/db.ts');
  assert.equal(db.isFirestoreRequired(), false, 'local/test mode must default to optional Firestore');
  const bootstrapFirestore = new FakeFirestore();
  (db.firestoreDbs as any[]).push({
    kind: 'admin',
    db: bootstrapFirestore,
    label: 'bootstrap-test'
  });
  await db.initDatabase();
  db.firestoreDbs.length = 0;
});

after(async () => {
  await db.flushPendingPersistence(5_000);
  db.firestoreDbs.length = 0;
  process.chdir(originalCwd);
  await fs.promises.rm(tempRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100
  });
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function fetchHealthStatus(): Promise<number> {
  const express = (await import('express')).default;
  const healthRouter = (await import('../src/routes/healthRoutes.ts')).default;
  const app = express();
  app.use(healthRouter);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    return response.status;
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('Firestore persistence ordering and authoritative hydration', async (t) => {
  await t.test('serializes save/save and save/delete for one document', async () => {
    const fake = new FakeFirestore();
    (db.firestoreDbs as any[]).push({ kind: 'admin', db: fake, label: 'test' });

    const progressive = {
      id: 'result-1',
      revision: 'progressive',
      test_delay_ms: 40
    };
    const firstSave = db.syncDocToFirestore('results', 'result-1', progressive);
    progressive.revision = 'mutated-after-enqueue';
    const finalSave = db.syncDocToFirestore('results', 'result-1', {
      id: 'result-1',
      revision: 'final'
    });

    await Promise.all([firstSave, finalSave]);
    assert.deepEqual(fake.events, [
      'set:results/result-1:progressive',
      'set:results/result-1:final'
    ]);
    assert.equal(fake.documents('results').get('result-1')?.revision, 'final');

    fake.events.length = 0;
    const saveBeforeDelete = db.syncDocToFirestore('results', 'result-2', {
      id: 'result-2',
      revision: 'save-before-delete',
      test_delay_ms: 40
    });
    const deleteAfterSave = db.deleteDocFromFirestore('results', 'result-2');
    await Promise.all([saveBeforeDelete, deleteAfterSave]);

    assert.deepEqual(fake.events, [
      'set:results/result-2:save-before-delete',
      'delete:results/result-2'
    ]);
    assert.equal(fake.documents('results').has('result-2'), false);
    db.firestoreDbs.length = 0;
  });

  await t.test('replaces successful remote collections and retains failed local fallbacks', async () => {
    const fake = new FakeFirestore();
    fake.documents('quiz').set('shared', {
      id: 'shared',
      title: 'Legacy',
      questions: []
    });
    fake.documents('quiz').set('legacy-only', {
      id: 'legacy-only',
      title: 'Legacy only',
      questions: []
    });
    fake.documents('quizzes').set('shared', {
      id: 'shared',
      title: 'Canonical',
      questions: []
    });
    fake.failedReads.add('users');
    (db.firestoreDbs as any[]).push({ kind: 'admin', db: fake, label: 'test' });

    db.quizzes.clear();
    db.results.clear();
    db.users.clear();
    db.quizzes.set('local-only', {
      id: 'local-only',
      title: 'Local only',
      questions: []
    });
    db.results.set('local-result', { id: 'local-result' });
    db.users.set('local-user', {
      uid: 'local-user',
      email: 'local@example.test',
      name: 'Local',
      role: 'teacher'
    });

    const fullyHydrated = await db.loadFromFirestore();
    assert.equal(fullyHydrated, false);
    assert.deepEqual(Array.from(db.quizzes.keys()).sort(), ['legacy-only', 'shared']);
    assert.equal(db.quizzes.get('shared')?.title, 'Canonical');
    assert.equal(db.results.size, 0, 'successful-empty results must clear local results');
    assert.equal(db.users.has('local-user'), true, 'failed users read must retain local users');
    assert.equal(db.getPersistenceStatus().firestoreHydrated, false);

    fake.failedReads.clear();
    fake.collections.set('quiz', new Map());
    fake.collections.set('quizzes', new Map());
    fake.collections.set('results', new Map());
    fake.collections.set('users', new Map());
    db.quizzes.set('second-local', {
      id: 'second-local',
      title: 'Second local',
      questions: []
    });
    db.results.set('second-result', { id: 'second-result' });
    db.users.set('second-user', {
      uid: 'second-user',
      email: 'second@example.test',
      name: 'Second',
      role: 'teacher'
    });

    const emptyHydrated = await db.loadFromFirestore();
    assert.equal(emptyHydrated, true);
    assert.equal(db.quizzes.size, 0);
    assert.equal(db.results.size, 0);
    assert.equal(db.users.size, 0);
    assert.equal(db.getPersistenceStatus().firestoreHydrated, true);
    db.firestoreDbs.length = 0;
  });

  await t.test('required mutations reject, degrade health, and recover on a later success', async () => {
    process.env.REQUIRE_FIRESTORE = 'true';
    const fake = new FakeFirestore();
    (db.firestoreDbs as any[]).push({ kind: 'admin', db: fake, label: 'strict-test' });

    try {
      fake.failedWrites.add('results/strict-result');
      await assert.rejects(
        db.syncDocToFirestore('results', 'strict-result', {
          id: 'strict-result',
          revision: 'failed'
        }),
        (error: any) => error?.status === 503 && error?.code === 'FIRESTORE_UNAVAILABLE'
      );
      assert.equal(db.getPersistenceStatus().ready, false);
      assert.equal(db.getPersistenceStatus().firestoreHealthy, false);
      assert.equal(await fetchHealthStatus(), 503);

      fake.failedWrites.clear();
      await db.syncDocToFirestore('results', 'strict-result', {
        id: 'strict-result',
        revision: 'recovered'
      });
      assert.equal(
        fake.documents('results').get('strict-result')?.revision,
        'recovered',
        'a failed predecessor must not poison the per-document queue'
      );
      assert.equal(db.getPersistenceStatus().ready, true);
      assert.equal(db.getPersistenceStatus().firestoreHealthy, true);
      assert.equal(await fetchHealthStatus(), 200);

      fake.failedWrites.add('results/concurrent-failure');
      const concurrentFailure = db.syncDocToFirestore('results', 'concurrent-failure', {
        id: 'concurrent-failure'
      });
      const alreadyRunningSuccess = db.syncDocToFirestore('results', 'concurrent-success', {
        id: 'concurrent-success',
        test_delay_ms: 30
      });
      const concurrentOutcomes = await Promise.allSettled([
        concurrentFailure,
        alreadyRunningSuccess
      ]);
      assert.equal(concurrentOutcomes[0].status, 'rejected');
      assert.equal(concurrentOutcomes[1].status, 'fulfilled');
      assert.equal(
        db.getPersistenceStatus().ready,
        false,
        'an older concurrent success must not mask a newer required-write failure'
      );
      fake.failedWrites.delete('results/concurrent-failure');
      await db.syncDocToFirestore('results', 'concurrent-failure', {
        id: 'concurrent-failure',
        revision: 'recovered-after-concurrency'
      });
      assert.equal(db.getPersistenceStatus().ready, true);

      fake.failedDeletes.add('results/strict-result');
      await assert.rejects(
        db.deleteDocFromFirestore('results', 'strict-result'),
        (error: any) => error?.status === 503
      );
      assert.equal(db.getPersistenceStatus().ready, false);

      fake.failedDeletes.clear();
      await db.deleteDocFromFirestore('results', 'strict-result');
      assert.equal(db.getPersistenceStatus().ready, true);
      assert.equal(fake.documents('results').has('strict-result'), false);
    } finally {
      db.firestoreDbs.length = 0;
      delete process.env.REQUIRE_FIRESTORE;
    }
  });

  await t.test('optional mode keeps local fallback ready when Firestore rejects a mutation', async () => {
    process.env.REQUIRE_FIRESTORE = 'false';
    const fake = new FakeFirestore();
    fake.failedWrites.add('results/optional-result');
    (db.firestoreDbs as any[]).push({ kind: 'admin', db: fake, label: 'optional-test' });

    try {
      await assert.doesNotReject(
        db.syncDocToFirestore('results', 'optional-result', {
          id: 'optional-result',
          revision: 'local-fallback'
        })
      );
      const status = db.getPersistenceStatus();
      assert.equal(status.ready, true);
      assert.equal(status.firestoreHealthy, false);
      assert.equal(await fetchHealthStatus(), 200);
    } finally {
      db.firestoreDbs.length = 0;
      delete process.env.REQUIRE_FIRESTORE;
    }
  });
});
