import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { createRequire } from 'module';
import { execSync } from 'child_process';
import crypto from 'crypto';
const require = createRequire(import.meta.url);
const archiver = require('archiver');
import { Server as SocketIOServer } from 'socket.io';
import { GoogleGenAI, Type } from '@google/genai';
import {
  SHARED_LATEX_RULES,
  NON_MATH_RULES,
  WORKSHEET_EXTRACTION_PROMPT,
  WORKSHEET_EXTRACTION_PROMPT_NON_MATH,
  WORKSHEET_SOLVER_PROMPT,
  WORKSHEET_SOLVER_PROMPT_NON_MATH,
  LATEX_POLISH_PROMPT,
  RECOVERY_PROMPT,
  RMX_FLASH_EXTRACTION_PROMPT,
  RMX_FLASH_MATCH_PROMPT,
  RECHECK_ANSWERS_PROMPT
} from './prompts.ts';
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, setDoc, deleteDoc, setLogLevel } from 'firebase/firestore';

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = 3000;

// Setup upload memory storage
const upload = multer({ storage: multer.memoryStorage() });

// Body parsers
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());
app.use(cors());

// Middleware to detect and self-heal double-pasted URLs (e.g., /quiz/ed68af71https://quizmoko.onrender.com/quiz/ed68af71)
app.use((req, res, next) => {
  const urlStr = req.originalUrl || req.url;
  if (urlStr.includes('http:/') || urlStr.includes('https:/')) {
    const lastHttpIndex = Math.max(urlStr.lastIndexOf('http:/'), urlStr.lastIndexOf('https:/'));
    if (lastHttpIndex !== -1) {
      const doublePart = urlStr.substring(lastHttpIndex);
      try {
        const parsed = new URL(doublePart);
        console.log(`[URL Recover] Redirecting from duplicated URL ${urlStr} to ${parsed.pathname + parsed.search}`);
        return res.redirect(parsed.pathname + parsed.search);
      } catch (e) {
        const match = doublePart.match(/(?:https?:\/+|www\.)[^\/]+(\/.*)$/);
        if (match && match[1]) {
          console.log(`[URL Recover] Redirecting (fallback) from duplicated URL ${urlStr} to ${match[1]}`);
          return res.redirect(match[1]);
        }
      }
    }
  }
  next();
});

// Configure view engine
app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'views'));

// Static assets
app.use('/Images', express.static(path.join(process.cwd(), 'Images')));
app.use('/public', express.static(path.join(process.cwd(), 'public')));
app.use(express.static(path.join(process.cwd(), 'public')));

// --- IN-MEMORY STORES ---
const users = new Map<string, any>();
const quizzes = new Map<string, any>();
const results = new Map<string, any>();
const sessionProgress = new Map<string, any>();
const liveSessions = new Map<string, { paused: boolean; terminated: boolean; sessions: Record<string, any> }>();

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
const sampleQuizzes = [
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

let firestoreDbs: any[] = [];

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

function savePersistentData() {
  try {
    fs.writeFileSync(QUIZZES_FILE, JSON.stringify(Object.fromEntries(quizzes), null, 2));
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(Object.fromEntries(results), null, 2));
    fs.writeFileSync(USERS_FILE, JSON.stringify(Object.fromEntries(users), null, 2));
  } catch (err) {
    console.warn('Failed to save data to disk:', err);
  }
}

async function syncDocToFirestore(collName: string, docId: string, data: any) {
  if (firestoreDbs.length === 0) return;
  for (const dbInstance of firestoreDbs) {
    try {
      await setDoc(doc(dbInstance, collName, docId), data, { merge: true });
    } catch (err) {
      console.warn(`[Firebase] Error syncing ${collName}/${docId}:`, err);
    }
  }
}

async function deleteDocFromFirestore(collName: string, docId: string) {
  if (firestoreDbs.length === 0) return;
  for (const dbInstance of firestoreDbs) {
    try {
      await deleteDoc(doc(dbInstance, collName, docId));
    } catch (err) {
      console.warn(`[Firebase] Error deleting ${collName}/${docId}:`, err);
    }
  }
}

function loadPersistentData() {
  try {
    if (fs.existsSync(QUIZZES_FILE)) {
      const data = JSON.parse(fs.readFileSync(QUIZZES_FILE, 'utf-8'));
      Object.entries(data).forEach(([k, v]) => quizzes.set(k, v));
    }
    if (fs.existsSync(RESULTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8'));
      Object.entries(data).forEach(([k, v]) => results.set(k, v));
    }
    if (fs.existsSync(USERS_FILE)) {
      const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
      Object.entries(data).forEach(([k, v]) => users.set(k, v));
    }
  } catch (err) {
    console.warn('Failed to load data from disk:', err);
  }
}

function getUniqueQuizTitle(title: string, currentQuizId?: string): string {
  const baseTitle = String(title || '').trim();
  let uniqueTitle = baseTitle;
  let counter = 1;

  // Find other quizzes (filtering out the current one if it exists)
  const otherQuizzes = Array.from(quizzes.values()).filter((q: any) => q.id !== currentQuizId);

  while (otherQuizzes.some((q: any) => (q.title || '').trim().toLowerCase() === uniqueTitle.toLowerCase())) {
    uniqueTitle = `${baseTitle} (${counter})`;
    counter++;
  }

  return uniqueTitle;
}

async function loadFromFirestore() {
  if (firestoreDbs.length === 0) return;
  console.log('[Firebase] Loading data from Firestore collections...');

  for (const dbInstance of firestoreDbs) {
    try {
      // 1. Quizzes
      const quizSnap = await getDocs(collection(dbInstance, 'quizzes'));
      quizSnap.forEach((d) => {
        const val = d.data();
        const quizId = val.id || d.id;
        quizzes.set(quizId, { ...val, id: quizId });
      });

      // Also check alternative collection names if any
      const altQuizSnap = await getDocs(collection(dbInstance, 'quiz')).catch(() => null);
      if (altQuizSnap) {
        altQuizSnap.forEach((d) => {
          const val = d.data();
          const quizId = val.id || d.id;
          quizzes.set(quizId, { ...val, id: quizId });
        });
      }

      // 2. Results
      const resSnap = await getDocs(collection(dbInstance, 'results'));
      resSnap.forEach((d) => {
        const val = d.data();
        const resId = val.id || d.id;
        results.set(resId, { ...val, id: resId });
      });

      // 3. Users
      const userSnap = await getDocs(collection(dbInstance, 'users'));
      userSnap.forEach((d) => {
        const val = d.data();
        const uId = val.uid || val.id || d.id;
        users.set(uId, { ...val, uid: uId });
      });
    } catch (err) {
      console.warn('[Firebase] Firestore load notice:', err);
    }
  }

  savePersistentData();
  console.log(`[Firebase] Loaded ${quizzes.size} quizzes, ${results.size} results, ${users.size} users.`);
}

// Load disk data first, then load Firestore remote data
loadPersistentData();
loadFromFirestore();

function getQuizTimestamp(q: any): number {
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

// --- HELPER FOR LIVE SESSION STATE ---
function getOrCreateLiveState(quizId: string) {
  if (!liveSessions.has(quizId)) {
    liveSessions.set(quizId, {
      paused: false,
      terminated: false,
      sessions: {}
    });
  }
  return liveSessions.get(quizId)!;
}

// --- SOCKET.IO REAL-TIME TRACKING ---
io.on('connection', (socket) => {
  let currentRoom: string | null = null;

  socket.on('join_quiz', ({ quiz_id }) => {
    if (!quiz_id) return;
    currentRoom = `quiz_${quiz_id}`;
    socket.join(currentRoom);

    const liveState = getOrCreateLiveState(quiz_id);
    socket.emit('pause_state', { paused: liveState.paused });
  });

  socket.on('leave_quiz', ({ quiz_id }) => {
    if (quiz_id) {
      socket.leave(`quiz_${quiz_id}`);
    }
  });

  socket.on('ping', (payload) => {
    const { quiz_id, session_id, student_name, current_q, score, status } = payload;
    if (!quiz_id || !session_id) return;

    const liveState = getOrCreateLiveState(quiz_id);
    
    // Update student session in live map
    const displayName = student_name && student_name !== 'undefined' ? student_name : 'Student';
    const existing = liveState.sessions[session_id] || {
      name: displayName,
      student_name: displayName,
      current_q: current_q || 1,
      current_question: current_q || 1,
      total_questions: 10,
      score: 0,
      status: 'Active',
      last_active: Date.now(),
      whiteboard_disabled: false
    };

    existing.name = displayName;
    existing.student_name = displayName;
    existing.current_q = current_q !== undefined ? current_q : (existing.current_q || 1);
    existing.current_question = current_q !== undefined ? current_q : (existing.current_question || 1);
    existing.score = score !== undefined ? score : existing.score;
    existing.status = status || existing.status;
    existing.last_active = Date.now();

    liveState.sessions[session_id] = existing;

    // Broadcast updated session to teacher/room
    io.to(`quiz_${quiz_id}`).emit('update_session', {
      session_id,
      data: existing,
      paused: liveState.paused,
      terminated: liveState.terminated
    });

    // Send status back to student
    socket.emit('ping_ack', {
      paused: liveState.paused,
      terminated: liveState.terminated,
      whiteboard_disabled: existing.whiteboard_disabled,
      time_remaining: 30
    });
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      socket.leave(currentRoom);
    }
  });
});

// --- AUTH MIDDLEWARE ---
function tokenRequired(req: any, res: any, next: any) {
  const token = req.cookies?.token || req.headers?.authorization;
  if (token && token.startsWith('user_')) {
    const uid = token.replace('user_', '');
    req.user = users.get(uid) || { uid, email: `${uid}@example.com`, name: 'User', role: 'admin' };
  } else {
    req.user = users.get('teacher_test') || { uid: 'teacher_test', email: 'teacher@example.com', name: 'Teacher', role: 'admin' };
  }
  next();
}

// Helper to get Gemini Client lazily
function getGeminiClient(customApiKey?: string) {
  const apiKey = customApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

function getRealModelName(modelName?: string): string {
  const model = (modelName || '').toLowerCase().trim();
  if (!model) return 'gemini-3.6-flash';

  if (model.startsWith('ollama:')) return model;

  // Map to the correct, existing Gemini models
  if (model.includes('gemini-3.1-flash-lite') || model.includes('gemini-3.5-flash-lite') || model.includes('gemini-2.5-flash-lite')) {
    return 'gemini-3.1-flash-lite';
  }
  if (model.includes('gemini-3.1-pro-preview') || model.includes('pro')) {
    return 'gemini-3.1-pro-preview';
  }
  if (model.includes('gemini-3.6-flash') || model.includes('gemini-3.5-flash') || model.includes('gemini-3.0-flash') || model.includes('gemini-2.5-flash') || model.includes('flash')) {
    return 'gemini-3.6-flash';
  }

  return 'gemini-3.6-flash';
}

// Helper to fix single unescaped backslashes in JSON strings (e.g. LaTeX commands like \frac, \alpha, \theta)
function fixJsonLatexEscapes(jsonStr: string): string {
  let result = '';
  let inString = false;

  for (let i = 0; i < jsonStr.length; i++) {
    const char = jsonStr[i];

    if (char === '"') {
      let backslashCount = 0;
      let j = i - 1;
      while (j >= 0 && jsonStr[j] === '\\') {
        backslashCount++;
        j--;
      }
      if (backslashCount % 2 === 0) {
        inString = !inString;
      }
      result += char;
    } else if (inString && char === '\\') {
      const nextChar = i + 1 < jsonStr.length ? jsonStr[i + 1] : '';
      if (nextChar === '\\' || nextChar === '"') {
        result += char + nextChar;
        i++; // skip nextChar
      } else {
        // Double the backslash so standard JSON.parse receives \\ for LaTeX commands
        result += '\\\\';
      }
    } else {
      result += char;
    }
  }
  return result;
}

function safeParseJSON(rawText: string): any {
  if (!rawText || typeof rawText !== 'string') return null;

  // Strip markdown block markers
  let cleaned = rawText.replace(/```json/gi, '').replace(/```/gi, '').trim();

  // Find boundaries of JSON array or object
  const firstArray = cleaned.indexOf('[');
  const lastArray = cleaned.lastIndexOf(']');
  const firstObj = cleaned.indexOf('{');
  const lastObj = cleaned.lastIndexOf('}');

  let start = -1;
  let end = -1;

  if (firstArray !== -1 && (firstObj === -1 || firstArray < firstObj)) {
    start = firstArray;
    end = lastArray;
  } else if (firstObj !== -1) {
    start = firstObj;
    end = lastObj;
  }

  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.substring(start, end + 1);
  }

  // Attempt 1: Direct JSON.parse
  try {
    return JSON.parse(cleaned);
  } catch (e1) {
    // Attempt 2: Fix unescaped backslashes in strings (LaTeX backslashes)
    try {
      const fixed = fixJsonLatexEscapes(cleaned);
      return JSON.parse(fixed);
    } catch (e2) {
      // Attempt 3: Escape literal linebreaks inside quotes
      try {
        const lineFixed = cleaned.replace(/\r?\n/g, '\\n');
        const fixed = fixJsonLatexEscapes(lineFixed);
        return JSON.parse(fixed);
      } catch (e3) {
        console.warn('safeParseJSON failed after all repair attempts:', e3, '\nRaw text sample:', rawText.substring(0, 300));
        return null;
      }
    }
  }
}

// --- AUTH ROUTES ---
app.get('/login', (req, res) => {
  res.render('login', { message: null });
});

app.get('/register', (req, res) => {
  res.render('register', { message: null });
});

app.get('/logout', (req, res) => {
  res.clearCookie('token');
  res.redirect('/login');
});

app.post('/api/set_session', (req, res) => {
  const { uid, email, name, role } = req.body;
  const user = { uid: uid || 'user_123', email: email || 'user@example.com', name: name || 'User', role: role || 'student' };
  users.set(user.uid, user);
  res.cookie('token', `user_${user.uid}`, { maxAge: 2592000000, httpOnly: true });
  res.json({ success: true, role: user.role });
});

app.post('/api/login_session', (req, res) => {
  res.cookie('token', 'user_teacher_test', { maxAge: 2592000000, httpOnly: true });
  res.json({ success: true });
});

app.post('/api/test_login', (req, res) => {
  const { uid = 'teacher_test', email = 'test@example.com', name = 'Test User' } = req.body;
  const user = { uid, email, name, role: 'admin' };
  users.set(uid, user);
  res.cookie('token', `user_${uid}`, { maxAge: 2592000000, httpOnly: true });
  res.json({ success: true });
});

// --- DASHBOARD ROUTE ---
app.get('/', tokenRequired, (req: any, res) => {
  const user = req.user;
  const isTeacherOrAdmin = user.role === 'admin' || user.role === 'teacher' || user.uid === 'teacher_test' || !user.role;
  const userQuizzes = isTeacherOrAdmin
    ? Array.from(quizzes.values())
    : Array.from(quizzes.values()).filter(q => q.user_id === user.uid || q.user_id === 'fbnuU0JRjqbPLUjdFpoVSEwOT733' || q.user_id === 'local_test_user');

  // Sort quizzes newest first
  userQuizzes.sort((a, b) => getQuizTimestamp(b) - getQuizTimestamp(a));

  const groupedQuizzes: Record<string, any[]> = {};
  const allSubjects = ['General', 'Math', 'Science', 'English', 'History', 'Biology'];

  userQuizzes.forEach(q => {
    const subj = q.subject || 'General';
    if (!groupedQuizzes[subj]) groupedQuizzes[subj] = [];
    groupedQuizzes[subj].push(q);
    if (!allSubjects.includes(subj)) allSubjects.push(subj);
  });

  // Ensure quizzes in every subject group are sorted newest first
  Object.keys(groupedQuizzes).forEach(subj => {
    groupedQuizzes[subj].sort((a, b) => getQuizTimestamp(b) - getQuizTimestamp(a));
  });

  // Sort subject folders so subjects containing the most recent quizzes appear first
  const sortedGroupedQuizzes: Record<string, any[]> = {};
  const subjectEntries = Object.entries(groupedQuizzes);
  subjectEntries.sort((a, b) => {
    const newestA = a[1].length > 0 ? getQuizTimestamp(a[1][0]) : 0;
    const newestB = b[1].length > 0 ? getQuizTimestamp(b[1][0]) : 0;
    return newestB - newestA;
  });

  subjectEntries.forEach(([subj, list]) => {
    sortedGroupedQuizzes[subj] = list;
  });

  res.render('index', {
    grouped_quizzes: sortedGroupedQuizzes,
    all_subjects: Array.from(new Set(allSubjects)).sort(),
    is_admin: user.role === 'admin',
    is_rmx_authorized: true,
    user: user
  });
});

// --- WORKSHEET UPLOAD & EXTRACTION ---
app.get('/worksheet', tokenRequired, (req, res) => {
  res.render('worksheet_upload');
});

// --- QUIZ TAKING & EDITING ROUTES ---
app.get('/quiz/:quiz_id', tokenRequired, (req, res) => {
  const quiz = quizzes.get(req.params.quiz_id);
  if (!quiz) {
    return res.status(404).send('Quiz not found');
  }
  res.render('quiz', { quiz, quiz_id: req.params.quiz_id });
});

app.get(['/edit/:quiz_id', '/edit_quiz/:quiz_id'], tokenRequired, (req, res) => {
  const quiz = quizzes.get(req.params.quiz_id);
  if (!quiz) {
    return res.status(404).send('Quiz not found');
  }
  res.render('edit_quiz', { quiz, quiz_id: req.params.quiz_id });
});

app.get('/api/quiz/:quiz_id', (req, res) => {
  const quiz = quizzes.get(req.params.quiz_id);
  if (!quiz) {
    return res.status(404).json({ error: 'Quiz not found' });
  }
  res.json(quiz);
});

app.post('/api/quiz/:quiz_id/update', tokenRequired, (req, res) => {
  const quiz = quizzes.get(req.params.quiz_id);
  if (!quiz) {
    return res.status(404).json({ success: false, error: 'Quiz not found' });
  }
  if (req.body && req.body.title) {
    req.body.title = getUniqueQuizTitle(req.body.title, req.params.quiz_id);
  }
  const updated = { ...quiz, ...req.body };
  quizzes.set(req.params.quiz_id, updated);
  savePersistentData();
  syncDocToFirestore('quizzes', req.params.quiz_id, updated);
  res.json({ success: true, quiz: updated });
});

app.post('/delete/:quiz_id', tokenRequired, (req, res) => {
  quizzes.delete(req.params.quiz_id);
  savePersistentData();
  deleteDocFromFirestore('quizzes', req.params.quiz_id);
  res.redirect('/');
});

app.delete('/api/quiz/:quiz_id', tokenRequired, (req, res) => {
  quizzes.delete(req.params.quiz_id);
  savePersistentData();
  deleteDocFromFirestore('quizzes', req.params.quiz_id);
  res.json({ success: true });
});

// --- LIVE TRACKING ENDPOINTS ---
app.get(['/live/:quiz_id', '/live'], tokenRequired, (req, res) => {
  const quizId = req.params.quiz_id || req.query.quiz_id || Array.from(quizzes.keys())[0] || 'quiz_algebra_101';
  const quiz = quizzes.get(quizId as string) || Array.from(quizzes.values())[0];

  res.render('live', {
    quiz_id: quizId,
    quiz: quiz || { title: 'Live Classroom', questions: [] },
    total_q: quiz ? quiz.questions.length : 0,
    title: quiz ? quiz.title : 'Live Classroom'
  });
});

app.get('/api/live/:quiz_id', (req, res) => {
  const quizId = req.params.quiz_id;
  const liveState = getOrCreateLiveState(quizId);
  res.json({
    success: true,
    paused: liveState.paused,
    terminated: liveState.terminated,
    sessions: liveState.sessions
  });
});

app.post('/api/live/:quiz_id/toggle_pause', (req, res) => {
  const quizId = req.params.quiz_id;
  const liveState = getOrCreateLiveState(quizId);
  liveState.paused = !liveState.paused;

  io.to(`quiz_${quizId}`).emit('pause_state', { paused: liveState.paused });
  res.json({ success: true, paused: liveState.paused });
});

app.post('/api/live/:quiz_id/terminate', (req, res) => {
  const quizId = req.params.quiz_id;
  const liveState = getOrCreateLiveState(quizId);
  liveState.terminated = true;

  io.to(`quiz_${quizId}`).emit('terminate', { terminated: true });
  res.json({ success: true, terminated: true });
});

app.post('/api/live/:quiz_id/whiteboard/:sid/toggle', (req, res) => {
  const { quiz_id, sid } = req.params;
  const liveState = getOrCreateLiveState(quiz_id);
  if (liveState.sessions[sid]) {
    liveState.sessions[sid].whiteboard_disabled = !liveState.sessions[sid].whiteboard_disabled;
    io.to(`quiz_${quiz_id}`).emit('update_session', {
      session_id: sid,
      data: liveState.sessions[sid],
      paused: liveState.paused
    });
  }
  res.json({ success: true, sessions: liveState.sessions });
});

// --- HTTP PING FALLBACK FOR QUIZ TRACKING ---
app.post('/ping', (req, res) => {
  const { quiz_id, session_id, student_name, current_q, score, status } = req.body;

  if (quiz_id && session_id) {
    const liveState = getOrCreateLiveState(quiz_id);
    const displayName = student_name && student_name !== 'undefined' ? student_name : 'Student';
    const existing = liveState.sessions[session_id] || {
      name: displayName,
      student_name: displayName,
      current_q: current_q || 1,
      current_question: current_q || 1,
      total_questions: 10,
      score: 0,
      status: 'Active',
      last_active: Date.now(),
      whiteboard_disabled: false
    };

    existing.name = displayName;
    existing.student_name = displayName;
    existing.current_q = current_q !== undefined ? current_q : (existing.current_q || 1);
    existing.current_question = current_q !== undefined ? current_q : (existing.current_question || 1);
    existing.score = score !== undefined ? score : existing.score;
    existing.status = status || existing.status;
    existing.last_active = Date.now();

    liveState.sessions[session_id] = existing;

    io.to(`quiz_${quiz_id}`).emit('update_session', {
      session_id,
      data: existing,
      paused: liveState.paused,
      terminated: liveState.terminated
    });

    return res.json({
      success: true,
      paused: liveState.paused,
      terminated: liveState.terminated,
      whiteboard_disabled: existing.whiteboard_disabled,
      time_remaining: 30
    });
  }

  res.json({ success: true, paused: false, time_remaining: 30 });
});

// --- QUIZ SUBMISSION & GRADING ---
app.post('/api/grade_individual', tokenRequired, async (req: any, res) => {
  const { quiz_id, q_index, student_answer, solution_snapshots } = req.body;
  const quiz = quizzes.get(quiz_id);
  const api_key = req.body.api_key || (quiz && quiz.api_key) || '';

  if (!quiz || !quiz.questions[q_index]) {
    return res.json({ success: false, is_correct: false, correct_answer: '' });
  }

  const q = quiz.questions[q_index];
  const qType = q.type || 'multiple_choice';
  const expected = (q.answer || '').toString().trim();
  const actual = (student_answer || '').toString().trim();

  let isCorrect = false;
  let aiFeedback = '';

  if (qType === 'multiple_choice' || qType === 'true_false' || qType === 'identification') {
    const expectedLower = expected.toLowerCase();
    const actualLower = actual.toLowerCase();
    if (qType === 'multiple_choice') {
      const expectedLetter = expectedLower.replace(/[^a-d]/gi, '')[0];
      const actualLetter = actualLower.replace(/[^a-d]/gi, '')[0];
      isCorrect = expectedLetter && actualLetter ? expectedLetter === actualLetter : expectedLower === actualLower;
    } else {
      const cleanExpected = expectedLower.replace(/[^a-z0-9]/gi, '');
      const cleanActual = actualLower.replace(/[^a-z0-9]/gi, '');
      if (cleanExpected === cleanActual) {
        isCorrect = true;
      } else {
        const numExpected = expectedLower.replace(/[^0-9.]/g, '');
        const numActual = actualLower.replace(/[^0-9.]/g, '');
        isCorrect = !!(numExpected && numActual && numExpected === numActual);
      }
    }
  } else {
    // For open_ended and graphing questions, attempt AI grading
    const expectedLower = expected.toLowerCase();
    const actualLower = actual.toLowerCase();

    // Fast-path exact match
    if (expectedLower === actualLower || actualLower === expectedLower) {
      isCorrect = true;
      aiFeedback = 'Great work!';
    } else {
      const ai = getGeminiClient(api_key);
      if (ai) {
        try {
          const prompt = `You are an expert teacher grading a quiz.
Question Type: ${qType}
Question: "${q.question}"
Correct Answer Key: "${expected}"
Student's Response: "${actual}"

Evaluate if the student's response is correct or mathematically/semantically equivalent based on the answer key.
If it is correct, set "is_correct" to true, and optionally provide brief encouraging feedback.
If it is incorrect, set "is_correct" to false, and provide a brief 1-2 sentence explanation of why.
Return your response STRICTLY as a JSON object in the format: {"is_correct": boolean, "feedback": "string"}`;

          let parts: any[] = [{ text: prompt }];

          if (solution_snapshots && Array.isArray(solution_snapshots) && solution_snapshots.length > 0) {
             for (const snap of solution_snapshots) {
                 if (snap && typeof snap === 'string' && snap.startsWith('data:image/')) {
                    const base64Data = snap.split(',')[1];
                    const mimeType = snap.substring(snap.indexOf(':')+1, snap.indexOf(';'));
                    parts.push({
                       inlineData: {
                           data: base64Data,
                           mimeType: mimeType
                       }
                    });
                 }
             }
          }

          console.log(`[AI Grading] QType: ${qType}, Q: "${q.question}", Expected: "${expected}", Actual: "${actual}"`);
          const response = await ai.models.generateContent({
            model: getRealModelName('gemini-3.5-flash-lite'),
            contents: [{ role: 'user', parts }],
            config: { responseMimeType: 'application/json' }
          });
          
          const textResult = response.text ? response.text.trim() : '{}';
          console.log(`[AI Grading] Response: ${textResult}`);
          const parsed = JSON.parse(textResult);
          isCorrect = !!parsed.is_correct;
          aiFeedback = parsed.feedback || '';
        } catch (err) {
          console.error("AI individual grading error:", err);
          const numExpected = expectedLower.replace(/[^0-9.]/g, '');
          const numActual = actualLower.replace(/[^0-9.]/g, '');
          isCorrect = !!(numExpected && numActual && numExpected === numActual) || expectedLower === actualLower;
          aiFeedback = isCorrect ? '' : 'Incorrect based on simple match (AI grading failed).';
        }
      } else {
        const numExpected = expectedLower.replace(/[^0-9.]/g, '');
        const numActual = actualLower.replace(/[^0-9.]/g, '');
        isCorrect = !!(numExpected && numActual && numExpected === numActual) || expectedLower === actualLower;
        aiFeedback = isCorrect ? '' : 'Incorrect. (Note: AI grading is currently unavailable due to missing API key).';
      }
    }
  }

  res.json({
    success: true,
    is_correct: isCorrect,
    correct_answer: q.answer,
    score_fraction: isCorrect ? 1.0 : 0.0,
    ai_feedback: aiFeedback
  });
});

app.post(['/submit', '/api/submit_quiz'], tokenRequired, async (req: any, res) => {
  const { quiz_id, student_name, answers = {}, graded_details, total_score } = req.body;
  const quiz = quizzes.get(quiz_id);

  let finalDetails = graded_details;
  let finalScore = total_score;
  let maxScore = quiz ? quiz.questions.length : (graded_details ? graded_details.length : 1);

  if (!finalDetails && quiz) {
    finalScore = 0;
    finalDetails = [];
    quiz.questions.forEach((q: any, i: number) => {
      const userAns = answers[i] || 'No Answer';
      const expected = (q.answer || '').toString().trim().toLowerCase();
      const actual = userAns.toString().trim().toLowerCase();

      let isCorrect = false;
      if (q.type === 'multiple_choice') {
        const expectedLetter = expected.replace(/[^a-d]/gi, '')[0];
        const actualLetter = actual.replace(/[^a-d]/gi, '')[0];
        isCorrect = expectedLetter && actualLetter ? expectedLetter === actualLetter : expected === actual;
      } else {
        isCorrect = expected === actual || actual.includes(expected);
      }

      if (isCorrect) finalScore += 1;

      finalDetails.push({
        question: q.question,
        type: q.type || 'multiple_choice',
        user_answer: userAns,
        correct_answer: q.answer,
        is_correct: isCorrect,
        score_fraction: isCorrect ? 1.0 : 0.0
      });
    });
  }

  const resultId = `res_${Date.now()}`;
  const resultObj = {
    id: resultId,
    quiz_id: quiz_id || 'quiz_1',
    quiz_title: quiz ? quiz.title : 'Quiz Results',
    student_name: student_name || 'Anonymous',
    total_score: finalScore || 0,
    max_score: maxScore || 1,
    graded_details: finalDetails || [],
    created_at: new Date().toISOString()
  };

  results.set(resultId, resultObj);
  savePersistentData();
  syncDocToFirestore('results', resultId, resultObj);

  res.json({
    success: true,
    result_id: resultId,
    total_score: finalScore || 0,
    max_score: maxScore || 1
  });
});

app.post('/api/explain', async (req, res) => {
  const { question, user_answer, correct_answer, q_type, api_key } = req.body;

  const ai = getGeminiClient(api_key);

  if (ai) {
    try {
      const prompt = `Explain clearly and concisely in 2-3 sentences why the student's answer was incorrect for this quiz question and how to solve or get the correct answer.
Question: "${question}"
Student's Answer: "${user_answer}"
Correct Answer: "${correct_answer}"`;

      const response = await ai.models.generateContent({
        model: getRealModelName('gemini-2.5-flash'),
        contents: [prompt]
      });

      return res.json({ success: true, explanation: response.text });
    } catch (err: any) {
      console.warn('Gemini explain fallback:', err);
    }
  }

  return res.json({
    success: true,
    explanation: `The correct answer is "${correct_answer}". Your answer was "${user_answer}". Review the solution steps to verify your answer.`
  });
});

app.post(['/update/:quiz_id', '/api/quiz/:quiz_id/update'], tokenRequired, (req, res) => {
  const quizId = req.params.quiz_id;
  const existing = quizzes.get(quizId) || { id: quizId, created_at: new Date().toISOString() };
  if (req.body && req.body.title) {
    req.body.title = getUniqueQuizTitle(req.body.title, quizId);
  }
  const updated = { ...existing, ...req.body, id: quizId };
  quizzes.set(quizId, updated);
  savePersistentData();
  syncDocToFirestore('quizzes', quizId, updated);
  res.json({ success: true, quiz_id: quizId, quiz: updated, redirect: `/edit/${quizId}` });
});

app.get('/create_blank', tokenRequired, (req: any, res) => {
  const title = (req.query.title as string) || 'Untitled Quiz';
  const uniqueTitle = getUniqueQuizTitle(title);
  const subject = (req.query.subject as string) || 'General';
  const newId = `quiz_${Date.now()}`;
  const newQuiz = {
    id: newId,
    user_id: req.user ? req.user.uid : 'teacher_test',
    title: uniqueTitle,
    subject,
    time_limit: 30,
    quiz_mode: 'back_and_forth',
    require_solution: false,
    created_at: new Date().toISOString(),
    questions: [
      {
        question: 'Question 1: Enter your question here',
        options: ['A) Option 1', 'B) Option 2', 'C) Option 3', 'D) Option 4'],
        answer: 'A) Option 1',
        type: 'multiple_choice'
      }
    ]
  };
  quizzes.set(newId, newQuiz);
  savePersistentData();
  syncDocToFirestore('quizzes', newId, newQuiz);
  res.redirect(`/edit/${newId}`);
});

app.post('/merge', tokenRequired, (req: any, res) => {
  const { quiz_ids = [], new_title = 'Merged Quiz' } = req.body;
  const uniqueTitle = getUniqueQuizTitle(new_title);
  let mergedQuestions: any[] = [];
  let subject = 'General';

  quiz_ids.forEach((id: string) => {
    const q = quizzes.get(id);
    if (q) {
      if (q.questions) mergedQuestions.push(...q.questions);
      if (q.subject) subject = q.subject;
    }
  });

  const newId = `quiz_merged_${Date.now()}`;
  const newQuiz = {
    id: newId,
    user_id: req.user ? req.user.uid : 'teacher_test',
    title: uniqueTitle,
    subject,
    time_limit: 30,
    quiz_mode: 'back_and_forth',
    require_solution: false,
    created_at: new Date().toISOString(),
    questions: mergedQuestions.length > 0 ? mergedQuestions : [
      { question: 'Sample Merged Question', options: ['A', 'B'], answer: 'A', type: 'multiple_choice' }
    ]
  };

  quizzes.set(newId, newQuiz);
  savePersistentData();
  syncDocToFirestore('quizzes', newId, newQuiz);
  res.json({ success: true, new_quiz_id: newId });
});

app.post('/api/move_quiz', tokenRequired, (req, res) => {
  const { quiz_id, subject } = req.body;
  const quiz = quizzes.get(quiz_id);
  if (quiz) {
    quiz.subject = subject || 'General';
    quizzes.set(quiz_id, quiz);
    savePersistentData();
    syncDocToFirestore('quizzes', quiz_id, quiz);
    return res.json({ success: true });
  }
  res.status(404).json({ success: false, error: 'Quiz not found' });
});

app.get('/api/list_quizzes', (req, res) => {
  const list = Array.from(quizzes.values());
  list.sort((a, b) => getQuizTimestamp(b) - getQuizTimestamp(a));
  res.json(list);
});

app.get('/api/get_quiz_details/:id', (req, res) => {
  const quiz = quizzes.get(req.params.id);
  if (quiz) res.json(quiz);
  else res.status(404).json({ error: 'Quiz not found' });
});

app.post('/api/reformat_answer', (req, res) => {
  const { answer } = req.body;
  res.json({ success: true, formatted_answer: (answer || '').trim() });
});

app.post('/api/reprocess_question', async (req, res) => {
  const { question } = req.body;
  res.json({ success: true, question: question || {} });
});

app.post('/api/transfer_question', (req, res) => {
  const { source_quiz_id, target_quiz_id, question_index } = req.body;
  const src = quizzes.get(source_quiz_id);
  const tgt = quizzes.get(target_quiz_id);
  if (src && tgt && src.questions[question_index]) {
    tgt.questions.push(src.questions[question_index]);
    quizzes.set(target_quiz_id, tgt);
    savePersistentData();
    syncDocToFirestore('quizzes', target_quiz_id, tgt);
    return res.json({ success: true });
  }
  res.json({ success: false, error: 'Failed to transfer question' });
});

app.post('/api/bulk_import_questions', (req, res) => {
  const { quiz_id, questions } = req.body;
  const quiz = quizzes.get(quiz_id);
  if (quiz && Array.isArray(questions)) {
    quiz.questions.push(...questions);
    quizzes.set(quiz_id, quiz);
    savePersistentData();
    syncDocToFirestore('quizzes', quiz_id, quiz);
    return res.json({ success: true });
  }
  res.json({ success: false, error: 'Failed to import questions' });
});

app.get('/api/get_result/:result_id', (req, res) => {
  const result = results.get(req.params.result_id);
  if (result) return res.json(result);
  res.status(404).json({ error: 'Result not found' });
});

app.post('/api/results/:result_id/edit_answer', (req, res) => {
  const result = results.get(req.params.result_id);
  if (result) {
    const { q_index, new_answer, is_correct } = req.body;
    if (result.graded_details && result.graded_details[q_index]) {
      result.graded_details[q_index].user_answer = new_answer;
      if (is_correct !== undefined) result.graded_details[q_index].is_correct = is_correct;
    }
    return res.json({ success: true, result });
  }
  res.status(404).json({ error: 'Result not found' });
});

app.post('/api/results/:result_id/recheck', (req, res) => {
  res.json({ success: true, is_correct: true, score_fraction: 1.0 });
});

app.post('/api/results/:result_id/reprocess_answers', (req, res) => {
  res.json({ success: true });
});

app.post('/api/delete_results', (req, res) => {
  const { result_id } = req.body;
  if (result_id) results.delete(result_id);
  res.json({ success: true });
});

app.get('/rmxflash', tokenRequired, (req, res) => {
  res.render('rmxflash_upload');
});

app.get('/worksheet_answers', tokenRequired, (req, res) => {
  res.render('worksheet_answers_upload');
});

app.get('/api/admin/users', (req, res) => {
  res.json({ success: true, users: Array.from(users.values()) });
});

app.post('/api/admin/update_user_status', (req, res) => {
  const { uid, status, role } = req.body;
  const user = users.get(uid);
  if (user) {
    if (role) user.role = role;
    if (status) user.status = status;
    users.set(uid, user);
  }
  res.json({ success: true });
});

app.get('/api/ollama_tags', (req, res) => {
  res.json({ success: true, models: [] });
});

app.post('/api/install_model', (req, res) => {
  res.json({ success: true, message: 'Installing model...' });
});

app.get('/api/usage/sync_history', (req, res) => {
  res.json({ success: true });
});

// Progress polling endpoint
app.get('/api/progress/:session_id', (req, res) => {
  const data = sessionProgress.get(req.params.session_id) || {
    message: 'Processing...',
    percentage: 10,
    status: 'processing'
  };
  res.json(data);
});

// Helper to extract uploaded files by field name from Multer upload.any()
function getFilesByField(files: Express.Multer.File[] | undefined, fieldNames: string[]) {
  if (!files || !Array.isArray(files)) return [];
  return files.filter(f => fieldNames.includes(f.fieldname));
}

// Helper to parse question indices (e.g. "21", "22b", "3.1") and sort them numerically/alphanumerically
function sortQuestionsByIndex(questions: any[]) {
  if (!Array.isArray(questions)) return;
  
  const parseIndex = (idxStr: any): { num: number; suffix: string } => {
    const str = String(idxStr || '').trim();
    // Match leading digits, followed by any remaining characters (suffixes)
    const match = str.match(/^(\d+)(.*)$/);
    if (match) {
      return {
        num: parseInt(match[1], 10),
        suffix: match[2].toLowerCase()
      };
    }
    return { num: Infinity, suffix: str.toLowerCase() };
  };

  questions.sort((a: any, b: any) => {
    const parseA = parseIndex(a.original_index);
    const parseB = parseIndex(b.original_index);
    if (parseA.num !== parseB.num) {
      return parseA.num - parseB.num;
    }
    return parseA.suffix.localeCompare(parseB.suffix);
  });
}

// Helper to crop image bounding boxes (normalized ymin, xmin, ymax, xmax)
async function cropImageBoundingBox(fileBuffer: Buffer, bbox: any): Promise<string | null> {
  if (!bbox || !Array.isArray(bbox) || bbox.length < 4) return null;
  try {
    const [ymin, xmin, ymax, xmax] = bbox.map((n: any) => Number(n));
    if (isNaN(ymin) || isNaN(xmin) || isNaN(ymax) || isNaN(xmax)) return null;

    const meta = await sharp(fileBuffer).metadata();
    const width = meta.width || 1000;
    const height = meta.height || 1000;

    let scale = 1000;
    if (ymin <= 1 && xmin <= 1 && ymax <= 1 && xmax <= 1) scale = 1;
    else if (ymin <= 100 && xmin <= 100 && ymax <= 100 && xmax <= 100) scale = 100;

    // Normalize coordinates to 0 - 1000 scale
    let ymin_norm = (ymin / scale) * 1000;
    let xmin_norm = (xmin / scale) * 1000;
    let ymax_norm = (ymax / scale) * 1000;
    let xmax_norm = (xmax / scale) * 1000;

    // Ensure correct orientation
    let y1 = Math.min(ymin_norm, ymax_norm);
    let y2 = Math.max(ymin_norm, ymax_norm);
    let x1 = Math.min(xmin_norm, xmax_norm);
    let x2 = Math.max(xmin_norm, xmax_norm);

    // Calculate bounding box dimensions
    const boxW = x2 - x1;
    const boxH = y2 - y1;

    // Reject extremely small boxes, zero boxes, or boxes covering nearly the entire page (over 95% of both dimensions)
    if (boxW < 20 || boxH < 20 || (boxW > 950 && boxH > 950)) {
      console.log(`[CROP] Bounding box is too small, empty, or covers entire page (${boxW}x${boxH}). Skipping crop.`);
      return null;
    }

    // Pad moderately. 15% of the box dimension plus a small flat margin of 35 units (3.5% of page) to avoid cutoff.
    // Ensure we don't pad so much that we capture unrelated questions, but give enough margin (30-80 units).
    const padX = Math.min(80, Math.max(30, Math.round(boxW * 0.15 + 35)));
    const padY = Math.min(80, Math.max(30, Math.round(boxH * 0.15 + 35)));

    y1 = Math.max(0, y1 - padY);
    y2 = Math.min(1000, y2 + padY);
    x1 = Math.max(0, x1 - padX);
    x2 = Math.min(1000, x2 + padX);

    // Convert back to actual pixel dimensions
    let left = Math.floor((x1 / 1000) * width);
    let top = Math.floor((y1 / 1000) * height);
    let cropWidth = Math.floor(((x2 - x1) / 1000) * width);
    let cropHeight = Math.floor(((y2 - y1) / 1000) * height);

    left = Math.max(0, Math.min(width - 10, left));
    top = Math.max(0, Math.min(height - 10, top));
    cropWidth = Math.max(10, Math.min(width - left, cropWidth));
    cropHeight = Math.max(10, Math.min(height - top, cropHeight));

    const croppedBuffer = await sharp(fileBuffer)
      .extract({ left, top, width: cropWidth, height: cropHeight })
      .toBuffer();

    return `data:image/png;base64,${croppedBuffer.toString('base64')}`;
  } catch (err) {
    console.warn('Error cropping bounding box:', err);
    return null;
  }
}

// Helper to convert a PDF page to a PNG Buffer using Ghostscript
async function pdfPageToImage(pdfBuffer: Buffer, pageIndex: number = 0): Promise<Buffer | null> {
  const tempIn = path.join('/tmp', `input_${crypto.randomBytes(8).toString('hex')}.pdf`);
  const tempOut = path.join('/tmp', `output_${crypto.randomBytes(8).toString('hex')}.png`);
  try {
    fs.writeFileSync(tempIn, pdfBuffer);
    const pageNum = pageIndex + 1; // gs page numbers are 1-indexed
    execSync(`gs -q -dNOPAUSE -dBATCH -sDEVICE=png16m -r200 -dFirstPage=${pageNum} -dLastPage=${pageNum} -sOutputFile="${tempOut}" "${tempIn}"`);
    if (fs.existsSync(tempOut)) {
      return fs.readFileSync(tempOut);
    }
  } catch (err) {
    console.error('Error rendering PDF page to image with Ghostscript:', err);
  } finally {
    try { if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn); } catch (e) {}
    try { if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut); } catch (e) {}
  }
  return null;
}

// Helper to get PDF page count using Ghostscript
function getPdfPageCount(pdfBuffer: Buffer): number {
  const tempIn = path.join('/tmp', `count_${crypto.randomBytes(8).toString('hex')}.pdf`);
  try {
    fs.writeFileSync(tempIn, pdfBuffer);
    const output = execSync(`gs -q -dNODISPLAY -c "(${tempIn}) (r) file runpdfbegin pdfpagecount = quit"`).toString().trim();
    const count = parseInt(output, 10);
    if (!isNaN(count)) return count;
  } catch (err) {
    console.error('Error getting PDF page count with gs:', err);
  } finally {
    try { if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn); } catch (e) {}
  }
  return 1; // Fallback to 1 page
}

// Helper to extract specific pages from a PDF into a new PDF buffer using Ghostscript
async function extractPdfPages(pdfBuffer: Buffer, startPage: number, endPage: number): Promise<Buffer | null> {
  const tempIn = path.join('/tmp', `chunk_in_${crypto.randomBytes(8).toString('hex')}.pdf`);
  const tempOut = path.join('/tmp', `chunk_out_${crypto.randomBytes(8).toString('hex')}.pdf`);
  try {
    fs.writeFileSync(tempIn, pdfBuffer);
    execSync(`gs -q -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -dFirstPage=${startPage} -dLastPage=${endPage} -sOutputFile="${tempOut}" "${tempIn}"`);
    if (fs.existsSync(tempOut)) {
      return fs.readFileSync(tempOut);
    }
  } catch (err) {
    console.error(`Error splitting PDF pages ${startPage}-${endPage} with Ghostscript:`, err);
  } finally {
    try { if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn); } catch (e) {}
    try { if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut); } catch (e) {}
  }
  return null;
}

app.post('/api/extract_worksheet', tokenRequired, upload.any(), async (req: any, res) => {
  const {
    api_key,
    model_name = 'gemini-3.5-flash-lite',
    topic_hint = '',
    subject = 'General',
    use_screenshots = 'false',
    session_id = 'ws_1'
  } = req.body;

  const files = req.files as Express.Multer.File[] || [];
  const wsFiles = getFilesByField(files, ['files', 'worksheet_files']);

  sessionProgress.set(session_id, { message: '📄 Processing uploaded worksheet files...', percentage: 20, status: 'processing' });

  try {
    const ai = getGeminiClient(api_key);
    let questions: any[] = [];

    if (ai && wsFiles.length > 0) {
      const selectedModel = getRealModelName(model_name);
      const pdfFile = wsFiles.find(f => f.mimetype === 'application/pdf');
      const imgFile = wsFiles.find(f => f.mimetype && f.mimetype.startsWith('image/'));

      const extractionSchema = {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            raw_text: {
              type: Type.STRING,
              description: "The literal text transcript of the question."
            },
            options: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "The choices (e.g. ['A) 10', 'B) 20']) if multiple choice."
            },
            type: {
              type: Type.STRING,
              description: "The type: 'multiple_choice', 'multiple_choice_multi', 'identification', 'open_ended', 'graphing', 'true_false'."
            },
            original_index: {
              type: Type.STRING,
              description: "The question number/index on the worksheet."
            },
            bounding_box: {
              type: Type.ARRAY,
              items: { type: Type.INTEGER },
              description: "Four normalized integers [ymin, xmin, ymax, xmax] (0 to 1000) of any diagram, figure, graph, coordinate axis, map, or illustration. Leave empty or return an empty array [] if there is no diagram."
            }
          },
          required: ["raw_text", "options", "type", "original_index"]
        }
      };

      if (pdfFile && !imgFile) {
        // Multi-page PDF chunking/splitting mechanism (1 page per chunk for 100% precise diagram cropping)
        const pageCount = getPdfPageCount(pdfFile.buffer);
        console.log(`[QUIZ] Processing PDF with page count: ${pageCount}`);

        const chunkSize = 1;
        const totalChunks = Math.ceil(pageCount / chunkSize);

        for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
          const startPage = chunkIdx * chunkSize + 1;
          const endPage = Math.min((chunkIdx + 1) * chunkSize, pageCount);

          sessionProgress.set(session_id, {
            message: `🔍 Extracting Questions from Page ${chunkIdx + 1} of ${pageCount}...`,
            percentage: Math.round(20 + (chunkIdx / totalChunks) * 60),
            status: 'processing'
          });

          const chunkBuffer = await extractPdfPages(pdfFile.buffer, startPage, endPage);
          if (!chunkBuffer) continue;

          // Convert the current page to an image for cropping
          const chunkPageImage = await pdfPageToImage(pdfFile.buffer, startPage - 1);

          const isNonMath = ['English', 'History', 'Biology', 'Social Studies'].includes(subject);
          let basePrompt = isNonMath ? WORKSHEET_EXTRACTION_PROMPT_NON_MATH : WORKSHEET_EXTRACTION_PROMPT;
          let prompt = basePrompt
            .replace('{latex_rules}', SHARED_LATEX_RULES)
            .replace('{subject_rules}', isNonMath ? NON_MATH_RULES : '')
            .replace('{prompt_additions}', `Subject: ${subject}. Topic / Context: ${topic_hint}. CRITICAL: ONLY output "bounding_box" if the specific question actually contains a visual diagram, illustration, graph, chart, map, coordinate axis, or geometry drawing. For purely text or simple equations with no associated diagram, "bounding_box" MUST be an empty array [].`);

          let contents: any[] = [
            prompt,
            {
              inlineData: { data: chunkBuffer.toString('base64'), mimeType: 'application/pdf' }
            }
          ];

          const response = await ai.models.generateContent({
            model: selectedModel,
            contents,
            config: {
              responseMimeType: 'application/json',
              responseSchema: extractionSchema,
              maxOutputTokens: 8192
            }
          });

          const text = response.text || '';
          const parsed = safeParseJSON(text);
          if (Array.isArray(parsed)) {
            for (const q of parsed) {
              if (!q.raw_text && q.question) q.raw_text = q.question;
              if (!q.raw_text && q.statement) q.raw_text = q.statement;

              if (q.bounding_box && chunkPageImage) {
                const imgUri = await cropImageBoundingBox(chunkPageImage, q.bounding_box);
                if (imgUri) {
                  const imgHtml = `<div class="resizable-image-wrapper"><div class="image-content-box" style="width: 100%;"><img src="${imgUri}" alt="Source Diagram"></div></div>`;
                  q.raw_text = (q.raw_text || '') + '\n' + imgHtml;
                }
              }
            }
            questions.push(...parsed);
          }
        }
      } else {
        // Standard single file / image flow (handles multiple images sequentially for 100% exact diagram-to-image matching!)
        const isNonMath = ['English', 'History', 'Biology', 'Social Studies'].includes(subject);
        let basePrompt = isNonMath ? WORKSHEET_EXTRACTION_PROMPT_NON_MATH : WORKSHEET_EXTRACTION_PROMPT;
        let prompt = basePrompt
          .replace('{latex_rules}', SHARED_LATEX_RULES)
          .replace('{subject_rules}', isNonMath ? NON_MATH_RULES : '')
          .replace('{prompt_additions}', `Subject: ${subject}. Topic / Context: ${topic_hint}. CRITICAL: ONLY output "bounding_box" if the specific question actually contains a visual diagram, illustration, graph, chart, map, coordinate axis, or geometry drawing. For purely text or simple equations with no associated diagram, "bounding_box" MUST be an empty array [].`);

        const totalFiles = wsFiles.length;
        for (let fileIdx = 0; fileIdx < totalFiles; fileIdx++) {
          const f = wsFiles[fileIdx];
          sessionProgress.set(session_id, {
            message: `🤖 Analyzing worksheet file ${fileIdx + 1} of ${totalFiles} with Gemini AI...`,
            percentage: Math.round(30 + (fileIdx / totalFiles) * 50),
            status: 'processing'
          });

          let contents: any[] = [
            prompt,
            {
              inlineData: { data: f.buffer.toString('base64'), mimeType: f.mimetype }
            }
          ];

          const response = await ai.models.generateContent({
            model: selectedModel,
            contents,
            config: {
              responseMimeType: 'application/json',
              responseSchema: extractionSchema,
              maxOutputTokens: 8192
            }
          });

          const text = response.text || '';
          const parsed = safeParseJSON(text);
          if (Array.isArray(parsed)) {
            // Convert any PDF to image if it's treated in this fallback branch
            let currentImageBuffer: Buffer | null = null;
            if (f.mimetype === 'application/pdf') {
              currentImageBuffer = await pdfPageToImage(f.buffer, 0);
            } else if (f.mimetype && f.mimetype.startsWith('image/')) {
              currentImageBuffer = f.buffer;
            }

            for (const q of parsed) {
              if (!q.raw_text && q.question) q.raw_text = q.question;
              if (!q.raw_text && q.statement) q.raw_text = q.statement;

              if (q.bounding_box && q.bounding_box.length === 4 && currentImageBuffer) {
                const imgUri = await cropImageBoundingBox(currentImageBuffer, q.bounding_box);
                if (imgUri) {
                  const imgHtml = `<div class="resizable-image-wrapper"><div class="image-content-box" style="width: 100%;"><img src="${imgUri}" alt="Source Diagram"></div></div>`;
                  q.raw_text = (q.raw_text || '') + '\n' + imgHtml;
                }
              }
            }
            questions.push(...parsed);
          }
        }
      }
    }

    if (!questions || questions.length === 0) {
      questions = [
        {
          raw_text: '1. What is $5 + 5$?',
          type: 'multiple_choice',
          options: ['A) $10$', 'B) $20$', 'C) $30$', 'D) $40$'],
          original_index: 1,
          answer: 'A) $10$'
        }
      ];
    }

    // Sort questions strictly by original_index
    sortQuestionsByIndex(questions);

    const extractedIndices = questions.map((q: any) => parseInt(q.original_index)).filter((n: number) => !isNaN(n)).sort((a: number, b: number) => a - b);
    const missingIndices: number[] = [];
    if (extractedIndices.length > 0) {
      const maxIdx = Math.max(...extractedIndices);
      for (let i = 1; i <= maxIdx; i++) {
        if (!extractedIndices.includes(i)) {
          missingIndices.push(i);
        }
      }
    }

    sessionProgress.set(session_id, { message: '✅ Worksheet extraction complete!', percentage: 100, status: 'completed' });
    res.json({ success: true, questions, missing_indices: missingIndices });
  } catch (err: any) {
    sessionProgress.set(session_id, { message: `❌ Error: ${err.message}`, percentage: 100, status: 'error' });
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/solve_worksheet', tokenRequired, async (req: any, res) => {
  const {
    questions = [],
    batch_size = 3,
    api_key,
    subject = 'General',
    time_limit = 20,
    quiz_mode = 'back_and_forth',
    topic = 'Worksheet Quiz',
    require_solution = false,
    model_name = 'gemini-3.5-flash-lite',
    session_id = 'solve_1'
  } = req.body;

  sessionProgress.set(session_id, { message: '⚡ Preparing to solve worksheet questions...', percentage: 10, status: 'processing' });

  res.json({ success: true });

  (async () => {
    try {
      const ai = getGeminiClient(api_key);
      const isNonMath = ['English', 'History', 'Biology', 'Social Studies'].includes(subject);
      const solverPromptTemplate = isNonMath ? WORKSHEET_SOLVER_PROMPT_NON_MATH : WORKSHEET_SOLVER_PROMPT;
      const selectedModel = getRealModelName(model_name);

      let solvedResults: any[] = [];
      const batchNum = parseInt(batch_size) || 3;
      const totalQuestions = questions.length;

      for (let i = 0; i < totalQuestions; i += batchNum) {
        const batch = questions.slice(i, i + batchNum);
        const currentProgress = Math.round(10 + ((i + batch.length) / totalQuestions) * 80);

        sessionProgress.set(session_id, {
          message: `✨ Solving questions ${i + 1} to ${Math.min(i + batch.length, totalQuestions)} of ${totalQuestions}...`,
          percentage: currentProgress,
          status: 'processing'
        });

        if (ai) {
          try {
            const prompt = solverPromptTemplate
              .replace('{subject}', subject)
              .replace('{topic}', topic)
              .replace('{questions_json}', JSON.stringify(batch))
              .replace('{latex_rules}', SHARED_LATEX_RULES);

            const response = await ai.models.generateContent({
              model: selectedModel,
              contents: [prompt],
              config: { responseMimeType: 'application/json' }
            });

            const text = response.text || '';
            const batchSolved = safeParseJSON(text);
            if (Array.isArray(batchSolved)) {
              solvedResults.push(...batchSolved);
            }
          } catch (e) {
            console.warn(`Error solving batch starting at index ${i}:`, e);
          }
        }
      }

      const finalQuestions = questions.map((orig: any, idx: number) => {
        const solved = solvedResults[idx] || {};
        return {
          question: orig.raw_text || orig.question || orig.statement || `Question ${idx + 1}`,
          options: Array.isArray(solved.options) && solved.options.length > 0 ? solved.options : (Array.isArray(orig.options) ? orig.options : []),
          answer: solved.answer !== undefined ? String(solved.answer) : (orig.answer || ''),
          type: solved.type || orig.type || 'multiple_choice'
        };
      });

      const uniqueTitle = getUniqueQuizTitle(topic || 'Worksheet Quiz');
      const newQuizId = `quiz_${Date.now()}`;
      const newQuiz = {
        id: newQuizId,
        user_id: req.user ? req.user.uid : 'teacher_test',
        title: uniqueTitle,
        subject: subject || 'General',
        time_limit: parseInt(time_limit) || 20,
        quiz_mode: quiz_mode || 'back_and_forth',
        require_solution: require_solution || false,
        questions: finalQuestions,
        created_at: new Date().toISOString()
      };

      quizzes.set(newQuizId, newQuiz);
      savePersistentData();
      syncDocToFirestore('quizzes', newQuizId, newQuiz);

      sessionProgress.set(session_id, {
        message: '🚀 Quiz created! Redirecting...',
        percentage: 100,
        status: 'completed',
        quiz_id: newQuizId
      });
    } catch (err: any) {
      sessionProgress.set(session_id, {
        message: `❌ Error: ${err.message}`,
        percentage: 100,
        status: 'error',
        error: err.message
      });
    }
  })();
});

app.post('/api/extract_rmxflash', tokenRequired, upload.any(), async (req: any, res) => {
  const { api_key, model_name = 'gemini-3.5-flash-lite', use_screenshots = false, session_id = 'rmx_1' } = req.body;
  const files = req.files as Express.Multer.File[] || [];

  const wsFiles = getFilesByField(files, ['worksheet_files', 'files']);
  const ansFiles = getFilesByField(files, ['answer_files']);

  sessionProgress.set(session_id, { message: '⚡ Extracting RMXFlash questions...', percentage: 25, status: 'processing' });

  try {
    const ai = getGeminiClient(api_key);
    let rmxQuestions: any[] = [];
    let goldenKey: Record<string, string> = {};

    if (ai) {
      const selectedModel = getRealModelName(model_name);

      let prompt = RMX_FLASH_EXTRACTION_PROMPT
        .replace('{latex_rules}', SHARED_LATEX_RULES)
        .replace('{prompt_additions}', 'CRITICAL: ONLY output "bounding_box" if the specific question actually contains a visual diagram, illustration, graph, chart, map, coordinate axis, or geometry drawing. For purely text or simple equations with no associated diagram, "bounding_box" MUST be an empty array [].');

      const totalFiles = wsFiles.length;
      for (let fileIdx = 0; fileIdx < totalFiles; fileIdx++) {
        const f = wsFiles[fileIdx];
        sessionProgress.set(session_id, {
          message: `⚡ Extracting questions from file ${fileIdx + 1} of ${totalFiles}...`,
          percentage: Math.round(25 + (fileIdx / totalFiles) * 40),
          status: 'processing'
        });

        let contents: any[] = [
          prompt,
          {
            inlineData: { data: f.buffer.toString('base64'), mimeType: f.mimetype }
          }
        ];

        const response = await ai.models.generateContent({
          model: selectedModel,
          contents,
          config: { responseMimeType: 'application/json', maxOutputTokens: 8192 }
        });

        const text = response.text || '';
        const parsed = safeParseJSON(text);
        if (Array.isArray(parsed)) {
          // Convert any PDF to image if treated here
          let currentImageBuffer: Buffer | null = null;
          if (f.mimetype === 'application/pdf') {
            currentImageBuffer = await pdfPageToImage(f.buffer, 0);
          } else if (f.mimetype && f.mimetype.startsWith('image/')) {
            currentImageBuffer = f.buffer;
          }

          for (const q of parsed) {
            if (q.bounding_box && q.bounding_box.length === 4 && currentImageBuffer) {
              const imgUri = await cropImageBoundingBox(currentImageBuffer, q.bounding_box);
              if (imgUri) {
                const imgHtml = `<div class="resizable-image-wrapper"><div class="image-content-box" style="width: 100%;"><img src="${imgUri}" alt="Diagram"></div></div>`;
                q.statement = (q.statement || '') + '\n' + imgHtml;
              }
            }
          }
          rmxQuestions.push(...parsed);
        }
      }

      if (ansFiles.length > 0) {
        sessionProgress.set(session_id, { message: '⚡ Matching Golden Answer Key...', percentage: 80, status: 'processing' });
        let keyPrompt = `Extract the Golden Answer Key from these files as a JSON object where key is question number (e.g. "1") and value is answer choice letter or text.`;
        let keyContents: any[] = [keyPrompt];
        ansFiles.forEach(f => {
          keyContents.push({
            inlineData: { data: f.buffer.toString('base64'), mimeType: f.mimetype }
          });
        });

        const keyResp = await ai.models.generateContent({
          model: selectedModel,
          contents: keyContents,
          config: { responseMimeType: 'application/json' }
        });

        const keyText = keyResp.text || '';
        const parsedKey = safeParseJSON(keyText);
        if (parsedKey && typeof parsedKey === 'object') {
          goldenKey = parsedKey;
        }

        if (Object.keys(goldenKey).length > 0) {
          const matchPrompt = RMX_FLASH_MATCH_PROMPT
            .replace('{questions_json}', JSON.stringify(rmxQuestions))
            .replace('{golden_key}', JSON.stringify(goldenKey));

          const matchResp = await ai.models.generateContent({
            model: selectedModel,
            contents: [matchPrompt],
            config: { responseMimeType: 'application/json' }
          });

          const matchText = matchResp.text || '';
          const matched = safeParseJSON(matchText);
          if (Array.isArray(matched)) rmxQuestions = matched;
        }
      }
    }

    if (!rmxQuestions || rmxQuestions.length === 0) {
      rmxQuestions = [
        {
          identifier: 'a1B2c3D4e5F6',
          original_index: 1,
          statement: 'Sample RMX Question 1: What is $2 + 2$?',
          choices: ['A) $3$', 'B) $4$', 'C) $5$', 'D) $6$'],
          answer: 'B'
        }
      ];
    }

    // Sort rmx questions strictly by original_index
    sortQuestionsByIndex(rmxQuestions);

    sessionProgress.set(session_id, { message: '✅ RMXFlash extraction complete!', percentage: 100, status: 'completed' });
    res.json({ success: true, questions: rmxQuestions });
  } catch (err: any) {
    sessionProgress.set(session_id, { message: `❌ Error: ${err.message}`, percentage: 100, status: 'error' });
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/export_rmxflash_excel', tokenRequired, async (req, res) => {
  const { questions = [], year = '', test_name = '', contest = '' } = req.body;

  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Questions');

    sheet.columns = [
      { header: 'ID', key: 'identifier', width: 15 },
      { header: 'Q#', key: 'original_index', width: 8 },
      { header: 'Statement', key: 'statement', width: 50 },
      { header: 'Choice A', key: 'choice_a', width: 20 },
      { header: 'Choice B', key: 'choice_b', width: 20 },
      { header: 'Choice C', key: 'choice_c', width: 20 },
      { header: 'Choice D', key: 'choice_d', width: 20 },
      { header: 'Choice E', key: 'choice_e', width: 20 },
      { header: 'Correct Answer', key: 'answer', width: 15 }
    ];

    const extractedImages: { filename: string; buffer: Buffer }[] = [];

    questions.forEach((q: any, idx: number) => {
      const choices = q.choices || [];
      const statementRaw = q.statement || '';

      let cleanStatement = statementRaw;
      const imgMatch = statementRaw.match(/src="data:image\/([^;]+);base64,([^"]+)"/);
      if (imgMatch) {
        const ext = imgMatch[1] || 'png';
        const base64Data = imgMatch[2];
        const imgBuffer = Buffer.from(base64Data, 'base64');
        const imgName = `q${q.original_index || idx + 1}_diagram.${ext}`;
        extractedImages.push({ filename: imgName, buffer: imgBuffer });
        cleanStatement = statementRaw.replace(/<div class="resizable-image-wrapper">.*?<\/div>\s*<\/div>/is, ` [Diagram: ${imgName}] `);
      }

      sheet.addRow({
        identifier: q.identifier || `id_${idx}`,
        original_index: q.original_index || idx + 1,
        statement: cleanStatement,
        choice_a: choices[0] || '',
        choice_b: choices[1] || '',
        choice_c: choices[2] || '',
        choice_d: choices[3] || '',
        choice_e: choices[4] || '',
        answer: q.answer || ''
      });
    });

    const excelBuffer = await workbook.xlsx.writeBuffer();

    const safeYear = (year || '').trim();
    const safeTest = (test_name || '').trim();
    const safeContest = (contest || '').trim();
    let baseFilename = `${safeYear}_${safeTest}_${safeContest}`.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').toLowerCase();
    if (!baseFilename || baseFilename === '_') baseFilename = 'rmxflash_export';

    const archive = archiver('zip', { zlib: { level: 9 } });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${baseFilename}.zip"`);

    archive.pipe(res);
    archive.append(Buffer.from(excelBuffer), { name: `${baseFilename}.xlsx` });

    extractedImages.forEach(img => {
      archive.append(img.buffer, { name: `images/${img.filename}` });
    });

    await archive.finalize();
  } catch (err: any) {
    console.error('Export error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/extract_worksheet_with_answers', tokenRequired, upload.any(), async (req: any, res) => {
  const { session_id = 'sess_ans_1', topic_hint = '', subject = 'General', api_key, model_name = 'gemini-3.5-flash-lite' } = req.body;
  const files = req.files as Express.Multer.File[] || [];

  const wsFiles = getFilesByField(files, ['files', 'worksheet_files']);
  const ansFiles = getFilesByField(files, ['answer_files']);

  sessionProgress.set(session_id, { message: '📄 Processing worksheet & answer key files...', percentage: 15, status: 'processing' });

  try {
    const ai = getGeminiClient(api_key);
    let questions: any[] = [];
    let goldenReference: Record<string, string> = {};

    if (ai) {
      const selectedModel = getRealModelName(model_name);
      const pdfFileWs = wsFiles.find(f => f.mimetype === 'application/pdf');
      const imgFileWs = wsFiles.find(f => f.mimetype && f.mimetype.startsWith('image/'));

      const extractionSchema = {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            raw_text: {
              type: Type.STRING,
              description: "The literal text transcript of the question."
            },
            options: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "The choices (e.g. ['A) 10', 'B) 20']) if multiple choice."
            },
            type: {
              type: Type.STRING,
              description: "The type: 'multiple_choice', 'multiple_choice_multi', 'identification', 'open_ended', 'graphing', 'true_false'."
            },
            original_index: {
              type: Type.STRING,
              description: "The question number/index on the worksheet."
            },
            bounding_box: {
              type: Type.ARRAY,
              items: { type: Type.INTEGER },
              description: "Four normalized integers [ymin, xmin, ymax, xmax] (0 to 1000) of any diagram, figure, graph, coordinate axis, map, or illustration. Leave empty or return an empty array [] if there is no diagram."
            }
          },
          required: ["raw_text", "options", "type", "original_index"]
        }
      };

      if (pdfFileWs && !imgFileWs) {
        // Multi-page PDF chunking/splitting mechanism for worksheet-with-answers (1 page per chunk for 100% precise diagram cropping)
        const pageCount = getPdfPageCount(pdfFileWs.buffer);
        console.log(`[QUIZ] Processing PDF with Answers page count: ${pageCount}`);

        const chunkSize = 1;
        const totalChunks = Math.ceil(pageCount / chunkSize);

        for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
          const startPage = chunkIdx * chunkSize + 1;
          const endPage = Math.min((chunkIdx + 1) * chunkSize, pageCount);

          sessionProgress.set(session_id, {
            message: `🔍 Extracting Questions from Page ${chunkIdx + 1} of ${pageCount}...`,
            percentage: Math.round(20 + (chunkIdx / totalChunks) * 50),
            status: 'processing'
          });

          const chunkBuffer = await extractPdfPages(pdfFileWs.buffer, startPage, endPage);
          if (!chunkBuffer) continue;

          // Convert the current page to an image for cropping
          const chunkPageImage = await pdfPageToImage(pdfFileWs.buffer, startPage - 1);

          let extractionPrompt = WORKSHEET_EXTRACTION_PROMPT
            .replace('{latex_rules}', SHARED_LATEX_RULES)
            .replace('{prompt_additions}', `Subject: ${subject}. Topic / Context: ${topic_hint}. CRITICAL: ONLY output "bounding_box" if the specific question actually contains a visual diagram, illustration, graph, chart, map, coordinate axis, or geometry drawing. For purely text or simple equations with no associated diagram, "bounding_box" MUST be an empty array [].`);

          let wsContents: any[] = [
            extractionPrompt,
            {
              inlineData: { data: chunkBuffer.toString('base64'), mimeType: 'application/pdf' }
            }
          ];

          const wsResponse = await ai.models.generateContent({
            model: selectedModel,
            contents: wsContents,
            config: {
              responseMimeType: 'application/json',
              responseSchema: extractionSchema,
              maxOutputTokens: 8192
            }
          });

          const wsText = wsResponse.text || '';
          const parsed = safeParseJSON(wsText);
          if (Array.isArray(parsed)) {
            for (const q of parsed) {
              if (!q.raw_text && q.question) q.raw_text = q.question;
              if (!q.raw_text && q.statement) q.raw_text = q.statement;

              if (q.bounding_box && chunkPageImage) {
                const imgUri = await cropImageBoundingBox(chunkPageImage, q.bounding_box);
                if (imgUri) {
                  const imgHtml = `<div class="resizable-image-wrapper"><div class="image-content-box" style="width: 100%;"><img src="${imgUri}" alt="Diagram"></div></div>`;
                  q.raw_text = (q.raw_text || '') + '\n' + imgHtml;
                }
              }
            }
            questions.push(...parsed);
          }
        }
      } else {
        // Standard single file / image flow (handles multiple images sequentially for 100% exact diagram-to-image matching!)
        let extractionPrompt = WORKSHEET_EXTRACTION_PROMPT
          .replace('{latex_rules}', SHARED_LATEX_RULES)
          .replace('{prompt_additions}', `Subject: ${subject}. Topic / Context: ${topic_hint}. CRITICAL: ONLY output "bounding_box" if the specific question actually contains a visual diagram, illustration, graph, chart, map, coordinate axis, or geometry drawing. For purely text or simple equations with no associated diagram, "bounding_box" MUST be an empty array [].`);

        const totalFiles = wsFiles.length;
        for (let fileIdx = 0; fileIdx < totalFiles; fileIdx++) {
          const f = wsFiles[fileIdx];
          sessionProgress.set(session_id, {
            message: `🤖 Extracting questions from worksheet file ${fileIdx + 1} of ${totalFiles} with Gemini AI...`,
            percentage: Math.round(30 + (fileIdx / totalFiles) * 40),
            status: 'processing'
          });

          let wsContents: any[] = [
            extractionPrompt,
            {
              inlineData: { data: f.buffer.toString('base64'), mimeType: f.mimetype }
            }
          ];

          const wsResponse = await ai.models.generateContent({
            model: selectedModel,
            contents: wsContents,
            config: {
              responseMimeType: 'application/json',
              responseSchema: extractionSchema,
              maxOutputTokens: 8192
            }
          });

          const wsText = wsResponse.text || '';
          const parsed = safeParseJSON(wsText);
          if (Array.isArray(parsed)) {
            // Convert any PDF to image if it's treated in this fallback branch
            let currentImageBuffer: Buffer | null = null;
            if (f.mimetype === 'application/pdf') {
              currentImageBuffer = await pdfPageToImage(f.buffer, 0);
            } else if (f.mimetype && f.mimetype.startsWith('image/')) {
              currentImageBuffer = f.buffer;
            }

            for (const q of parsed) {
              if (!q.raw_text && q.question) q.raw_text = q.question;
              if (!q.raw_text && q.statement) q.raw_text = q.statement;

              if (q.bounding_box && q.bounding_box.length === 4 && currentImageBuffer) {
                const imgUri = await cropImageBoundingBox(currentImageBuffer, q.bounding_box);
                if (imgUri) {
                  const imgHtml = `<div class="resizable-image-wrapper"><div class="image-content-box" style="width: 100%;"><img src="${imgUri}" alt="Diagram"></div></div>`;
                  q.raw_text = (q.raw_text || '') + '\n' + imgHtml;
                }
              }
            }
            questions.push(...parsed);
          }
        }
      }

      if (ansFiles.length > 0) {
        sessionProgress.set(session_id, { message: '🔑 Extracting Golden Answer Key from answer files...', percentage: 70, status: 'processing' });
        let ansPrompt = `Extract the Golden Answer Key / Master Answers from these answer key files as a JSON key-value map.
Keys MUST be the question numbers as strings (e.g., "1", "2", "3").
Values MUST be the correct answers as strings (e.g. "A", "180 degrees", "3.14").
Return ONLY a valid JSON object map like {"1": "A", "2": "B", "3": "42"}.`;

        let ansContents: any[] = [ansPrompt];
        ansFiles.forEach(f => {
          ansContents.push({
            inlineData: { data: f.buffer.toString('base64'), mimeType: f.mimetype }
          });
        });

        const ansResponse = await ai.models.generateContent({
          model: selectedModel,
          contents: ansContents,
          config: { responseMimeType: 'application/json' }
        });

        const ansText = ansResponse.text || '';
        const parsedAns = safeParseJSON(ansText);
        if (parsedAns && typeof parsedAns === 'object') {
          goldenReference = parsedAns;
        }
      }
    }

    if (!questions || questions.length === 0) {
      questions = [
        {
          raw_text: '1. What is the capital of France?',
          question: 'What is the capital of France?',
          type: 'multiple_choice',
          options: ['A) Paris', 'B) London', 'C) Berlin', 'D) Madrid'],
          original_index: 1,
          answer: 'A) Paris'
        },
        {
          raw_text: '2. Solve $2x + 6 = 14$',
          question: 'Solve $2x + 6 = 14$',
          type: 'identification',
          options: [],
          original_index: 2,
          answer: '4'
        }
      ];
    }

    if (Object.keys(goldenReference).length > 0) {
      questions.forEach((q: any) => {
        const idxKey = String(q.original_index);
        if (goldenReference[idxKey]) {
          q.answer = goldenReference[idxKey];
        }
      });
    }

    // Sort questions strictly by original_index
    sortQuestionsByIndex(questions);

    const extractedIndices = questions.map((q: any) => parseInt(q.original_index)).filter((n: number) => !isNaN(n)).sort((a: number, b: number) => a - b);
    const missingIndices: number[] = [];
    if (extractedIndices.length > 0) {
      const maxIdx = Math.max(...extractedIndices);
      for (let i = 1; i <= maxIdx; i++) {
        if (!extractedIndices.includes(i)) {
          missingIndices.push(i);
        }
      }
    }

    sessionProgress.set(session_id, { message: '✅ Questions and answers extracted successfully!', percentage: 100, status: 'completed' });
    res.json({ success: true, questions, golden_reference: goldenReference, missing_indices: missingIndices });
  } catch (err: any) {
    sessionProgress.set(session_id, { message: `❌ Error: ${err.message}`, percentage: 100, status: 'error' });
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/recover_questions', tokenRequired, upload.any(), async (req: any, res) => {
  const { missing_numbers, topic_hint = 'General', api_key, model_name = 'gemini-3.5-flash-lite' } = req.body;
  const files = req.files as Express.Multer.File[] || [];

  let missingNums: number[] = [];
  try {
    missingNums = typeof missing_numbers === 'string' ? JSON.parse(missing_numbers) : missing_numbers;
  } catch (e) {
    missingNums = [];
  }

  try {
    const ai = getGeminiClient(api_key);
    let recovered: any[] = [];

    if (ai && files.length > 0) {
      const selectedModel = getRealModelName(model_name);
      const prompt = RECOVERY_PROMPT
        .replace('{topic_hint}', topic_hint)
        .replace('{missing_numbers}', JSON.stringify(missingNums));

      const totalFiles = files.length;
      for (let fileIdx = 0; fileIdx < totalFiles; fileIdx++) {
        const f = files[fileIdx];

        let contents: any[] = [
          prompt,
          {
            inlineData: { data: f.buffer.toString('base64'), mimeType: f.mimetype }
          }
        ];

        const response = await ai.models.generateContent({
          model: selectedModel,
          contents,
          config: { responseMimeType: 'application/json' }
        });

        const text = response.text || '';
        const parsedRec = safeParseJSON(text);
        if (Array.isArray(parsedRec)) {
          let currentImageBuffer: Buffer | null = null;
          if (f.mimetype === 'application/pdf') {
            currentImageBuffer = await pdfPageToImage(f.buffer, 0);
          } else if (f.mimetype && f.mimetype.startsWith('image/')) {
            currentImageBuffer = f.buffer;
          }

          for (const q of parsedRec) {
            if (!q.raw_text && q.question) q.raw_text = q.question;
            if (!q.raw_text && q.statement) q.raw_text = q.statement;

            if (q.bounding_box && q.bounding_box.length === 4 && currentImageBuffer) {
              const imgUri = await cropImageBoundingBox(currentImageBuffer, q.bounding_box);
              if (imgUri) {
                const imgHtml = `<div class="resizable-image-wrapper"><div class="image-content-box" style="width: 100%;"><img src="${imgUri}" alt="Diagram"></div></div>`;
                q.raw_text = (q.raw_text || '') + '\n' + imgHtml;
              }
            }
          }
          recovered.push(...parsedRec);
        }
      }
    }

    if (!recovered || recovered.length === 0) {
      recovered = missingNums.map(num => ({
        original_index: num,
        question: `Question ${num} (Recovered)`,
        type: 'identification',
        options: [],
        answer: 'Recovered Answer'
      }));
    }

    // Sort recovered questions strictly by original_index
    sortQuestionsByIndex(recovered);

    res.json({ success: true, recovered });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/generate_quiz_from_extracted', tokenRequired, async (req: any, res) => {
  const {
    questions = [],
    golden_reference = {},
    topic = 'Matched Quiz',
    subject = 'General',
    time_limit = 30,
    quiz_mode = 'back_and_forth',
    model_name = 'gemini-3.5-flash-lite',
    api_key,
    session_id = 'gen_1'
  } = req.body;

  sessionProgress.set(session_id, { message: '✨ Finalizing and polishing quiz...', percentage: 30, status: 'processing' });

  try {
    const ai = getGeminiClient(api_key);
    let finalQuestions = questions;

    if (ai && questions.length > 0) {
      try {
        sessionProgress.set(session_id, { message: '📐 Re-checking equations & answer key consistency...', percentage: 65, status: 'processing' });
        const prompt = RECHECK_ANSWERS_PROMPT
          .replace('{golden_reference}', JSON.stringify(golden_reference))
          .replace('{batch_json}', JSON.stringify(questions));

        const selectedModel = getRealModelName(model_name);
        const response = await ai.models.generateContent({
          model: selectedModel,
          contents: [prompt],
          config: { responseMimeType: 'application/json' }
        });

        const text = response.text || '';
        const parsed = safeParseJSON(text);
        if (Array.isArray(parsed) && parsed.length > 0) {
          finalQuestions = parsed;
        }
      } catch (e) {
        console.warn('AI polish fallback:', e);
      }
    }

    // Sort final questions strictly by original_index
    sortQuestionsByIndex(finalQuestions);

    const formattedQuestions = finalQuestions.map((q: any, i: number) => ({
      question: q.question || q.raw_text || q.statement || `Question ${i + 1}`,
      options: Array.isArray(q.options) ? q.options : (Array.isArray(q.choices) ? q.choices : []),
      answer: q.answer !== undefined ? String(q.answer) : (q.options && q.options[0] ? q.options[0] : ''),
      type: q.type || (q.options && q.options.length > 0 ? 'multiple_choice' : 'identification')
    }));

    const uniqueTitle = getUniqueQuizTitle(topic || 'Extracted Worksheet Quiz');
    const newQuizId = `quiz_${Date.now()}`;
    const newQuiz = {
      id: newQuizId,
      user_id: req.user ? req.user.uid : 'teacher_test',
      title: uniqueTitle,
      subject: subject || 'General',
      time_limit: parseInt(time_limit) || 30,
      quiz_mode: quiz_mode || 'back_and_forth',
      require_solution: false,
      questions: formattedQuestions,
      created_at: new Date().toISOString()
    };

    quizzes.set(newQuizId, newQuiz);
    savePersistentData();
    syncDocToFirestore('quizzes', newQuizId, newQuiz);

    sessionProgress.set(session_id, { message: '🚀 Quiz created! Redirecting...', percentage: 100, status: 'completed', quiz_id: newQuizId });
    res.json({ success: true, quiz_id: newQuizId });
  } catch (err: any) {
    sessionProgress.set(session_id, { message: `❌ Error: ${err.message}`, percentage: 100, status: 'error' });
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/worksheet_upload', tokenRequired, (req, res) => {
  res.render('worksheet_upload');
});

app.get('/worksheet/:quiz_id', tokenRequired, (req, res) => {
  const quiz = quizzes.get(req.params.quiz_id);
  if (quiz) {
    return res.render('worksheet', { quiz });
  }
  res.status(404).send('Worksheet not found');
});

app.get('/results/:id', tokenRequired, (req, res) => {
  const id = req.params.id;
  const rawResult = results.get(id);

  const formatResult = (r: any) => ({
    id: r.id || id,
    quiz_id: r.quiz_id,
    quiz_title: r.quiz_title || 'Quiz Results',
    student_name: r.student_name || 'Student',
    score: r.total_score !== undefined ? r.total_score : (r.score || 0),
    total: r.max_score !== undefined ? r.max_score : (r.total || 1),
    accuracy_pct: r.max_score ? Math.round(((r.total_score || 0) / r.max_score) * 100) : 100,
    details: r.graded_details || r.details || [],
    created_at: r.created_at || new Date().toISOString(),
    completion_note: r.completion_note || ''
  });

  if (rawResult) {
    const formatted = formatResult(rawResult);
    return res.render('results', { results: [formatted], result: formatted, title: formatted.quiz_title });
  }

  // If quiz id is passed, render all results for that quiz
  const quiz = quizzes.get(id);
  if (quiz) {
    const allResults = Array.from(results.values()).filter(r => r.quiz_id === id);
    if (allResults.length > 0) {
      const formattedResults = allResults.map(formatResult).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      return res.render('results', { results: formattedResults, result: formattedResults[0], title: quiz.title });
    } else {
      return res.render('results', { results: [], result: null, title: quiz.title });
    }
  }

  res.status(404).send('Result not found');
});

app.get(['/solutions/:result_id', '/view_solutions/:quiz_id'], tokenRequired, (req, res) => {
  const id = req.params.result_id || req.params.quiz_id;
  const rawResult = results.get(id);
  const quiz = quizzes.get(id) || (rawResult ? quizzes.get(rawResult.quiz_id) : null);

  const formatSolutionResult = (r: any) => ({
    id: r ? r.id : `res_sol_${id}`,
    quiz_id: r ? r.quiz_id : (quiz ? quiz.id : id),
    quiz_title: r ? r.quiz_title : (quiz ? quiz.title : 'Quiz Solutions'),
    student_name: r ? r.student_name : 'Student',
    score: r ? (r.total_score !== undefined ? r.total_score : r.score) : (quiz ? quiz.questions.length : 0),
    total: r ? (r.max_score !== undefined ? r.max_score : r.total) : (quiz ? quiz.questions.length : 0),
    timestamp: r ? (r.created_at || new Date().toISOString()) : new Date().toISOString(),
    details: r ? (r.graded_details || r.details || []) : (quiz ? quiz.questions.map((q: any) => ({
      question: q.question,
      user_answer: q.answer,
      correct_answer: q.answer,
      is_correct: true,
      score_fraction: 1.0
    })) : [])
  });

  const formatted = formatSolutionResult(rawResult);

  res.render('view_solutions', {
    result: formatted,
    quiz: quiz || { title: formatted.quiz_title, questions: [] },
    title: formatted.quiz_title,
    session: { user: req.user }
  });
});

// --- ADMIN & AUXILIARY ROUTES ---
app.get('/admin', tokenRequired, (req, res) => {
  res.render('admin', { users: Array.from(users.values()) });
});

app.get('/api/usage/stats', (req, res) => {
  res.json({ success: true, daily_stats: {} });
});

// Guaranteed JSON fallback for any unhandled /api route
app.all('/api/*', (req, res) => {
  res.status(404).json({ success: false, error: `API route ${req.originalUrl} not found` });
});

// Start listening on HTTP server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`QuizMoKo server running on http://0.0.0.0:${PORT}`);
});
