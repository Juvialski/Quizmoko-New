import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  initializeApp as initializeWebApp,
  getApps as getWebApps,
  getApp as getWebApp
} from 'firebase/app';
import {
  getFirestore as getWebFirestore,
  collection as webCollection,
  getDocs as getWebDocs,
  doc as webDoc,
  setDoc as setWebDoc,
  deleteDoc as deleteWebDoc,
  setLogLevel,
  type Firestore as WebFirestore
} from 'firebase/firestore';
import {
  getFirestore as getAdminFirestore,
  type Firestore as AdminFirestore
} from 'firebase-admin/firestore';
import type { User, Quiz, QuizResult, LiveSessionState } from '../types.ts';
import {
  getFirebaseAdminApp,
  getFirebaseAdminMode
} from '../services/firebaseAdmin.ts';

// In-Memory Stores
export const users = new Map<string, User>();
export const quizzes = new Map<string, Quiz>();
export const results = new Map<string, QuizResult>();
export const sessionProgress = new Map<string, any>();
export const liveSessions = new Map<string, LiveSessionState>();

// Pre-populate Default Teacher User
users.set('teacher_test', {
  uid: 'teacher_test',
  email: 'teacher@quizmoko.com',
  name: 'Teacher Test',
  role: 'admin',
  rmx_authorized: true,
  total_ai_calls: 5
});

// Pre-populate Sample Quizzes so Dashboard is immediately populated and interactive
const sampleQuizzes: Quiz[] = [
  {
    id: 'quiz_algebra_101',
    user_id: 'teacher_test',
    title: 'Algebra Basics & Linear Equations',
    subject: 'Math',
    time_limit: 30,
    quiz_mode: 'back_and_forth',
    require_solution: false,
    created_at: new Date().toISOString(),
    questions: [
      {
        question: 'Solve for $x$: $2x + 5 = 15$',
        options: ['A) $x = 5$', 'B) $x = 10$', 'C) $x = 7.5$', 'D) $x = 20$'],
        answer: 'A) $x = 5$',
        type: 'multiple_choice'
      },
      {
        question: 'What is the slope $m$ of the line $y = 3x - 4$?',
        options: [],
        answer: '3',
        type: 'identification'
      },
      {
        question: 'Simplify $\\dfrac{x^2 - 9}{x - 3}$ for $x \\neq 3$.',
        options: ['A) $x + 3$', 'B) $x - 3$', 'C) $x^2 + 3$', 'D) $3$'],
        answer: 'A) $x + 3$',
        type: 'multiple_choice'
      }
    ]
  },
  {
    id: 'quiz_cell_biology',
    user_id: 'teacher_test',
    title: 'Cell Biology & Organelles',
    subject: 'Biology',
    time_limit: 25,
    quiz_mode: 'back_and_forth',
    require_solution: false,
    created_at: new Date().toISOString(),
    questions: [
      {
        question: 'Which organelle is known as the powerhouse of the cell?',
        options: ['A) Nucleus', 'B) Mitochondria', 'C) Ribosome', 'D) Endoplasmic Reticulum'],
        answer: 'B) Mitochondria',
        type: 'multiple_choice'
      },
      {
        question: 'What process do plant cells use to convert sunlight into chemical energy?',
        options: [],
        answer: 'Photosynthesis',
        type: 'identification'
      }
    ]
  },
  {
    id: 'quiz_world_history',
    user_id: 'teacher_test',
    title: 'World History: The Renaissance',
    subject: 'History',
    time_limit: 20,
    quiz_mode: 'back_and_forth',
    require_solution: false,
    created_at: new Date().toISOString(),
    questions: [
      {
        question: 'Who painted the Mona Lisa?',
        options: ['A) Michelangelo', 'B) Leonardo da Vinci', 'C) Raphael', 'D) Donatello'],
        answer: 'B) Leonardo da Vinci',
        type: 'multiple_choice'
      },
      {
        question: 'In which European country did the Renaissance originate?',
        options: ['A) France', 'B) England', 'C) Italy', 'D) Spain'],
        answer: 'C) Italy',
        type: 'multiple_choice'
      }
    ]
  }
];

sampleQuizzes.forEach(q => quizzes.set(q.id, q));

// --- FILE-BASED & FIREBASE PERSISTENCE ---
type FirestoreBackend =
  | { kind: 'admin'; db: AdminFirestore; label: string }
  | { kind: 'web'; db: WebFirestore; label: string };

type PersistedStore = ReadonlyMap<string, any>;

export class PersistenceUnavailableError extends Error {
  readonly status = 503;
  readonly statusCode = 503;
  readonly code = 'FIRESTORE_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'PersistenceUnavailableError';
  }
}

const VALID_COLLECTIONS = new Set(['quizzes', 'results', 'users']);
const SENSITIVE_PERSISTENCE_KEYS = new Set([
  'apikey',
  'geminiapikey',
  'googleapikey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'bearertoken',
  'authorization',
  'serviceaccount',
  'serviceaccountjson',
  'privatekey',
  'privatekeyid',
  'clientsecret',
  'clientpassword',
  'password',
  'passwordhash',
  'passwordsalt',
  'credential',
  'credentials'
]);
const FIRESTORE_INLINE_LIMIT = 700_000;
const FIRESTORE_CHUNK_CHARACTERS = 180_000;
const CHUNK_COLLECTION = '_quizmoko_chunks';
const knownChunkedDocs = new Set<string>();

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase());
}

export function isFirestoreRequired(): boolean {
  return envFlag('REQUIRE_FIRESTORE', false);
}

function positiveInteger(raw: string | undefined, fallback: number, maximum: number): number {
  const value = Number.parseInt(raw || '', 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function normalizedPersistenceKey(key: string): string {
  return key.replace(/[_\-\s]/g, '').toLowerCase();
}

/**
 * Removes request-scoped credentials before an object reaches memory-backed
 * API reads, local JSON, or Firestore. This intentionally mutates the supplied
 * object so route handlers cannot accidentally return a just-persisted key.
 */
export function stripSensitiveFieldsInPlace<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object') return value;
  const objectValue = value as unknown as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);

  if (Array.isArray(value)) {
    value.forEach((item) => stripSensitiveFieldsInPlace(item, seen));
    return value;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_PERSISTENCE_KEYS.has(normalizedPersistenceKey(key))) {
      delete (value as Record<string, unknown>)[key];
    } else {
      stripSensitiveFieldsInPlace(child, seen);
    }
  }
  return value;
}

function toPlainPersistenceValue(value: any, seen = new WeakSet<object>()): any {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (typeof value === 'bigint') return value.toString();
  if (!value || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value.toDate === 'function') {
    try {
      return value.toDate().toISOString();
    } catch {
      // Continue with enumerable timestamp fields.
    }
  }
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => toPlainPersistenceValue(item, seen) ?? null);
  }

  const clean: Record<string, any> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_PERSISTENCE_KEYS.has(normalizedPersistenceKey(key))) continue;
    const normalized = toPlainPersistenceValue(child, seen);
    if (normalized !== undefined) clean[key] = normalized;
  }
  return clean;
}

const configuredDataDirectory = process.env.QUIZMOKO_DATA_DIR?.trim();
export const DATA_DIR = path.resolve(configuredDataDirectory || path.join(process.cwd(), 'data'));
const QUIZZES_FILE = path.join(DATA_DIR, 'quizzes.json');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

let localPersistenceAvailable = true;
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (error) {
  localPersistenceAvailable = false;
  console.warn('[Persistence] Local data directory is unavailable; continuing with memory/Firestore:', error instanceof Error ? error.message : 'unknown error');
}

export const firestoreDbs: FirestoreBackend[] = [];
const pendingPersistence = new Set<Promise<void>>();
const firestoreMutationQueues = new Map<string, Promise<void>>();
let backendsConfigured = false;
let databaseInitialization: Promise<void> | null = null;
let firestoreLoadGeneration = 0;
let persistenceReady = false;
let firestoreHydrated = false;
let firestoreHealthy = false;
let firestoreFailureGeneration = 0;
let lastFirestoreError = '';
let lastPersistenceError = '';
let localSaveTimer: NodeJS.Timeout | undefined;
let localSaveInFlight: Promise<void> | null = null;
let localSaveRequested = false;

function getFirebaseConfig(): Record<string, any> | null {
  const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
  try {
    if (!fs.existsSync(configPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    console.warn('[Firebase] Could not read firebase-applet-config.json:', error instanceof Error ? error.message : 'unknown error');
    return null;
  }
}

function hasCredentialedFirestoreBackend(): boolean {
  return firestoreDbs.some((backend) => backend.kind === 'admin');
}

function activeFirestoreBackends(): FirestoreBackend[] {
  return isFirestoreRequired()
    ? firestoreDbs.filter((backend) => backend.kind === 'admin')
    : firestoreDbs;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function markFirestoreFailure(context: string, error?: unknown): string {
  const detail = errorMessage(error, 'unknown Firestore error');
  const message = `${context}: ${detail}`;
  firestoreFailureGeneration += 1;
  firestoreHealthy = false;
  lastFirestoreError = message;
  lastPersistenceError = message;
  return message;
}

function markFirestoreHealthy(expectedFailureGeneration = firestoreFailureGeneration) {
  // A request that began before another concurrent mutation failed cannot
  // immediately mask that newer outage when it eventually succeeds.
  if (expectedFailureGeneration !== firestoreFailureGeneration) return;
  firestoreHealthy = true;
  if (lastPersistenceError === lastFirestoreError) {
    lastPersistenceError = '';
  }
  lastFirestoreError = '';
}

function firestoreUnavailable(context: string, error?: unknown): PersistenceUnavailableError {
  const message = markFirestoreFailure(context, error);
  return new PersistenceUnavailableError(message);
}

function configureFirestoreBackends() {
  if (backendsConfigured) return;
  backendsConfigured = true;

  const firebaseConfig = getFirebaseConfig();
  const projectId = process.env.FIREBASE_PROJECT_ID || firebaseConfig?.projectId;
  const configuredDatabaseId =
    process.env.FIRESTORE_DATABASE_ID ||
    firebaseConfig?.firestoreDatabaseId ||
    '(default)';
  const databaseIds = configuredDatabaseId === '(default)'
    ? ['(default)']
    : ['(default)', configuredDatabaseId];

  const adminApp = getFirebaseAdminApp(true);
  if (adminApp) {
    for (const databaseId of databaseIds) {
      const db = databaseId === '(default)'
        ? getAdminFirestore(adminApp)
        : getAdminFirestore(adminApp, databaseId);
      firestoreDbs.push({ kind: 'admin', db, label: `admin:${databaseId}` });
    }
    console.log(`[Firebase] Firestore configured with ${getFirebaseAdminMode()} credentials for project '${projectId || 'auto-detected'}'.`);
    return;
  }

  if (isFirestoreRequired()) {
    console.warn('[Firebase] Credentialed Admin Firestore is required; unauthenticated web fallback is disabled.');
    return;
  }

  if (!envFlag('FIREBASE_WEB_FALLBACK', true) || !firebaseConfig?.apiKey || !projectId) {
    if (projectId) {
      console.warn('[Firebase] Firestore persistence is disabled because Admin credentials are unavailable and web fallback is disabled/incomplete.');
    }
    return;
  }

  try {
    const webApp = getWebApps().length === 0
      ? initializeWebApp({
          apiKey: firebaseConfig.apiKey,
          authDomain: firebaseConfig.authDomain,
          projectId,
          storageBucket: firebaseConfig.storageBucket,
          messagingSenderId: firebaseConfig.messagingSenderId,
          appId: firebaseConfig.appId
        })
      : getWebApp();

    setLogLevel('error');
    for (const databaseId of databaseIds) {
      const db = databaseId === '(default)'
        ? getWebFirestore(webApp)
        : getWebFirestore(webApp, databaseId);
      firestoreDbs.push({ kind: 'web', db, label: `web:${databaseId}` });
    }
    console.warn('[Firebase] Using unauthenticated web-SDK fallback. Configure Firebase Admin credentials before deploying restrictive Firestore rules.');
  } catch (error) {
    lastPersistenceError = error instanceof Error ? error.message : 'Firebase web initialization failed';
    console.warn('[Firebase] Web fallback initialization failed:', lastPersistenceError);
  }
}

function atomicWriteJson(filePath: string, value: Record<string, unknown>) {
  if (!localPersistenceAvailable) return;
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  const serialized = `${JSON.stringify(value)}\n`;
  try {
    fs.writeFileSync(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    lastPersistenceError = error instanceof Error ? error.message : 'local write failed';
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }
}

async function atomicWriteJsonAsync(filePath: string, value: Record<string, unknown>) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  const serialized = `${JSON.stringify(value)}\n`;
  try {
    await fs.promises.writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(temporaryPath, filePath);
  } catch (error) {
    lastPersistenceError = error instanceof Error ? error.message : 'local write failed';
    await fs.promises.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function mapToSafeObject(store: PersistedStore): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [id, value] of store.entries()) {
    stripSensitiveFieldsInPlace(value);
    output[id] = toPlainPersistenceValue(value);
  }
  return output;
}

function sanitizeStoresInPlace() {
  for (const value of quizzes.values()) stripSensitiveFieldsInPlace(value);
  for (const value of results.values()) stripSensitiveFieldsInPlace(value);
  for (const value of users.values()) stripSensitiveFieldsInPlace(value);
}

function beginLocalSnapshot(): Promise<void> {
  if (!localPersistenceAvailable) return Promise.resolve();
  if (localSaveInFlight) {
    localSaveRequested = true;
    return localSaveInFlight;
  }

  localSaveRequested = false;
  // Snapshot construction happens after the request has returned. Disk I/O is
  // asynchronous, and repeated progressive-result saves are coalesced.
  const quizSnapshot = mapToSafeObject(quizzes);
  const resultSnapshot = mapToSafeObject(results);
  const userSnapshot = mapToSafeObject(users);
  const operation = Promise.all([
    atomicWriteJsonAsync(QUIZZES_FILE, quizSnapshot),
    atomicWriteJsonAsync(RESULTS_FILE, resultSnapshot),
    atomicWriteJsonAsync(USERS_FILE, userSnapshot)
  ]).then(
    () => undefined,
    (error) => {
      console.warn('[Persistence] Failed to save a local snapshot atomically:', error instanceof Error ? error.message : 'unknown error');
    }
  );

  localSaveInFlight = trackPersistence(operation);
  localSaveInFlight.then(
    () => {
      localSaveInFlight = null;
      if (localSaveRequested) scheduleLocalSnapshot();
    },
    () => {
      localSaveInFlight = null;
      if (localSaveRequested) scheduleLocalSnapshot();
    }
  );
  return localSaveInFlight;
}

function scheduleLocalSnapshot(delayMs = positiveInteger(process.env.LOCAL_SAVE_DEBOUNCE_MS, 250, 5_000)) {
  if (!localPersistenceAvailable) return;
  localSaveRequested = true;
  if (localSaveTimer || localSaveInFlight) return;
  localSaveTimer = setTimeout(() => {
    localSaveTimer = undefined;
    void beginLocalSnapshot();
  }, delayMs);
}

export function savePersistentData() {
  // Redaction is synchronous and immediate; the expensive full-store disk
  // snapshot is deferred/coalesced.
  sanitizeStoresInPlace();
  scheduleLocalSnapshot();
}

function recoverTopLevelObject(source: string): { data: Record<string, any>; incompleteKey?: string } {
  let cursor = 0;
  const data: Record<string, any> = {};
  const skipWhitespace = () => {
    while (/\s/.test(source[cursor] || '')) cursor += 1;
  };
  const scanString = () => {
    const start = cursor++;
    let escaped = false;
    while (cursor < source.length) {
      const char = source[cursor++];
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') return source.slice(start, cursor);
    }
    throw new Error('unterminated property name');
  };

  skipWhitespace();
  if (source[cursor++] !== '{') throw new Error('expected top-level object');

  while (cursor < source.length) {
    skipWhitespace();
    if (source[cursor] === ',') {
      cursor += 1;
      skipWhitespace();
    }
    if (source[cursor] === '}' || cursor >= source.length) break;
    if (source[cursor] !== '"') break;

    const key = JSON.parse(scanString());
    skipWhitespace();
    if (source[cursor++] !== ':') return { data, incompleteKey: key };
    skipWhitespace();
    const valueStart = cursor;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let started = false;
    let complete = false;

    while (cursor < source.length) {
      const char = source[cursor];
      if (inString) {
        cursor += 1;
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') {
        inString = true;
        started = true;
        cursor += 1;
      } else if (char === '{' || char === '[') {
        depth += 1;
        started = true;
        cursor += 1;
      } else if (char === '}' || char === ']') {
        depth -= 1;
        cursor += 1;
        if (started && depth === 0) {
          complete = true;
          break;
        }
      } else {
        cursor += 1;
      }
    }

    if (!complete) return { data, incompleteKey: key };
    try {
      data[key] = JSON.parse(source.slice(valueStart, cursor));
    } catch {
      return { data, incompleteKey: key };
    }
  }

  return { data };
}

function backupCorruptFile(filePath: string): string | null {
  try {
    const recoveryRoot = path.resolve(
      process.env.QUIZMOKO_RECOVERY_DIR ||
      path.join(os.tmpdir(), 'quizmoko-recovery')
    );
    fs.mkdirSync(recoveryRoot, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(recoveryRoot, `${path.basename(filePath)}.${stamp}.${process.pid}.bak`);
    fs.copyFileSync(filePath, backupPath);
    return backupPath;
  } catch (error) {
    console.warn('[Persistence] Could not back up a malformed JSON store:', error instanceof Error ? error.message : 'unknown error');
    return null;
  }
}

function removeTemporaryBackup(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return;
    const size = fs.statSync(filePath).size;
    if (size > 0) {
      const descriptor = fs.openSync(filePath, 'r+');
      try {
        const zeroes = Buffer.alloc(Math.min(size, 64 * 1024));
        let offset = 0;
        while (offset < size) {
          const length = Math.min(zeroes.length, size - offset);
          fs.writeSync(descriptor, zeroes, 0, length, offset);
          offset += length;
        }
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    }
    fs.unlinkSync(filePath);
  } catch (error) {
    console.warn('[Persistence] Recovered data, but could not remove its temporary raw backup:', error instanceof Error ? error.message : 'unknown error');
  }
}

function loadStoreFile<T>(
  filePath: string,
  store: Map<string, T>,
  storeName: string
) {
  if (!localPersistenceAvailable || !fs.existsSync(filePath)) return;

  let source: string;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    console.warn(`[Persistence] Could not read ${storeName}:`, error instanceof Error ? error.message : 'unknown error');
    return;
  }

  let parsed: Record<string, any>;
  let recovered = false;
  let incompleteKey: string | undefined;
  try {
    parsed = JSON.parse(source);
  } catch {
    const recovery = recoverTopLevelObject(source);
    parsed = recovery.data;
    incompleteKey = recovery.incompleteKey;
    recovered = true;
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    console.warn(`[Persistence] Ignoring ${storeName}: expected a top-level object.`);
    return;
  }

  for (const [id, value] of Object.entries(parsed)) {
    if (!value || typeof value !== 'object') continue;
    stripSensitiveFieldsInPlace(value);
    store.set(id, value as T);
  }

  if (recovered) {
    const backupPath = backupCorruptFile(filePath);
    if (backupPath) {
      try {
        atomicWriteJson(filePath, mapToSafeObject(store as unknown as PersistedStore));
        removeTemporaryBackup(backupPath);
        console.warn(`[Persistence] Recovered ${Object.keys(parsed).length} complete ${storeName} records and removed the temporary raw backup after verification${incompleteKey ? ` (incomplete record ${incompleteKey} was not loaded)` : ''}.`);
      } catch {
        // atomicWriteJson already recorded the failure; the original remains intact.
      }
    } else {
      console.warn(`[Persistence] Loaded ${Object.keys(parsed).length} recoverable ${storeName} records in memory but left the malformed source untouched because backup failed.`);
    }
  }
}

export function loadPersistentData() {
  // Failures are isolated so a malformed quiz file cannot block users/results.
  loadStoreFile(QUIZZES_FILE, quizzes, 'quiz');
  loadStoreFile(RESULTS_FILE, results, 'result');
  loadStoreFile(USERS_FILE, users, 'user');
}

function validateFirestoreTarget(collectionName: string, documentId: string) {
  if (!VALID_COLLECTIONS.has(collectionName)) {
    throw new Error(`unsupported collection '${collectionName}'`);
  }
  if (
    !documentId ||
    documentId.length > 1_500 ||
    documentId.includes('/') ||
    /[\u0000-\u001f]/.test(documentId)
  ) {
    throw new Error('invalid document id');
  }
}

async function listDocuments(backend: FirestoreBackend, collectionName: string) {
  if (backend.kind === 'admin') {
    const snapshot = await backend.db.collection(collectionName).get();
    return snapshot.docs.map((entry) => ({ id: entry.id, data: entry.data() }));
  }
  const snapshot = await getWebDocs(webCollection(backend.db, collectionName));
  return snapshot.docs.map((entry) => ({ id: entry.id, data: entry.data() }));
}

async function setDocument(
  backend: FirestoreBackend,
  collectionName: string,
  documentId: string,
  data: Record<string, any>
) {
  if (backend.kind === 'admin') {
    await backend.db.collection(collectionName).doc(documentId).set(data);
  } else {
    await setWebDoc(webDoc(backend.db, collectionName, documentId), data);
  }
}

async function deleteDocument(
  backend: FirestoreBackend,
  collectionName: string,
  documentId: string
) {
  if (backend.kind === 'admin') {
    await backend.db.collection(collectionName).doc(documentId).delete();
  } else {
    await deleteWebDoc(webDoc(backend.db, collectionName, documentId));
  }
}

async function listChunkDocuments(
  backend: FirestoreBackend,
  collectionName: string,
  documentId: string
) {
  if (backend.kind === 'admin') {
    const snapshot = await backend.db
      .collection(collectionName)
      .doc(documentId)
      .collection(CHUNK_COLLECTION)
      .get();
    return snapshot.docs.map((entry) => ({ id: entry.id, data: entry.data() }));
  }
  const parent = webDoc(backend.db, collectionName, documentId);
  const snapshot = await getWebDocs(webCollection(parent, CHUNK_COLLECTION));
  return snapshot.docs.map((entry) => ({ id: entry.id, data: entry.data() }));
}

async function setChunkDocument(
  backend: FirestoreBackend,
  collectionName: string,
  documentId: string,
  chunkId: string,
  data: Record<string, any>
) {
  if (backend.kind === 'admin') {
    await backend.db
      .collection(collectionName)
      .doc(documentId)
      .collection(CHUNK_COLLECTION)
      .doc(chunkId)
      .set(data);
  } else {
    const parent = webDoc(backend.db, collectionName, documentId);
    await setWebDoc(webDoc(webCollection(parent, CHUNK_COLLECTION), chunkId), data);
  }
}

async function deleteChunkDocument(
  backend: FirestoreBackend,
  collectionName: string,
  documentId: string,
  chunkId: string
) {
  if (backend.kind === 'admin') {
    await backend.db
      .collection(collectionName)
      .doc(documentId)
      .collection(CHUNK_COLLECTION)
      .doc(chunkId)
      .delete();
  } else {
    const parent = webDoc(backend.db, collectionName, documentId);
    await deleteWebDoc(webDoc(webCollection(parent, CHUNK_COLLECTION), chunkId));
  }
}

function chunkString(value: string, maximumCharacters = FIRESTORE_CHUNK_CHARACTERS): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += maximumCharacters) {
    chunks.push(value.slice(index, index + maximumCharacters));
  }
  return chunks;
}

function compactChunkMetadata(collectionName: string, documentId: string, data: Record<string, any>) {
  const metadataKeys = [
    'id',
    'uid',
    'user_id',
    'title',
    'subject',
    'quiz_id',
    'quiz_title',
    'student_name',
    'created_at',
    'submitted_at',
    'role',
    'status'
  ];
  const metadata: Record<string, any> = {};
  for (const key of metadataKeys) {
    const value = data[key];
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      metadata[key] = value;
    }
  }
  if (!metadata.id && collectionName !== 'users') metadata.id = documentId;
  if (!metadata.uid && collectionName === 'users') metadata.uid = documentId;
  if (Array.isArray(data.questions)) metadata.question_count = data.questions.length;
  return metadata;
}

async function removeStaleChunks(
  backend: FirestoreBackend,
  collectionName: string,
  documentId: string,
  keepGeneration?: string
) {
  const chunks = await listChunkDocuments(backend, collectionName, documentId);
  await Promise.all(chunks
    .filter((chunk) => !keepGeneration || chunk.data?.generation !== keepGeneration)
    .map((chunk) => deleteChunkDocument(backend, collectionName, documentId, chunk.id)));
}

async function writeDocumentWithChunking(
  backend: FirestoreBackend,
  collectionName: string,
  documentId: string,
  rawData: any
) {
  const data = toPlainPersistenceValue(rawData) as Record<string, any>;
  const serialized = JSON.stringify(data);
  const docKey = `${collectionName}/${documentId}`;

  if (Buffer.byteLength(serialized, 'utf8') <= FIRESTORE_INLINE_LIMIT) {
    await setDocument(backend, collectionName, documentId, data);
    if (knownChunkedDocs.has(docKey)) {
      await removeStaleChunks(backend, collectionName, documentId);
      knownChunkedDocs.delete(docKey);
    }
    return;
  }

  const generation = randomUUID();
  const chunks = chunkString(serialized);
  await Promise.all(chunks.map((chunk, index) =>
    setChunkDocument(
      backend,
      collectionName,
      documentId,
      `${generation}_${String(index).padStart(5, '0')}`,
      { generation, index, data: chunk }
    )
  ));

  await setDocument(backend, collectionName, documentId, {
    ...compactChunkMetadata(collectionName, documentId, data),
    _quizmoko_chunked: true,
    _quizmoko_chunk_generation: generation,
    _quizmoko_chunk_count: chunks.length,
    _quizmoko_schema_version: 2
  });
  await removeStaleChunks(backend, collectionName, documentId, generation);
  knownChunkedDocs.add(docKey);
}

async function hydrateChunkedDocument(
  backend: FirestoreBackend,
  collectionName: string,
  documentId: string,
  data: Record<string, any>
) {
  if (!data?._quizmoko_chunked) return data;
  knownChunkedDocs.add(`${collectionName}/${documentId}`);
  const generation = data._quizmoko_chunk_generation;
  const expectedCount = Number(data._quizmoko_chunk_count);
  const chunks = (await listChunkDocuments(backend, collectionName, documentId))
    .filter((chunk) => chunk.data?.generation === generation)
    .sort((a, b) => Number(a.data?.index) - Number(b.data?.index));
  if (!generation || !Number.isInteger(expectedCount) || chunks.length !== expectedCount) {
    throw new Error(`incomplete chunk set (${chunks.length}/${expectedCount || 0})`);
  }
  return JSON.parse(chunks.map((chunk) => String(chunk.data?.data || '')).join(''));
}

function trackPersistence(operation: Promise<void>): Promise<void> {
  pendingPersistence.add(operation);
  operation.then(
    () => pendingPersistence.delete(operation),
    () => pendingPersistence.delete(operation)
  );
  return operation;
}

function enqueueFirestoreMutation(
  collectionName: string,
  documentId: string,
  mutation: () => Promise<void>
): Promise<void> {
  const queueKey = `${collectionName}\u0000${documentId}`;
  const previous = firestoreMutationQueues.get(queueKey) || Promise.resolve();
  // A failed predecessor must not permanently poison the document queue.
  const operation = previous.catch(() => undefined).then(mutation);
  firestoreMutationQueues.set(queueKey, operation);
  operation.then(
    () => {
      if (firestoreMutationQueues.get(queueKey) === operation) {
        firestoreMutationQueues.delete(queueKey);
      }
    },
    () => {
      if (firestoreMutationQueues.get(queueKey) === operation) {
        firestoreMutationQueues.delete(queueKey);
      }
    }
  );
  return trackPersistence(operation);
}

export function syncDocToFirestore(collectionName: string, documentId: string, data: any) {
  try {
    validateFirestoreTarget(collectionName, documentId);
  } catch (error) {
    console.warn('[Firebase] Refused an invalid persistence target:', error instanceof Error ? error.message : 'unknown error');
    return Promise.resolve();
  }

  stripSensitiveFieldsInPlace(data);
  // Capture the exact revision at enqueue time. A later progressive/final
  // mutation of the same in-memory object must not alter an earlier write.
  const persistenceSnapshot = toPlainPersistenceValue(data);
  return enqueueFirestoreMutation(collectionName, documentId, async () => {
    const failureGenerationAtStart = firestoreFailureGeneration;
    const required = isFirestoreRequired();
    const backends = activeFirestoreBackends();
    if (required && backends.length === 0) {
      throw firestoreUnavailable(
        `Cannot persist ${collectionName}/${documentId}`,
        new Error('credentialed Admin Firestore is unavailable')
      );
    }

    const failures: Array<{ backend: FirestoreBackend; error: unknown }> = [];
    for (const backend of backends) {
      try {
        await writeDocumentWithChunking(backend, collectionName, documentId, persistenceSnapshot);
      } catch (error) {
        failures.push({ backend, error });
        console.warn(
          `[Firebase] Error syncing ${collectionName}/${documentId} through ${backend.label}:`,
          errorMessage(error, 'Firestore write failed')
        );
      }
    }

    if (failures.length > 0) {
      const failure = failures[0];
      const message = markFirestoreFailure(
        `Failed to persist ${collectionName}/${documentId} through ${failure.backend.label}`,
        failure.error
      );
      if (required) throw new PersistenceUnavailableError(message);
      return;
    }
    if (backends.length > 0) markFirestoreHealthy(failureGenerationAtStart);
  });
}

export function deleteDocFromFirestore(collectionName: string, documentId: string) {
  try {
    validateFirestoreTarget(collectionName, documentId);
  } catch (error) {
    console.warn('[Firebase] Refused an invalid delete target:', error instanceof Error ? error.message : 'unknown error');
    return Promise.resolve();
  }

  return enqueueFirestoreMutation(collectionName, documentId, async () => {
    const failureGenerationAtStart = firestoreFailureGeneration;
    const required = isFirestoreRequired();
    const backends = activeFirestoreBackends();
    if (required && backends.length === 0) {
      throw firestoreUnavailable(
        `Cannot delete ${collectionName}/${documentId}`,
        new Error('credentialed Admin Firestore is unavailable')
      );
    }

    const failures: Array<{ backend: FirestoreBackend; error: unknown }> = [];
    for (const backend of backends) {
      try {
        const docKey = `${collectionName}/${documentId}`;
        if (knownChunkedDocs.has(docKey)) {
          await removeStaleChunks(backend, collectionName, documentId);
          knownChunkedDocs.delete(docKey);
        }
        await deleteDocument(backend, collectionName, documentId);
      } catch (error) {
        failures.push({ backend, error });
        console.warn(
          `[Firebase] Error deleting ${collectionName}/${documentId} through ${backend.label}:`,
          errorMessage(error, 'Firestore delete failed')
        );
      }
    }

    if (failures.length > 0) {
      const failure = failures[0];
      const message = markFirestoreFailure(
        `Failed to delete ${collectionName}/${documentId} through ${failure.backend.label}`,
        failure.error
      );
      if (required) throw new PersistenceUnavailableError(message);
      return;
    }
    if (backends.length > 0) markFirestoreHealthy(failureGenerationAtStart);
  });
}

interface CollectionLoadResult {
  success: boolean;
  entries: Array<{ id: string; data: Record<string, any> }>;
}

async function loadCollection(
  backend: FirestoreBackend,
  collectionName: string
): Promise<CollectionLoadResult> {
  try {
    const documents = await listDocuments(backend, collectionName);
    let success = true;
    const hydratedEntries = await Promise.all(
      documents.map(async (entry) => {
        try {
          const data = await hydrateChunkedDocument(backend, collectionName, entry.id, entry.data);
          stripSensitiveFieldsInPlace(data);
          return { id: entry.id, data };
        } catch (error) {
          success = false;
          console.warn(`[Firebase] Skipping unreadable ${collectionName}/${entry.id}:`, error instanceof Error ? error.message : 'unknown error');
          return null;
        }
      })
    );
    const hydrated = hydratedEntries.filter((e): e is { id: string; data: Record<string, any> } => e !== null);
    return { success, entries: hydrated };
  } catch (error) {
    lastPersistenceError = error instanceof Error ? error.message : 'Firestore collection load failed';
    console.warn(`[Firebase] Could not load '${collectionName}' through ${backend.label}:`, lastPersistenceError);
    return { success: false, entries: [] };
  }
}

export async function loadFromFirestore(generation = ++firestoreLoadGeneration): Promise<boolean> {
  const backends = activeFirestoreBackends();
  if (backends.length === 0) {
    firestoreHydrated = false;
    markFirestoreFailure('Firestore hydration failed', new Error('no usable Firestore backend'));
    return false;
  }
  console.log('[Firebase] Loading persisted collections before accepting traffic...');

  const stagedLegacyQuizzes = new Map<string, Quiz>();
  const stagedCanonicalQuizzes = new Map<string, Quiz>();
  const stagedResults = new Map<string, QuizResult>();
  const stagedUsers = new Map<string, User>();
  const readSuccess = {
    quizzes: true,
    results: true,
    users: true
  };

  for (const backend of backends) {
    // Load collections concurrently across the backend
    const [legacyQuizzes, canonicalQuizzes, remoteResults, remoteUsers] = await Promise.all([
      loadCollection(backend, 'quiz'),
      loadCollection(backend, 'quizzes'),
      loadCollection(backend, 'results'),
      loadCollection(backend, 'users')
    ]);

    readSuccess.quizzes &&= legacyQuizzes.success && canonicalQuizzes.success;
    readSuccess.results &&= remoteResults.success;
    readSuccess.users &&= remoteUsers.success;

    for (const entry of legacyQuizzes.entries) {
      const id = String(entry.data.id || entry.id);
      stagedLegacyQuizzes.set(id, { ...entry.data, id } as Quiz);
    }
    for (const entry of canonicalQuizzes.entries) {
      const id = String(entry.data.id || entry.id);
      stagedCanonicalQuizzes.set(id, { ...entry.data, id } as Quiz);
    }
    for (const entry of remoteResults.entries) {
      const id = String(entry.data.id || entry.id);
      stagedResults.set(id, { ...entry.data, id } as QuizResult);
    }
    for (const entry of remoteUsers.entries) {
      const uid = String(entry.data.uid || entry.data.id || entry.id);
      stagedUsers.set(uid, { ...entry.data, uid } as User);
    }
  }

  // A timed-out cold-start load is intentionally discarded rather than racing
  // with quiz edits accepted after the HTTP listener becomes ready.
  if (generation !== firestoreLoadGeneration) return false;

  let replacedAnyCollection = false;
  if (readSuccess.quizzes) {
    quizzes.clear();
    stagedLegacyQuizzes.forEach((value, id) => quizzes.set(id, value));
    // Canonical records win globally, including across multiple databases.
    stagedCanonicalQuizzes.forEach((value, id) => quizzes.set(id, value));
    replacedAnyCollection = true;
  }
  if (readSuccess.results) {
    results.clear();
    stagedResults.forEach((value, id) => results.set(id, value));
    replacedAnyCollection = true;
  }
  if (readSuccess.users) {
    users.clear();
    stagedUsers.forEach((value, id) => users.set(id, value));
    replacedAnyCollection = true;
  }

  firestoreHydrated = readSuccess.quizzes && readSuccess.results && readSuccess.users;
  if (replacedAnyCollection) savePersistentData();
  const retainedCollections = Object.entries(readSuccess)
    .filter(([, success]) => !success)
    .map(([name]) => name);
  if (retainedCollections.length > 0) {
    console.warn(`[Firebase] Retained local fallback for failed collection reads: ${retainedCollections.join(', ')}.`);
  }
  if (firestoreHydrated) {
    markFirestoreHealthy();
  } else {
    markFirestoreFailure(
      'Firestore hydration failed',
      new Error(`could not fully read: ${retainedCollections.join(', ') || 'unknown collection'}`)
    );
  }
  console.log(`[Firebase] Ready with ${quizzes.size} quizzes, ${results.size} results, and ${users.size} users.`);
  return firestoreHydrated;
}

export function getUniqueQuizTitle(title: string, currentQuizId?: string): string {
  const baseTitle = String(title || '').trim();
  let uniqueTitle = baseTitle;
  let counter = 1;

  const otherQuizzes = Array.from(quizzes.values()).filter((q: any) => q.id !== currentQuizId);

  while (otherQuizzes.some((q: any) => (q.title || '').trim().toLowerCase() === uniqueTitle.toLowerCase())) {
    uniqueTitle = `${baseTitle} (${counter})`;
    counter++;
  }

  return uniqueTitle;
}

export function getQuizTimestamp(q: any): number {
  if (!q) return 0;
  const val = q.created_at || q.createdAt || q.timestamp;
  if (!val) return 0;

  if (typeof val === 'object') {
    if (typeof val.seconds === 'number') {
      return val.seconds * 1000 + (val.nanoseconds ? val.nanoseconds / 1e6 : 0);
    }
    if (typeof val._seconds === 'number') {
      return val._seconds * 1000 + (val._nanoseconds ? val._nanoseconds / 1e6 : 0);
    }
    if (val.toDate && typeof val.toDate === 'function') {
      return val.toDate().getTime();
    }
  }

  if (typeof val === 'string') {
    const tsMatch = val.match(/seconds=(\d+)/);
    if (tsMatch) {
      return parseInt(tsMatch[1], 10) * 1000;
    }
    const parsed = Date.parse(val);
    if (!isNaN(parsed)) {
      return parsed;
    }
  }

  if (typeof val === 'number') {
    return val > 1e11 ? val : val * 1000;
  }

  return 0;
}

export function getOrCreateLiveState(quizId: string) {
  if (!liveSessions.has(quizId)) {
    liveSessions.set(quizId, {
      paused: false,
      terminated: false,
      sessions: {}
    });
  }
  return liveSessions.get(quizId)!;
}

export const PORT = positiveInteger(process.env.PORT, 3000, 65_535);

export function getPersistenceStatus() {
  const firestoreRequired = isFirestoreRequired();
  const firestoreCredentialed = hasCredentialedFirestoreBackend();
  const ready = persistenceReady && (
    !firestoreRequired ||
    (firestoreCredentialed && firestoreHydrated && firestoreHealthy)
  );
  return {
    ready,
    local: localPersistenceAvailable,
    dataDirectory: DATA_DIR,
    firestoreConfigured: firestoreDbs.length > 0,
    firestoreRequired,
    firestoreCredentialed,
    firestoreHydrated,
    firestoreHealthy,
    firestoreBackends: firestoreDbs.map((backend) => backend.label),
    pendingWrites: pendingPersistence.size,
    lastError: lastPersistenceError || null
  };
}

export async function flushPendingPersistence(timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    if (localSaveTimer) {
      clearTimeout(localSaveTimer);
      localSaveTimer = undefined;
    }
    if (localSaveRequested && !localSaveInFlight) {
      void beginLocalSnapshot();
    }

    const operations = Array.from(pendingPersistence);
    if (operations.length === 0 && !localSaveRequested && !localSaveInFlight) return true;

    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    let timer: NodeJS.Timeout | undefined;
    const settled = Promise.allSettled(operations).then(() => true);
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), remaining);
    });
    const complete = await Promise.race([settled, timedOut]);
    if (timer) clearTimeout(timer);
    if (!complete) return false;
  }
}

export function initDatabase(): Promise<void> {
  if (databaseInitialization) return databaseInitialization;

  databaseInitialization = (async () => {
    loadPersistentData();
    configureFirestoreBackends();

    const required = isFirestoreRequired();
    if (required && !hasCredentialedFirestoreBackend()) {
      throw firestoreUnavailable(
        'Firestore startup requirement was not met',
        new Error('credentialed Admin Firestore is unavailable')
      );
    }

    if (activeFirestoreBackends().length > 0) {
      const startupTimeoutMs = positiveInteger(
        process.env.FIRESTORE_STARTUP_TIMEOUT_MS,
        15_000,
        120_000
      );
      const generation = ++firestoreLoadGeneration;
      let timer: NodeJS.Timeout | undefined;
      const remoteLoad = loadFromFirestore(generation).catch((error) => {
        const message = markFirestoreFailure('Firestore startup hydration failed', error);
        console.warn('[Firebase] Startup hydration failed:', message);
        return false;
      });
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), startupTimeoutMs);
      });
      const outcome = await Promise.race([remoteLoad, timeout]);
      if (timer) clearTimeout(timer);

      if (outcome === 'timeout') {
        // Invalidate the still-running staged load so it cannot overwrite edits.
        firestoreLoadGeneration += 1;
        const error = firestoreUnavailable(
          'Firestore startup hydration timed out',
          new Error(`exceeded ${startupTimeoutMs}ms`)
        );
        if (required) throw error;
        console.warn(`[Firebase] ${error.message}; serving local data without a background overwrite race.`);
      } else if (!outcome && required) {
        throw new PersistenceUnavailableError(
          lastFirestoreError || 'Firestore startup hydration did not complete'
        );
      }
    }

    persistenceReady = true;
  })();

  return databaseInitialization;
}
