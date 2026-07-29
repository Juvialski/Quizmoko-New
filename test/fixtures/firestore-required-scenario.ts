import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scenario = process.argv[2];
const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quizmoko-required-firestore-'));
let loadedDb: typeof import('../../src/store/db.ts') | undefined;

process.chdir(tempRoot);
process.env.NODE_ENV = 'production';
process.env.RENDER = 'true';
process.env.FIREBASE_ADMIN_ENABLED = 'false';
process.env.FIREBASE_WEB_FALLBACK = 'true';
process.env.FIRESTORE_STARTUP_TIMEOUT_MS = '250';
process.env.QUIZMOKO_DATA_DIR = path.join(tempRoot, 'data');
delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
delete process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.GOOGLE_CLOUD_PROJECT;
delete process.env.GCLOUD_PROJECT;
delete process.env.K_SERVICE;
delete process.env.GAE_ENV;
delete process.env.FUNCTION_TARGET;
delete process.env.FUNCTION_NAME;

try {
  if (scenario === 'no-backend') {
    delete process.env.REQUIRE_FIRESTORE;
    const db = await import('../../src/store/db.ts');
    loadedDb = db;
    (db.firestoreDbs as any[]).push({
      kind: 'web',
      db: {},
      label: 'web:must-not-satisfy-required-mode'
    });

    assert.equal(db.isFirestoreRequired(), true);
    await assert.rejects(
      db.initDatabase(),
      (error: any) => error?.status === 503 && error?.code === 'FIRESTORE_UNAVAILABLE'
    );
    const status = db.getPersistenceStatus();
    assert.equal(status.ready, false);
    assert.equal(status.firestoreConfigured, true);
    assert.equal(status.firestoreCredentialed, false);
    assert.equal(status.firestoreRequired, true);
  } else if (scenario === 'hydration-failure') {
    process.env.REQUIRE_FIRESTORE = 'true';
    const db = await import('../../src/store/db.ts');
    loadedDb = db;
    const failingFirestore = {
      collection(collectionName: string) {
        return {
          async get() {
            throw new Error(`forced ${collectionName} startup read failure`);
          }
        };
      }
    };
    (db.firestoreDbs as any[]).push({
      kind: 'admin',
      db: failingFirestore,
      label: 'admin:failing-test'
    });

    await assert.rejects(
      db.initDatabase(),
      (error: any) => error?.status === 503
    );
    const status = db.getPersistenceStatus();
    assert.equal(status.ready, false);
    assert.equal(status.firestoreCredentialed, true);
    assert.equal(status.firestoreHydrated, false);
    assert.equal(status.firestoreHealthy, false);
  } else {
    throw new Error(`Unknown scenario: ${scenario || '(missing)'}`);
  }
} finally {
  await loadedDb?.flushPendingPersistence(2_000);
  process.chdir(originalCwd);
  await fs.promises.rm(tempRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100
  });
}
