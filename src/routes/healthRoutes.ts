import { Router } from 'express';
import { getPersistenceStatus } from '../store/db.ts';

const router = Router();

router.get('/healthz', (_req, res) => {
  const persistence = getPersistenceStatus();
  res.status(persistence.ready ? 200 : 503).json({
    ok: persistence.ready,
    status: !persistence.ready ? 'unavailable'
      : persistence.firestoreConfigured && !persistence.firestoreHealthy ? 'degraded' : 'ready',
    persistence: { ready: persistence.ready }
  });
});

export default router;
