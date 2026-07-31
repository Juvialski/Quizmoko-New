import fs from 'node:fs';
import path from 'node:path';
import {
  applicationDefault,
  cert,
  getApp,
  getApps,
  initializeApp,
  type App,
  type AppOptions
} from 'firebase-admin/app';

let cachedApp: App | null | undefined;
let cachedProjectId: string | undefined;
let credentialMode: 'service-account' | 'application-default' | 'project-only' | 'disabled' = 'disabled';

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase());
}

function readClientProjectId(): string | undefined {
  if (cachedProjectId !== undefined) return cachedProjectId || undefined;

  cachedProjectId =
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT;

  if (cachedProjectId) return cachedProjectId;

  try {
    const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      cachedProjectId = typeof config.projectId === 'string' ? config.projectId : '';
    }
  } catch {
    cachedProjectId = '';
  }

  return cachedProjectId || undefined;
}

function parseServiceAccount(): Record<string, unknown> | undefined {
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const rawBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!rawJson && !rawBase64) return undefined;

  try {
    const decoded = rawJson || Buffer.from(rawBase64!, 'base64').toString('utf8');
    const account = JSON.parse(decoded);
    if (typeof account.private_key === 'string') {
      account.private_key = account.private_key.replace(/\\n/g, '\n');
    }
    return account;
  } catch {
    console.warn('[Firebase Admin] Service-account configuration is invalid; no credential values were logged.');
    return undefined;
  }
}

function isGoogleManagedRuntime(): boolean {
  if (isAiStudioSandbox()) return false;
  if (process.env.K_SERVICE && process.env.K_SERVICE.startsWith('ais-')) {
    return false;
  }
  return Boolean(
    process.env.K_SERVICE ||
    process.env.GAE_ENV ||
    process.env.FUNCTION_TARGET ||
    process.env.FUNCTION_NAME
  );
}

export function isAiStudioSandbox(): boolean {
  if (process.env.RENDER) return false;
  if (process.env.FORCE_ONLINE_SANDBOX === 'true') return false;

  const kService = process.env.K_SERVICE || '';
  const gcpProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '';

  if (kService.startsWith('ais-')) return true;
  if (gcpProject.includes('ai-studio') || gcpProject.includes('ais-')) return true;
  if (process.env.AIS_SANDBOX === 'true' || process.env.AI_STUDIO_SANDBOX === 'true') return true;
  if (!process.env.RENDER && kService.length > 0) return true;

  return false;
}

export function hasFirebaseAdminCredentials(): boolean {
  if (isAiStudioSandbox()) return false;
  if (!envFlag('FIREBASE_ADMIN_ENABLED', true)) return false;
  return Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    isGoogleManagedRuntime()
  );
}

/**
 * Returns one shared Admin app. Persistence callers require credentials, while
 * ID-token verification can safely use a project-only app because it verifies
 * Google's public signatures and does not grant database access.
 */
export function getFirebaseAdminApp(requireCredentials = false): App | null {
  if (isAiStudioSandbox()) {
    credentialMode = 'disabled';
    return null;
  }

  if (!envFlag('FIREBASE_ADMIN_ENABLED', true)) {
    credentialMode = 'disabled';
    return null;
  }

  if (cachedApp !== undefined) {
    if (requireCredentials && credentialMode === 'project-only') return null;
    return cachedApp;
  }

  if (getApps().length > 0) {
    cachedApp = getApp();
    credentialMode = hasFirebaseAdminCredentials() ? 'application-default' : 'project-only';
    return requireCredentials && credentialMode === 'project-only' ? null : cachedApp;
  }

  const projectId = readClientProjectId();
  const serviceAccount = parseServiceAccount();
  const options: AppOptions = {};

  if (projectId) options.projectId = projectId;

  if (serviceAccount) {
    options.credential = cert(serviceAccount as any);
    credentialMode = 'service-account';
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS || isGoogleManagedRuntime()) {
    options.credential = applicationDefault();
    credentialMode = 'application-default';
  } else {
    credentialMode = 'project-only';
  }

  if (requireCredentials && credentialMode === 'project-only') {
    return null;
  }

  if (!projectId && credentialMode === 'project-only') {
    cachedApp = null;
    return null;
  }

  try {
    cachedApp = initializeApp(options);
    return cachedApp;
  } catch (error) {
    console.warn('[Firebase Admin] Initialization failed:', error instanceof Error ? error.message : 'unknown error');
    cachedApp = null;
    return null;
  }
}

export function getFirebaseAdminMode(): string {
  return credentialMode;
}
