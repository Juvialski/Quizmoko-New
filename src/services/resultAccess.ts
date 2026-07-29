import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function hashResultAccessToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

export function createResultAccessToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
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
