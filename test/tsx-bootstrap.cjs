'use strict';

// Keep automated tests hermetic: no Firebase, local persistence, or live AI
// credentials are needed for the grading/domain suite.
process.env.NODE_ENV = 'test';
process.env.AI_STUDIO_SANDBOX = 'true';
process.env.FIREBASE_ADMIN_ENABLED = 'false';
process.env.FIRESTORE_REQUIRED = 'false';
process.env.GEMINI_API_KEY = '';
process.env.API_KEY = '';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'quizmoko-test-grade-proof-secret-32-bytes';

// Some constrained Windows runners return uv_os_get_passwd/ENOMEM even
// though USERNAME is available. tsx only needs the username to choose a temp
// folder, so provide the same non-secret OS shape before its ESM loader starts.
try {
  require('node:os').userInfo();
} catch {
  const os = require('node:os');
  os.userInfo = () => ({
    uid: -1,
    gid: -1,
    username: process.env.USERNAME || 'quizmoko-test',
    homedir: process.env.USERPROFILE || process.cwd(),
    shell: null
  });
}
