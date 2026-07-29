import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_FILES = ['quizzes.json', 'results.json', 'users.json'];
const SENSITIVE_KEYS = new Set([
  'apikey',
  'geminiapikey',
  'googleapikey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'bearertoken',
  'authorization',
  'serviceaccount',
  'serviceaccountjson',
  'privatekey',
  'privatekeyid',
  'clientsecret',
  'clientpassword',
  'password',
  'passwordhash',
  'passwordsalt',
  'credential',
  'credentials'
]);

function normalizedKey(key) {
  return String(key).replace(/[_\-\s]/g, '').toLowerCase();
}

function sanitize(value, stats, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, stats, seen));
  }

  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(normalizedKey(key))) {
      stats.removedSensitiveFields += 1;
      continue;
    }
    clean[key] = sanitize(child, stats, seen);
  }
  return clean;
}

function scanJsonString(source, cursor) {
  const start = cursor;
  cursor += 1;
  let escaped = false;

  while (cursor < source.length) {
    const char = source[cursor];
    cursor += 1;
    if (escaped) escaped = false;
    else if (char === '\\') escaped = true;
    else if (char === '"') return { raw: source.slice(start, cursor), cursor };
  }

  throw new Error('Unterminated top-level property name');
}

function recoverTopLevelObject(source) {
  let cursor = 0;
  const recovered = {};
  let incompleteKey;
  const skipWhitespace = () => {
    while (/\s/.test(source[cursor] || '')) cursor += 1;
  };

  skipWhitespace();
  if (source[cursor] !== '{') {
    throw new Error('Expected a top-level JSON object');
  }
  cursor += 1;

  while (cursor < source.length) {
    skipWhitespace();
    if (source[cursor] === ',') {
      cursor += 1;
      skipWhitespace();
    }
    if (source[cursor] === '}') {
      return { recovered, incompleteKey, complete: true };
    }
    if (cursor >= source.length) break;
    if (source[cursor] !== '"') {
      break;
    }

    const keyResult = scanJsonString(source, cursor);
    const key = JSON.parse(keyResult.raw);
    cursor = keyResult.cursor;
    skipWhitespace();
    if (source[cursor] !== ':') break;
    cursor += 1;
    skipWhitespace();

    const valueStart = cursor;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let started = false;
    let complete = false;

    while (cursor < source.length) {
      const char = source[cursor];
      if (inString) {
        cursor += 1;
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        started = true;
        cursor += 1;
        continue;
      }
      if (char === '{' || char === '[') {
        depth += 1;
        started = true;
        cursor += 1;
        continue;
      }
      if (char === '}' || char === ']') {
        depth -= 1;
        cursor += 1;
        if (started && depth === 0) {
          complete = true;
          break;
        }
        continue;
      }
      cursor += 1;
    }

    if (!complete) {
      incompleteKey = key;
      break;
    }

    try {
      recovered[key] = JSON.parse(source.slice(valueStart, cursor));
    } catch {
      incompleteKey = key;
      break;
    }
  }

  return { recovered, incompleteKey, complete: false };
}

function atomicWrite(filePath, contents) {
  const temporaryPath = `${filePath}.${process.pid}.recovery.tmp`;
  fs.writeFileSync(temporaryPath, contents, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function securelyRemove(filePath) {
  if (!fs.existsSync(filePath)) return;
  const size = fs.statSync(filePath).size;
  if (size > 0) {
    const descriptor = fs.openSync(filePath, 'r+');
    try {
      const zeroes = Buffer.alloc(Math.min(size, 64 * 1024));
      let offset = 0;
      while (offset < size) {
        const length = Math.min(zeroes.length, size - offset);
        fs.writeSync(descriptor, zeroes, 0, length, offset);
        offset += length;
      }
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }
  fs.unlinkSync(filePath);
}

const dataDirectory = path.resolve(process.argv[2] || path.join(process.cwd(), 'data'));
const recoveryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'quizmoko-data-recovery-'));
const report = [];

for (const fileName of DATA_FILES) {
  const filePath = path.join(dataDirectory, fileName);
  if (!fs.existsSync(filePath)) continue;

  const source = fs.readFileSync(filePath, 'utf8');
  let parsed;
  let recovered = false;
  let incompleteKey;

  try {
    parsed = JSON.parse(source);
  } catch {
    const scan = recoverTopLevelObject(source);
    parsed = scan.recovered;
    recovered = true;
    incompleteKey = scan.incompleteKey;
    fs.copyFileSync(filePath, path.join(recoveryDirectory, fileName));
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`${fileName} does not contain a top-level object`);
  }

  const stats = { removedSensitiveFields: 0 };
  const clean = sanitize(parsed, stats);
  const output = `${JSON.stringify(clean)}\n`;
  atomicWrite(filePath, output);
  const backupPath = path.join(recoveryDirectory, fileName);
  if (recovered) securelyRemove(backupPath);

  report.push({
    file: fileName,
    records: Object.keys(clean).length,
    recovered,
    incompleteKey: incompleteKey || null,
    removedSensitiveFields: stats.removedSensitiveFields,
    sourceBytes: Buffer.byteLength(source),
    outputBytes: Buffer.byteLength(output)
  });
}

const recoveryDirectoryRemoved = fs.existsSync(recoveryDirectory)
  && fs.readdirSync(recoveryDirectory).length === 0;
if (recoveryDirectoryRemoved) {
  fs.rmdirSync(recoveryDirectory);
}

console.log(JSON.stringify({
  temporaryRecoveryDirectory: recoveryDirectoryRemoved ? null : recoveryDirectory,
  temporaryRecoveryDirectoryRemoved: recoveryDirectoryRemoved,
  rawBackupsRemovedAfterVerification: true,
  files: report
}, null, 2));
