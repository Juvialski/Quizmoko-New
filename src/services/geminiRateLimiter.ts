import { requestAbortSignal, waitWithSignal } from './requestContext.ts';
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_FLASH_LITE_RPM = 15;
const DEFAULT_RPM_RESERVE = 1;
const DEFAULT_MAX_QUEUE_WAIT_MS = 180_000;

interface ModelRateBucket {
  starts: number[];
  waiters: Array<{interactive:boolean; queuedAt:number; quotaKey:string}>;
  interactiveBurst: number;
  pending: number;
  lastSeenAt: number;
  cooldownUntil: number;
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
const clientQuotaKeys = new WeakMap<object,string>();
const keyWindows = new Map<string,{starts:number[]; cooldownUntil:number; lastSeenAt:number}>();
export function setGeminiQuotaIdentity(client: object, digest: string) { clientQuotaKeys.set(client,digest); }
function keyWindow(key: string) {
  const now=Date.now();
  for (const [id,value] of keyWindows) if (value.lastSeenAt < now-15*60_000 && value.cooldownUntil < now) keyWindows.delete(id);
  if (!keyWindows.has(key)) {
    if (keyWindows.size >= 2000) throw new GeminiRateLimitError('AI quota accounting is busy.',60);
    keyWindows.set(key,{starts:[],cooldownUntil:0,lastSeenAt:now});
  }
  const value=keyWindows.get(key)!; value.lastSeenAt=now; return value;
}
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
      cooldownUntil: 0,
      starts: [],
      waiters: [],
      interactiveBurst: 0,
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

async function reserveModelSlot(model: string, signal?: AbortSignal, interactive = false, quotaKey = 'unregistered'): Promise<number> {
  const config = limiterConfig();
  const effectiveRpm = Math.max(1, config.rpm - config.reserve);
  const bucket = getBucket(model);
  const queuedAt = Date.now();
  const budget = interactive ? Math.min(8_000, config.maxQueueWaitMs) : config.maxQueueWaitMs;
  if (bucket.pending >= 200) throw new GeminiRateLimitError('AI request queue is full.',60);
  const account=keyWindow(quotaKey);
  const waiter = {interactive, queuedAt, quotaKey};
  bucket.waiters.push(waiter); bucket.pending++;
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason || abortError();
      const now = Date.now(); pruneOldStarts(bucket,now,config.windowMs);
      const ready = bucket.waiters.filter(w=>keyWindow(w.quotaKey).cooldownUntil <= now);
      const background = ready.find(w=>!w.interactive);
      const urgent = ready.find(w=>w.interactive);
      // Three interactive starts at most before the oldest waiting background request.
      const selected = urgent && (!background || bucket.interactiveBurst < 3) ? urgent : background || urgent;
      if (selected === waiter && bucket.starts.length < effectiveRpm && now >= bucket.cooldownUntil) {
        bucket.starts.push(now); bucket.lastSeenAt=now;
        account.starts=account.starts.filter(t=>t>now-config.windowMs); account.starts.push(now);
        bucket.interactiveBurst = interactive ? bucket.interactiveBurst+1 : 0;
        return now-queuedAt;
      }
      const available = Math.max(account.cooldownUntil,bucket.cooldownUntil, bucket.starts.length >= effectiveRpm ? bucket.starts[0]+config.windowMs+25 : now);
      if (now-queuedAt >= budget || available-queuedAt > budget) throw new GeminiRateLimitError('Gemini reached its request limit. You can retry later.', Math.max(1,(available-now)/1000));
      await delay(Math.min(100, Math.max(25,available-now)),signal);
    }
  } finally {
    bucket.waiters = bucket.waiters.filter(w=>w!==waiter); bucket.pending--; pruneIdleBuckets(Date.now());
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
  const rawHeader = (error as any)?.response?.headers?.get?.('retry-after')
    ?? (error as any)?.response?.headers?.['retry-after'];
  const rawValue = rawHeader
    ?? (error as any)?.retryAfterSeconds
    ?? (error as any)?.retry_after
    ?? (error as any)?.error?.details?.find?.((detail: any) => detail?.retryDelay)?.retryDelay;
  const numeric = Number(String(rawValue || '').replace(/s$/i, ''));
  if (Number.isFinite(numeric) && numeric > 0) return Math.ceil(numeric);
  const date = Date.parse(String(rawValue));
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date - Date.now()) / 1000)) : 60;
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
  const suppliedSignal = request?.config?.abortSignal as AbortSignal | undefined;
  const inheritedSignal = requestAbortSignal();
  const signals = [suppliedSignal, inheritedSignal].filter((s): s is AbortSignal => Boolean(s));
  const queueSignal = signals.length ? AbortSignal.any(signals) : undefined;
  const task = String(request?.config?._quizmokoTask || 'other');
  const interactive = task === 'semantic_grading';
  const metric = reliabilityMetric(model, task);
  const quotaKey = `${clientQuotaKeys.get(client) || 'unregistered'}:${model}`;
  metric.requests++;
  try { metric.queue_wait_ms += await reserveModelSlot(model, queueSignal, interactive, quotaKey); }
  catch (error) { metric.queue_rejected++; throw error; }
  const configuredTimeout = Number(process.env.GEMINI_REQUEST_TIMEOUT_MS);
  const transportTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.min(configuredTimeout, 180_000) : 90_000;
  const timeoutMs = interactive ? Math.min(20_000, transportTimeoutMs) : transportTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Gemini request timed out', 'TimeoutError')), timeoutMs);
  const signal = AbortSignal.any([...signals, controller.signal]);
  const providerStart = Date.now();
  const { _quizmokoTask: ignoredTask, ...providerConfig } = request.config || {};
  try {
    if (signal.aborted) throw signal.reason || abortError();
    metric.provider_requests=(metric.provider_requests || 0)+1;
    const response = await waitWithSignal(Promise.resolve(client.models.generateContent({
      ...request, config: { ...providerConfig, abortSignal: signal }
    })), signal) as T;
    if ((response as any)?.candidates?.some((c:any)=>c.finishReason==='MAX_TOKENS')) metric.truncated_output=(metric.truncated_output || 0)+1;
    return response;
  } catch (error) {
    const category = geminiFailureCategory(error);
    metric[category] = (metric[category] || 0)+1;
    if (upstreamStatus(error) === 429) {
      keyWindow(quotaKey).cooldownUntil = Date.now() + upstreamRetryAfterSeconds(error) * 1000;
      throw new GeminiRateLimitError(
        `Gemini ${model} rejected the request because an active project quota was exceeded.`,
        upstreamRetryAfterSeconds(error)
      );
    }
    console.warn(`[AI] Request failed (model ${model}, status ${upstreamStatus(error) || 'transport'}).`);
    throw error;
  } finally {
    metric.provider_ms += Date.now()-providerStart;
    clearTimeout(timer);
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
  keyWindows.clear();
  testConfig = null;
}

export function isPermanentGeminiFailure(error: unknown): boolean {
  const status = upstreamStatus(error);
  return status !== null && status >= 400 && status < 500 && ![408, 429].includes(status);
}

const reliability = new Map<string, Record<string,number>>();
function reliabilityMetric(model: string, task: string) {
  const safeModel = ['gemini-3.5-flash-lite','gemini-3.1-flash-lite'].includes(model) ? model : 'other';
  const safeTask = ['document_extraction','answer_key_extraction','question_drafting','question_solving','question_adjudication','latex_polish','semantic_grading','student_explanation'].includes(task) ? task : 'other';
  const key = `${safeModel}:${safeTask}`;
  if (!reliability.has(key)) reliability.set(key,{requests:0,queue_wait_ms:0,provider_ms:0,queue_rejected:0});
  return reliability.get(key)!;
}
export function geminiFailureCategory(error: any): string {
  const status = upstreamStatus(error);
  if (status === 429) return 'rate_limit';
  if (error?.name === 'TimeoutError' || status === 408) return 'timeout';
  if (error?.name === 'AbortError') return 'cancelled';
  if (status === 401 || status === 403) return 'authentication';
  if (status === 400 || status === 404) return 'configuration_or_request';
  if (status && status >= 500) return 'provider_outage';
  return 'transport_or_response';
}
export function getGeminiReliabilitySnapshot() { return Object.fromEntries([...reliability].map(([k,v])=>[k,{...v}])); }
export function recordGeminiOutcome(model: string, task: string, outcome: 'validation_failure' | 'retry' | 'verified' | 'review_required' | 'processed_units', count=1) {
  const metric=reliabilityMetric(model,task);
  metric[outcome]=(metric[outcome] || 0)+Math.max(0,Math.min(1000,count));
}
export function safeAiErrorMessage(error: any): string {
  const category=geminiFailureCategory(error);
  if (error instanceof GeminiRateLimitError || category==='rate_limit') return 'Gemini reached its request limit. You can retry later.';
  if (category==='authentication') return 'AI credentials need attention. Your saved work is retained.';
  if (category==='configuration_or_request') return 'Gemini could not accept this request. Check the AI settings before retrying.';
  if (category==='timeout' || category==='cancelled') return 'AI processing was interrupted. Open any saved draft before retrying.';
  return 'AI could not finish safely. Your saved work is retained. You can retry later.';
}
