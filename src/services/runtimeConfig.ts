import { isAiStudioSandbox } from './firebaseAdmin.ts';

export function isProductionRuntime(): boolean {
  return Boolean(process.env.RENDER) || process.env.NODE_ENV === 'production';
}

export function demoDataEnabled(): boolean {
  return !isProductionRuntime() && (process.env.NODE_ENV === 'test'
    || (process.env.NODE_ENV === 'development' && process.env.ALLOW_DEMO_AUTH === 'true'));
}

export function trustedSocketOrigins(): string[] {
  return [...new Set([process.env.RENDER_EXTERNAL_URL, ...(process.env.TRUSTED_ORIGINS || '').split(',')]
    .filter((value): value is string => Boolean(value?.trim()))
    .map(value => new URL(value.trim()).origin))];
}

export function validateRuntimeConfig(): void {
  if (!isProductionRuntime() || isAiStudioSandbox()) return;
  const secret = process.env.SESSION_SECRET || '';
  if (Buffer.byteLength(secret) < 32 || new Set(secret).size < 12
    || /example|change.?me|placeholder|quizmoko-test|your[_ -].*secret/i.test(secret)) {
    throw new Error('Production requires a stable random SESSION_SECRET (at least 32 bytes).');
  }
  if (process.env.ALLOW_DEMO_AUTH === 'true') throw new Error('Demo authentication is forbidden in production.');
  if (process.env.REQUIRE_FIRESTORE && /^(false|0|no|off)$/i.test(process.env.REQUIRE_FIRESTORE)) {
    throw new Error('Production cannot disable required Firestore persistence.');
  }
  if (!trustedSocketOrigins().length) throw new Error('Production requires TRUSTED_ORIGINS or RENDER_EXTERNAL_URL.');
}
