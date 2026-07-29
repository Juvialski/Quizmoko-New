const QUOTA_WINDOW_MS = 60 * 60 * 1_000;
const STANDARD_USER_WORK_UNITS = 120;
const BYOK_USER_WORK_UNITS = 400;
const GLOBAL_WORK_UNITS = 2_000;
const DEFAULT_PER_USER_CONCURRENCY = 2;
const DEFAULT_GLOBAL_CONCURRENCY = 8;

interface WorkBucket {
  used: number;
  resetAt: number;
  active: number;
  lastSeenAt: number;
}

export interface AiWorkLease {
  release(): void;
}

export interface AcquireAiWorkOptions {
  userId: string;
  cost?: number;
  byok?: boolean;
  perUserConcurrency?: number;
  globalConcurrency?: number;
}

export class AiWorkLimitError extends Error {
  readonly status = 429;
  readonly retryAfterSeconds: number;
  readonly code: 'AI_QUOTA_EXCEEDED' | 'AI_CONCURRENCY_EXCEEDED';

  constructor(
    code: AiWorkLimitError['code'],
    message: string,
    retryAfterSeconds: number
  ) {
    super(message);
    this.name = 'AiWorkLimitError';
    this.code = code;
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

const userBuckets = new Map<string, WorkBucket>();
let globalBucket: WorkBucket = {
  used: 0,
  resetAt: Date.now() + QUOTA_WINDOW_MS,
  active: 0,
  lastSeenAt: Date.now()
};

function positiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.ceil(parsed)));
}

function refreshBucket(bucket: WorkBucket, now: number): WorkBucket {
  if (bucket.resetAt <= now) {
    bucket.used = 0;
    bucket.resetAt = now + QUOTA_WINDOW_MS;
  }
  bucket.lastSeenAt = now;
  return bucket;
}

function userBucket(userId: string, now: number): WorkBucket {
  let bucket = userBuckets.get(userId);
  if (!bucket) {
    bucket = { used: 0, resetAt: now + QUOTA_WINDOW_MS, active: 0, lastSeenAt: now };
    userBuckets.set(userId, bucket);
  }
  return refreshBucket(bucket, now);
}

function pruneIdleBuckets(now: number) {
  if (userBuckets.size < 5_000) return;
  for (const [userId, bucket] of userBuckets) {
    if (bucket.active === 0 && bucket.lastSeenAt < now - 2 * QUOTA_WINDOW_MS) {
      userBuckets.delete(userId);
    }
  }
}

export function acquireAiWork(options: AcquireAiWorkOptions): AiWorkLease {
  const now = Date.now();
  const userId = String(options.userId || '').trim().slice(0, 200);
  if (!userId) {
    throw new AiWorkLimitError(
      'AI_QUOTA_EXCEEDED',
      'An authenticated user is required for AI work.',
      60
    );
  }

  const cost = positiveInt(options.cost, 1, 500);
  const perUserConcurrency = positiveInt(
    options.perUserConcurrency,
    DEFAULT_PER_USER_CONCURRENCY,
    10
  );
  const globalConcurrency = positiveInt(
    options.globalConcurrency,
    DEFAULT_GLOBAL_CONCURRENCY,
    50
  );
  const perUserQuota = options.byok ? BYOK_USER_WORK_UNITS : STANDARD_USER_WORK_UNITS;
  const user = userBucket(userId, now);
  globalBucket = refreshBucket(globalBucket, now);

  if (user.active >= perUserConcurrency || globalBucket.active >= globalConcurrency) {
    throw new AiWorkLimitError(
      'AI_CONCURRENCY_EXCEEDED',
      'Too many AI jobs are already running. Wait for the current job to finish.',
      10
    );
  }
  if (user.used + cost > perUserQuota) {
    throw new AiWorkLimitError(
      'AI_QUOTA_EXCEEDED',
      options.byok
        ? 'Your browser-key AI work budget is temporarily exhausted.'
        : 'Your server-funded AI work budget is temporarily exhausted.',
      (user.resetAt - now) / 1_000
    );
  }
  if (globalBucket.used + cost > GLOBAL_WORK_UNITS) {
    throw new AiWorkLimitError(
      'AI_QUOTA_EXCEEDED',
      'The server AI work budget is temporarily exhausted. Try again later.',
      (globalBucket.resetAt - now) / 1_000
    );
  }

  user.used += cost;
  user.active += 1;
  globalBucket.used += cost;
  globalBucket.active += 1;
  pruneIdleBuckets(now);

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      user.active = Math.max(0, user.active - 1);
      globalBucket.active = Math.max(0, globalBucket.active - 1);
      user.lastSeenAt = Date.now();
      globalBucket.lastSeenAt = Date.now();
    }
  };
}

export function resetAiWorkGuardForTests(): void {
  if (process.env.NODE_ENV !== 'test') return;
  userBuckets.clear();
  const now = Date.now();
  globalBucket = {
    used: 0,
    resetAt: now + QUOTA_WINDOW_MS,
    active: 0,
    lastSeenAt: now
  };
}
