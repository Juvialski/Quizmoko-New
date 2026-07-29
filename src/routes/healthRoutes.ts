import { Router } from 'express';
import { getPersistenceStatus } from '../store/db.ts';

const router = Router();

router.get('/healthz', (_req, res) => {
  const persistence = getPersistenceStatus();
  const publicPersistence = {
    ready: persistence.ready,
    local: persistence.local,
    firestoreConfigured: persistence.firestoreConfigured,
    firestoreRequired: persistence.firestoreRequired,
    firestoreCredentialed: persistence.firestoreCredentialed,
    firestoreHydrated: persistence.firestoreHydrated,
    firestoreHealthy: persistence.firestoreHealthy,
    pendingWrites: persistence.pendingWrites
  };

  res.status(persistence.ready ? 200 : 503).json({
    ok: persistence.ready,
    persistence: process.env.HEALTH_DETAILS === 'true'
      ? persistence
      : publicPersistence
  });
});

export default router;
