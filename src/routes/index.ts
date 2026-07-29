import type { Express } from 'express';
import adminRoutes from './adminRoutes.ts';
import aiRoutes from './aiRoutes.ts';
import authRoutes from './authRoutes.ts';
import gradingRoutes from './gradingRoutes.ts';
import healthRoutes from './healthRoutes.ts';
import liveRoutes from './liveRoutes.ts';
import quizRoutes from './quizRoutes.ts';
import resultsRoutes from './resultsRoutes.ts';
import worksheetRoutes from './worksheetRoutes.ts';

const appRouters = [
  healthRoutes,
  authRoutes,
  quizRoutes,
  liveRoutes,
  gradingRoutes,
  aiRoutes,
  resultsRoutes,
  adminRoutes,
  worksheetRoutes
];

export function registerRoutes(app: Express): void {
  for (const router of appRouters) {
    app.use(router);
  }
}
