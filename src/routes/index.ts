import { requestContext } from '../services/requestContext.ts';
import type { Express } from 'express';
import jobRoutes from './jobRoutes.ts';
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
  jobRoutes,
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
  app.use(requestContext);
  for (const router of appRouters) {
    // Express 4 does not forward rejected async handlers automatically.
    for (const layer of (router as any).stack) {
      for (const handler of layer.route?.stack || []) {
        const original = handler.handle;
        if (original.length === 4) continue;
        handler.handle = (req: any, res: any, next: any) => {
          try { Promise.resolve(original(req, res, next)).catch(next); }
          catch (error) { next(error); }
        };
      }
    }
    app.use(router);
  }
}
