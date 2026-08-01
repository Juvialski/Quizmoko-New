/**
 * Serializes mutations for one public quiz attempt.  HTTP requests can await
 * Gemini and therefore interleave even though Node runs JavaScript on one
 * thread; this lock keeps a delayed progressive write from crossing a final
 * submission for the same session.
 */
const attemptLockTails = new Map<string, Promise<void>>();
interface RevisionIdentity {
  revision: number;
  answerDigest?: string;
  snapshotDigest?: string;
  updatedAt: number;
}
const attemptRevisionHighWater = new Map<string, RevisionIdentity>();
const REVISION_IDENTITY_TTL_MS = 48 * 60 * 60 * 1_000;
const REVISION_IDENTITY_MAX_ENTRIES = 10_000;
const REVISION_PRUNE_INTERVAL_MS = 60 * 1_000;
let lastRevisionPruneAt = 0;

function pruneRevisionIdentities(now: number): void {
  if (
    now - lastRevisionPruneAt < REVISION_PRUNE_INTERVAL_MS
    && attemptRevisionHighWater.size <= REVISION_IDENTITY_MAX_ENTRIES
  ) return;
  lastRevisionPruneAt = now;
  const expiry = now - REVISION_IDENTITY_TTL_MS;
  for (const [key, identity] of attemptRevisionHighWater) {
    if (identity.updatedAt < expiry) attemptRevisionHighWater.delete(key);
  }
}

function currentObservedIdentity(key: string, now: number): RevisionIdentity | undefined {
  const observed = attemptRevisionHighWater.get(key);
  if (observed && observed.updatedAt < now - REVISION_IDENTITY_TTL_MS) {
    attemptRevisionHighWater.delete(key);
    return undefined;
  }
  return observed;
}

function attemptKey(quizId: string, sessionId: string): string {
  return `${quizId}\0${sessionId}`;
}

function questionAttemptKey(
  quizId: string,
  sessionId: string,
  questionIndex: number
): string {
  return `${attemptKey(quizId, sessionId)}\0${questionIndex}`;
}

export async function withAttemptLock<T>(
  quizId: string,
  sessionId: string,
  operation: () => Promise<T> | T
): Promise<T> {
  const key = attemptKey(quizId, sessionId);
  const previous = attemptLockTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  attemptLockTails.set(key, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (attemptLockTails.get(key) === tail) {
      attemptLockTails.delete(key);
    }
  }
}

export function observeAnswerRevision(input: {
  quizId: string;
  sessionId: string;
  questionIndex: number;
  answerRevision: number;
  persistedRevision?: number;
  answerDigest?: string;
  snapshotDigest?: string;
}): {
  accepted: boolean;
  currentRevision: number;
  identityConflict?: boolean;
  capacityExceeded?: boolean;
} {
  const now = Date.now();
  const inspected = inspectAnswerRevision(input);
  if (!inspected.accepted) return inspected;
  const key = questionAttemptKey(input.quizId, input.sessionId, input.questionIndex);
  if (
    !attemptRevisionHighWater.has(key)
    && attemptRevisionHighWater.size >= REVISION_IDENTITY_MAX_ENTRIES
  ) {
    // Never evict a live high-water identity: doing so could allow an older
    // request for that attempt to be accepted. New identities fail closed
    // until an expired entry is pruned.
    return {
      accepted: false,
      currentRevision: inspected.currentRevision,
      capacityExceeded: true
    };
  }
  attemptRevisionHighWater.delete(key);
  attemptRevisionHighWater.set(key, {
    revision: input.answerRevision,
    ...(input.answerDigest ? { answerDigest: input.answerDigest } : {}),
    ...(input.snapshotDigest ? { snapshotDigest: input.snapshotDigest } : {}),
    updatedAt: now
  });
  return inspected;
}

export function inspectAnswerRevision(input: {
  quizId: string;
  sessionId: string;
  questionIndex: number;
  answerRevision: number;
  persistedRevision?: number;
  answerDigest?: string;
  snapshotDigest?: string;
}): { accepted: boolean; currentRevision: number; identityConflict?: boolean } {
  const now = Date.now();
  pruneRevisionIdentities(now);
  const key = questionAttemptKey(input.quizId, input.sessionId, input.questionIndex);
  const observed = currentObservedIdentity(key, now);
  const currentRevision = Math.max(
    observed?.revision ?? 0,
    Number.isInteger(input.persistedRevision) ? Number(input.persistedRevision) : 0
  );
  if (input.answerRevision < currentRevision) {
    return { accepted: false, currentRevision };
  }
  const identityConflict = Boolean(
    observed
    && observed.revision === input.answerRevision
    && (
      (observed.answerDigest && input.answerDigest && observed.answerDigest !== input.answerDigest)
      || (observed.snapshotDigest && input.snapshotDigest && observed.snapshotDigest !== input.snapshotDigest)
    )
  );
  return identityConflict
    ? { accepted: false, currentRevision, identityConflict: true }
    : { accepted: true, currentRevision: input.answerRevision };
}

export function isLatestAnswerRevision(input: {
  quizId: string;
  sessionId: string;
  questionIndex: number;
  answerRevision: number;
  persistedRevision?: number;
  answerDigest?: string;
  snapshotDigest?: string;
}): boolean {
  const inspected = inspectAnswerRevision(input);
  return inspected.accepted && input.answerRevision === inspected.currentRevision;
}

export function getCurrentAnswerRevision(input: {
  quizId: string;
  sessionId: string;
  questionIndex: number;
  persistedRevision?: number;
}): number {
  const now = Date.now();
  pruneRevisionIdentities(now);
  const key = questionAttemptKey(input.quizId, input.sessionId, input.questionIndex);
  return Math.max(
    currentObservedIdentity(key, now)?.revision ?? 0,
    Number.isInteger(input.persistedRevision) ? Number(input.persistedRevision) : 0
  );
}

export function clearAttemptRevisionState(quizId: string, sessionId: string): void {
  const prefix = `${attemptKey(quizId, sessionId)}\0`;
  for (const key of attemptRevisionHighWater.keys()) {
    if (key.startsWith(prefix)) attemptRevisionHighWater.delete(key);
  }
}
