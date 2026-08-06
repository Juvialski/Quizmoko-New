const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_FLASH_LITE_RPM = 15;
const DEFAULT_RPM_RESERVE = 1;
const DEFAULT_MAX_QUEUE_WAIT_MS = 180_000;

interface ModelRateBucket {
  starts: number[];
  tail: Promise<void>;
  pending: number;
  lastSeenAt: number;
}

interface RateLimiterConfig {
  windowMs: number;
  rpm: number;
  reserve: number;
  maxQueueWaitMs: number;
}

export class GeminiRateLimitError extends Error {
  readonly status = 429;
  readonly code = 'GEMINI_RATE_LIMITED';
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = 'GeminiRateLimitError';
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

const buckets = new Map<string, ModelRateBucket>();
let testConfig: Partial<RateLimiterConfig> | null = null;

function boundedInt(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function limiterConfig(): RateLimiterConfig {
  const runningTests = process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT);
  const testDefaultRpm = runningTests && !testConfig ? 10_000 : DEFAULT_FLASH_LITE_RPM;
  const testDefaultReserve = runningTests && !testConfig ? 0 : DEFAULT_RPM_RESERVE;
  const windowMs = boundedInt(
    testConfig?.windowMs ?? process.env.GEMINI_RATE_LIMIT_WINDOW_MS,
    DEFAULT_WINDOW_MS,
    100,
    10 * 60_000
  );
  const rpm = boundedInt(
    testConfig?.rpm ?? process.env.GEMINI_FLASH_LITE_RPM,
    testDefaultRpm,
    1,
    10_000
  );
  const reserve = boundedInt(
    testConfig?.reserve ?? process.env.GEMINI_FLASH_LITE_RPM_RESERVE,
    testDefaultReserve,
    0,
    Math.max(0, rpm - 1)
  );
  const maxQueueWaitMs = boundedInt(
    testConfig?.maxQueueWaitMs ?? process.env.GEMINI_RATE_LIMIT_MAX_WAIT_MS,
    DEFAULT_MAX_QUEUE_WAIT_MS,
    1_000,
    15 * 60_000
  );
  return { windowMs, rpm, reserve, maxQueueWaitMs };
}

function canonicalModelName(model: unknown): string {
  return String(model || 'unknown-model').trim().toLowerCase();
}

function getBucket(model: string): ModelRateBucket {
  let bucket = buckets.get(model);
  if (!bucket) {
    bucket = {
      starts: [],
      tail: Promise.resolve(),
      pending: 0,
      lastSeenAt: Date.now()
    };
    buckets.set(model, bucket);
  }
  bucket.lastSeenAt = Date.now();
  return bucket;
}

function pruneOldStarts(bucket: ModelRateBucket, now: number, windowMs: number): void {
  const cutoff = now - windowMs;
  while (bucket.starts.length > 0 && bucket.starts[0] <= cutoff) {
    bucket.starts.shift();
  }
}

function pruneIdleBuckets(now: number): void {
  if (buckets.size < 100) return;
  for (const [model, bucket] of buckets) {
    if (bucket.pending === 0 && bucket.starts.length === 0 && bucket.lastSeenAt < now - 10 * 60_000) {
      buckets.delete(model);
    }
  }
}

function abortError(): Error {
  const error = new Error('Gemini request was cancelled while waiting for a rate-limit slot.');
  error.name = 'AbortError';
  return error;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(abortError());

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function reserveModelSlot(model: string, signal?: AbortSignal): Promise<void> {
  const config = limiterConfig();
  const effectiveRpm = Math.max(1, config.rpm - config.reserve);
  const bucket = getBucket(model);
  const queuedAt = Date.now();

  const previous = bucket.tail.catch(() => undefined);
  let releaseQueue!: () => void;
  bucket.tail = new Promise<void>(resolve => {
    releaseQueue = resolve;
  });
  bucket.pending += 1;

  await previous;
  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      const now = Date.now();
      pruneOldStarts(bucket, now, config.windowMs);

      if (bucket.starts.length < effectiveRpm) {
        bucket.starts.push(now);
        bucket.lastSeenAt = now;
        return;
      }

      const nextAvailableAt = bucket.starts[0] + config.windowMs + 25;
      const waitMs = Math.max(25, nextAvailableAt - now);
      const elapsed = now - queuedAt;
      if (elapsed + waitMs > config.maxQueueWaitMs) {
        throw new GeminiRateLimitError(
          `Gemini ${model} is at its configured ${config.rpm} requests-per-minute limit. Try again shortly.`,
          waitMs / 1_000
        );
      }
      await delay(waitMs, signal);
    }
  } finally {
    bucket.pending = Math.max(0, bucket.pending - 1);
    bucket.lastSeenAt = Date.now();
    releaseQueue();
    pruneIdleBuckets(Date.now());
  }
}

function upstreamStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = Number(
    (error as any).status
      ?? (error as any).statusCode
      ?? (error as any).error?.code
      ?? (error as any).response?.status
  );
  return Number.isInteger(candidate) ? candidate : null;
}

function upstreamRetryAfterSeconds(error: unknown): number {
  const rawHeader = (error as any)?.response?.headers?.get?.('retry-after');
  const rawValue = rawHeader
    ?? (error as any)?.retryAfterSeconds
    ?? (error as any)?.retry_after
    ?? (error as any)?.error?.details?.find?.((detail: any) => detail?.retryDelay)?.retryDelay;
  const numeric = Number(String(rawValue || '').replace(/s$/i, ''));
  return Number.isFinite(numeric) && numeric > 0 ? Math.ceil(numeric) : 60;
}

/**
 * Schedules every Gemini call through a per-model rolling-window queue.
 *
 * The default is 15 RPM with one request held in reserve, so this process
 * starts at most 14 requests per rolling minute for each Flash-Lite model.
 * Drafting, solver retries, adjudication, extraction, and grading all use the
 * same queue and therefore cannot bypass the model quota inside this process.
 */
export async function generateGeminiContent<T = any>(
  client: any,
  request: any
): Promise<T> {
  if (!client?.models?.generateContent) {
    throw new Error('A valid Gemini client is required.');
  }
  const model = canonicalModelName(request?.model);
  const signal = request?.config?.abortSignal as AbortSignal | undefined;
  await reserveModelSlot(model, signal);
  try {
    return await client.models.generateContent(request) as T;
  } catch (error) {
    if (upstreamStatus(error) === 429) {
      throw new GeminiRateLimitError(
        `Gemini ${model} rejected the request because an active project quota was exceeded.`,
        upstreamRetryAfterSeconds(error)
      );
    }
    throw error;
  }
}

export function getGeminiRateLimitSnapshot(): Record<string, {
  requestsInWindow: number;
  pending: number;
}> {
  const config = limiterConfig();
  const now = Date.now();
  const snapshot: Record<string, { requestsInWindow: number; pending: number }> = {};
  for (const [model, bucket] of buckets) {
    pruneOldStarts(bucket, now, config.windowMs);
    snapshot[model] = {
      requestsInWindow: bucket.starts.length,
      pending: bucket.pending
    };
  }
  return snapshot;
}

export function configureGeminiRateLimiterForTests(config: Partial<RateLimiterConfig> | null): void {
  if (process.env.NODE_ENV !== 'test') return;
  testConfig = config;
}

export function resetGeminiRateLimiterForTests(): void {
  if (process.env.NODE_ENV !== 'test') return;
  buckets.clear();
  testConfig = null;
}
