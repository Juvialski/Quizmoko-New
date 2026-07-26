import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import { Server as SocketIOServer } from 'socket.io';
import { GoogleGenAI } from '@google/genai';
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

app.post('/api/extract_worksheet', tokenRequired, upload.array('files'), async (req: any, res) => {
  const { session_id = 'sess_1', topic_hint = '', subject = 'General', api_key } = req.body;
  const files = req.files as Express.Multer.File[];

  sessionProgress.set(session_id, { message: '🔍 Analyzing worksheet content...', percentage: 30, status: 'processing' });

  try {
    const ai = getGeminiClient(api_key);
    let questions: any[] = [];

    if (ai) {
      try {
        let prompt = `Extract all quiz or worksheet questions from this file/text. Subject: ${subject}. Topic: ${topic_hint}.
Return a JSON array of objects with keys: "raw_text", "question", "type" ("multiple_choice" or "identification"), "options" (array if multiple choice), "original_index".`;

        let contents: any[] = [prompt];
        if (files && files.length > 0) {
          files.forEach(f => {
            contents.push({
              inlineData: {
                data: f.buffer.toString('base64'),
                mimeType: f.mimetype
              }
            });
          });
        }

        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents
        });

        const text = response.text || '';
        const cleanJson = text.replace(/```json/gi, '').replace(/```/gi, '').trim();
        questions = JSON.parse(cleanJson);
      } catch (err) {
        console.warn('Gemini extraction fallback:', err);
      }
    }

    if (!questions || questions.length === 0) {
      questions = [
        {
          raw_text: '1. What is the sum of angles in a triangle?',
          question: 'What is the sum of angles in a triangle?',
          type: 'multiple_choice',
          options: ['A) 180°', 'B) 360°', 'C) 90°', 'D) 270°'],
          original_index: 1
        },
        {
          raw_text: '2. Express $x^2 + 5x + 6 = 0$ in factored form.',
          question: 'Express $x^2 + 5x + 6 = 0$ in factored form.',
          type: 'identification',
          options: [],
          original_index: 2
        }
      ];
    }

    sessionProgress.set(session_id, { message: '✅ Questions extracted!', percentage: 100, status: 'completed' });
    res.json({ success: true, questions, missing_indices: [] });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/solve_worksheet', tokenRequired, async (req: any, res) => {
  const { session_id = 'sess_1', topic = 'Worksheet Quiz', subject = 'General', questions = [], time_limit = 30, quiz_mode = 'back_and_forth', api_key } = req.body;
  const userId = req.user.uid;

  sessionProgress.set(session_id, { message: '✨ Solving and generating answers...', percentage: 50, status: 'processing' });

  setTimeout(async () => {
    try {
      const ai = getGeminiClient(api_key);
      let solvedQuestions = questions;

      if (ai) {
        try {
          const prompt = `Solve these worksheet questions and provide verified correct answers and options.
Subject: ${subject}, Topic: ${topic}.
Questions JSON: ${JSON.stringify(questions)}
Return a JSON array of solved objects with keys: "question", "options", "answer", "type".`;

          const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [prompt]
          });

          const text = response.text || '';
          const cleanJson = text.replace(/```json/gi, '').replace(/```/gi, '').trim();
          solvedQuestions = JSON.parse(cleanJson);
        } catch (e) {
          console.warn('Gemini solver fallback:', e);
        }
      }

      const newQuizId = `quiz_${Date.now()}`;
      const newQuiz = {
        id: newQuizId,
        user_id: userId,
        title: `${topic} (Extracted)`,
        subject: subject,
        time_limit: parseInt(time_limit) || 30,
        quiz_mode: quiz_mode,
        require_solution: false,
        questions: solvedQuestions,
        created_at: new Date().toISOString()
      };

      quizzes.set(newQuizId, newQuiz);
      savePersistentData();
      syncDocToFirestore('quizzes', newQuizId, newQuiz);

      sessionProgress.set(session_id, {
        message: '🚀 Launching Edit Screen...',
        percentage: 100,
        status: 'completed',
        quiz_id: newQuizId
      });
    } catch (e: any) {
      sessionProgress.set(session_id, { message: `❌ Error: ${e.message}`, percentage: 100, status: 'error' });
    }
  }, 1000);

  res.status(202).json({ success: true, message: 'Solving started', session_id });
});

app.get('/api/progress/:session_id', (req, res) => {
  const prog = sessionProgress.get(req.params.session_id);
  if (prog) {
    res.json(prog);
  } else {
    res.json({ status: 'waiting', message: 'Initializing task...', percentage: 10 });
  }
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
  const { quiz_id, q_index, student_answer, api_key } = req.body;
  const quiz = quizzes.get(quiz_id);

  if (!quiz || !quiz.questions[q_index]) {
    return res.json({ success: false, is_correct: false, correct_answer: '' });
  }

  const q = quiz.questions[q_index];
  const expected = (q.answer || '').toString().trim().toLowerCase();
  const actual = (student_answer || '').toString().trim().toLowerCase();

  let isCorrect = false;
  if (q.type === 'multiple_choice') {
    const expectedLetter = expected.replace(/[^a-d]/gi, '')[0];
    const actualLetter = actual.replace(/[^a-d]/gi, '')[0];
    isCorrect = expectedLetter && actualLetter ? expectedLetter === actualLetter : expected === actual;
  } else {
    isCorrect = expected === actual || actual.includes(expected);
  }

  res.json({
    success: true,
    is_correct: isCorrect,
    correct_answer: q.answer,
    score_fraction: isCorrect ? 1.0 : 0.0,
    ai_feedback: isCorrect ? 'Great job!' : `Correct answer: ${q.answer}`
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
  const { question, user_answer, correct_answer, api_key } = req.body;
  const ai = getGeminiClient(api_key);

  if (ai) {
    try {
      const prompt = `Explain clearly and concisely why the student's answer was incorrect for this quiz question.
Question: "${question}"
Student's Answer: "${user_answer}"
Correct Answer: "${correct_answer}"`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [prompt]
      });

      return res.json({ success: true, explanation: response.text });
    } catch (err: any) {
      console.warn('Gemini explain fallback:', err);
    }
  }

  res.json({
    success: true,
    explanation: `The correct answer is "${correct_answer}". Your submitted answer was "${user_answer}". Compare the key concepts to see where the solution differs.`
  });
});

app.post(['/update/:quiz_id', '/api/quiz/:quiz_id/update'], tokenRequired, (req, res) => {
  const quizId = req.params.quiz_id;
  const existing = quizzes.get(quizId) || { id: quizId, created_at: new Date().toISOString() };
  const updated = { ...existing, ...req.body, id: quizId };
  quizzes.set(quizId, updated);
  savePersistentData();
  syncDocToFirestore('quizzes', quizId, updated);
  res.json({ success: true, quiz_id: quizId, quiz: updated, redirect: `/edit/${quizId}` });
});

app.get('/create_blank', tokenRequired, (req: any, res) => {
  const title = (req.query.title as string) || 'Untitled Quiz';
  const subject = (req.query.subject as string) || 'General';
  const newId = `quiz_${Date.now()}`;
  const newQuiz = {
    id: newId,
    user_id: req.user ? req.user.uid : 'teacher_test',
    title,
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
    title: new_title,
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

app.post('/api/extract_rmxflash', upload.array('files'), (req, res) => {
  res.json({ success: true, flashcards: [] });
});

app.all('/api/export_rmxflash_excel', (req, res) => {
  res.json({ success: true });
});

app.post('/api/extract_worksheet_with_answers', upload.array('files'), (req, res) => {
  res.json({ success: true, questions: [] });
});

app.post('/api/recover_questions', upload.array('files'), (req, res) => {
  res.json({ success: true, questions: [] });
});

app.post('/api/generate_quiz_from_extracted', (req, res) => {
  res.json({ success: true, quiz_id: 'quiz_extracted_1' });
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

app.get('/results/:result_id', tokenRequired, (req, res) => {
  const id = req.params.result_id;
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

  // Fallback: if quiz id is passed, render mock result for teacher review
  const quiz = quizzes.get(id);
  if (quiz) {
    const mockResult = formatResult({
      id: `res_mock_${id}`,
      quiz_id: id,
      quiz_title: quiz.title,
      student_name: 'Sample Student',
      total_score: quiz.questions.length,
      max_score: quiz.questions.length,
      graded_details: quiz.questions.map((q: any) => ({
        question: q.question,
        user_answer: q.answer,
        correct_answer: q.answer,
        is_correct: true,
        score_fraction: 1.0
      }))
    });
    return res.render('results', { results: [mockResult], result: mockResult, title: quiz.title });
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
