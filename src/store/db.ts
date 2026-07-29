import fs from 'fs';
import path from 'path';
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, setDoc, deleteDoc, setLogLevel } from 'firebase/firestore';
import type { User, Quiz, QuizResult, LiveSessionState } from '../types.ts';

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
const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const QUIZZES_FILE = path.join(DATA_DIR, 'quizzes.json');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

export const firestoreDbs: any[] = [];

try {
  const cfgPath = path.join(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(cfgPath)) {
    const firebaseConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    const fbApp = getApps().length === 0 ? initializeApp({
      apiKey: firebaseConfig.apiKey,
      authDomain: firebaseConfig.authDomain,
      projectId: firebaseConfig.projectId,
      storageBucket: firebaseConfig.storageBucket,
      messagingSenderId: firebaseConfig.messagingSenderId,
      appId: firebaseConfig.appId
    }) : getApp();

    setLogLevel('error');
    firestoreDbs.push(getFirestore(fbApp, '(default)'));
    const namedDbId = firebaseConfig.firestoreDatabaseId;
    if (namedDbId && namedDbId !== '(default)') {
      firestoreDbs.push(getFirestore(fbApp, namedDbId));
    }
    console.log(`[Firebase] Configured Firestore for project '${firebaseConfig.projectId}'`);
  }
} catch (e) {
  console.warn('[Firebase] Config initialization warning:', e);
}

export function savePersistentData() {
  try {
    fs.writeFileSync(QUIZZES_FILE, JSON.stringify(Object.fromEntries(quizzes), null, 2));
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(Object.fromEntries(results), null, 2));
    fs.writeFileSync(USERS_FILE, JSON.stringify(Object.fromEntries(users), null, 2));
  } catch (err) {
    console.warn('Failed to save data to disk:', err);
  }
}

export async function syncDocToFirestore(collName: string, docId: string, data: any) {
  if (firestoreDbs.length === 0) return;
  for (const dbInstance of firestoreDbs) {
    try {
      await setDoc(doc(dbInstance, collName, docId), data, { merge: true });
    } catch (err) {
      console.warn(`[Firebase] Error syncing ${collName}/${docId}:`, err);
    }
  }
}

export async function deleteDocFromFirestore(collName: string, docId: string) {
  if (firestoreDbs.length === 0) return;
  for (const dbInstance of firestoreDbs) {
    try {
      await deleteDoc(doc(dbInstance, collName, docId));
    } catch (err) {
      console.warn(`[Firebase] Error deleting ${collName}/${docId}:`, err);
    }
  }
}

export function loadPersistentData() {
  try {
    if (fs.existsSync(QUIZZES_FILE)) {
      const data = JSON.parse(fs.readFileSync(QUIZZES_FILE, 'utf-8'));
      Object.entries(data).forEach(([k, v]) => quizzes.set(k, v as Quiz));
    }
    if (fs.existsSync(RESULTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8'));
      Object.entries(data).forEach(([k, v]) => results.set(k, v as QuizResult));
    }
    if (fs.existsSync(USERS_FILE)) {
      const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
      Object.entries(data).forEach(([k, v]) => users.set(k, v as User));
    }
  } catch (err) {
    console.warn('Failed to load data from disk:', err);
  }
}

export async function loadFromFirestore() {
  if (firestoreDbs.length === 0) return;
  console.log('[Firebase] Loading data from Firestore collections...');

  for (const dbInstance of firestoreDbs) {
    try {
      // 1. Quizzes
      const quizSnap = await getDocs(collection(dbInstance, 'quizzes'));
      quizSnap.forEach((d) => {
        const val = d.data();
        const quizId = val.id || d.id;
        quizzes.set(quizId, { ...val, id: quizId } as Quiz);
      });

      const altQuizSnap = await getDocs(collection(dbInstance, 'quiz')).catch(() => null);
      if (altQuizSnap) {
        altQuizSnap.forEach((d) => {
          const val = d.data();
          const quizId = val.id || d.id;
          quizzes.set(quizId, { ...val, id: quizId } as Quiz);
        });
      }

      // 2. Results
      const resSnap = await getDocs(collection(dbInstance, 'results'));
      resSnap.forEach((d) => {
        const val = d.data();
        const resId = val.id || d.id;
        results.set(resId, { ...val, id: resId } as QuizResult);
      });

      // 3. Users
      const userSnap = await getDocs(collection(dbInstance, 'users'));
      userSnap.forEach((d) => {
        const val = d.data();
        const uId = val.uid || val.id || d.id;
        users.set(uId, { ...val, uid: uId } as User);
      });
    } catch (err) {
      console.warn('[Firebase] Firestore load notice:', err);
    }
  }

  savePersistentData();
  console.log(`[Firebase] Loaded ${quizzes.size} quizzes, ${results.size} results, ${users.size} users.`);
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

export const PORT = 3000;

export function initDatabase() {
  loadPersistentData();
  loadFromFirestore().catch(err => {
    console.warn('[Firebase] Failed to load from Firestore:', err);
  });
}
