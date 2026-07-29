import express from 'express';
import http from 'http';
import path from 'path';
import cookieParser from 'cookie-parser';
import { PORT, initDatabase, quizzes } from './src/store/db.ts';
import { tokenRequired, AuthRequest } from './src/middleware/auth.ts';
import { initSocketServer } from './src/services/socket.ts';

// Modular Routes
import authRoutes from './src/routes/authRoutes.ts';
import quizRoutes from './src/routes/quizRoutes.ts';
import liveRoutes from './src/routes/liveRoutes.ts';
import gradingRoutes from './src/routes/gradingRoutes.ts';
import aiRoutes from './src/routes/aiRoutes.ts';
import resultsRoutes from './src/routes/resultsRoutes.ts';
import adminRoutes from './src/routes/adminRoutes.ts';
import worksheetRoutes from './src/routes/worksheetRoutes.ts';

const app = express();
const server = http.createServer(app);

// Setup Socket.IO & expose on app
const io = initSocketServer(server);
app.set('io', io);

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'views'));

// Middleware
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(cookieParser());
app.use(express.static(path.join(process.cwd(), 'public')));

// Register Routers
app.use(authRoutes);
app.use(quizRoutes);
app.use(liveRoutes);
app.use(gradingRoutes);
app.use(aiRoutes);
app.use(resultsRoutes);
app.use(adminRoutes);
app.use(worksheetRoutes);

// Guaranteed JSON fallback for any unhandled /api route
app.all('/api/*', (req, res) => {
  res.status(404).json({ success: false, error: `API route ${req.originalUrl} not found` });
});

// Initialize database & persistence
initDatabase();

// Start listening on HTTP server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`QuizMoKo server running on http://0.0.0.0:${PORT}`);
});
