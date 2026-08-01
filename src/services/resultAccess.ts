import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

let generatedAttemptSecret: Buffer | null = null;

function attemptAccessSecret(): Buffer {
  if (process.env.SESSION_SECRET) return Buffer.from(process.env.SESSION_SECRET, 'utf8');
  if (!generatedAttemptSecret) generatedAttemptSecret = randomBytes(32);
  return generatedAttemptSecret;
}

export function hashResultAccessToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

export function createResultAccessToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashResultAccessToken(token) };
}

/**
 * Final submission is idempotent by session. Deriving its capability token
 * means a safe retry can return the same link without persisting the raw token.
 */
export function createResultAccessTokenForSession(
  resultId: string,
  quizId: string,
  sessionId: string
): { token: string; hash: string } {
  const token = createHmac('sha256', attemptAccessSecret())
    .update('quizmoko-result-access-v1\0')
    .update(resultId)
    .update('\0')
    .update(quizId)
    .update('\0')
    .update(sessionId)
    .digest('base64url');
  return { token, hash: hashResultAccessToken(token) };
}

export function verifyResultAccessToken(token: unknown, expectedHash: unknown): boolean {
  if (typeof token !== 'string' || !token || typeof expectedHash !== 'string' || !expectedHash) {
    return false;
  }
  const actual = Buffer.from(hashResultAccessToken(token), 'utf8');
  const expected = Buffer.from(expectedHash, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function resultAccessCookieName(resultId: string): string {
  return `quizmoko_result_${resultId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}
