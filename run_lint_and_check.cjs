const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const ejsLint = require('ejs-lint').default;
const { globSync } = require('glob');

const failures = [];

function fail(scope, error) {
  const message = error instanceof Error ? error.message : String(error);
  failures.push(`${scope}: ${message}`);
}

function lintEjsTemplates() {
  const files = globSync('views/*.ejs', { windowsPathsNoEscape: true }).sort();

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');

    try {
      const lintError = ejsLint(source, {});
      if (lintError) fail(file, lintError);
    } catch (error) {
      fail(file, error);
    }

    const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let match;
    let scriptIndex = 0;

    while ((match = scriptPattern.exec(source)) !== null) {
      scriptIndex += 1;
      const attributes = match[1] || '';
      const script = match[2] || '';
      const typeMatch = attributes.match(/\btype\s*=\s*["']([^"']+)["']/i);
      const scriptType = typeMatch ? typeMatch[1].toLowerCase() : '';

      if (
        !script.trim()
        || /\bsrc\s*=/i.test(attributes)
        || (scriptType && scriptType !== 'module' && !/^(?:text|application)\/javascript$/.test(scriptType))
      ) {
        continue;
      }

      // Preserve the JavaScript surrounding EJS output while replacing the output
      // itself with syntax-safe placeholders. EJS structure is checked separately.
      const parseable = script
        .replace(/<%-[\s\S]*?%>/g, '{}')
        .replace(/<%=[\s\S]*?%>/g, 'EJS_VALUE')
        .replace(/<%(?![%=-])[\s\S]*?%>/g, '');

      try {
        acorn.parse(parseable, {
          ecmaVersion: 'latest',
          sourceType: scriptType === 'module' ? 'module' : 'script',
          allowAwaitOutsideFunction: scriptType === 'module'
        });
      } catch (error) {
        const location = error && error.loc
          ? ` at inline line ${error.loc.line}, column ${error.loc.column}`
          : '';
        fail(`${file} script #${scriptIndex}${location}`, error);
      }
    }
  }

  return files.length;
}

function validateJsonFiles() {
  const files = globSync(['*.json', 'data/*.json'], {
    ignore: ['node_modules/**'],
    windowsPathsNoEscape: true
  }).sort();

  for (const file of files) {
    try {
      JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      fail(file, error);
    }
  }

  return files.length;
}

function checkSecretRegressions() {
  const sourceFiles = globSync(
    ['server.ts', 'prompts.ts', 'src/**/*.ts', 'views/*.ejs', '*.ejs'],
    { windowsPathsNoEscape: true }
  );

  for (const file of sourceFiles) {
    const source = fs.readFileSync(file, 'utf8');
    if (/\bquizData\s*\.\s*(?:api_key|gemini_api_key)\b/.test(source)) {
      fail(file, 'must not persist a Gemini API key inside quiz data');
    }
    if (/generativelanguage\.googleapis\.com[\s\S]{0,200}[?&]key\s*=\s*\$\{/i.test(source)) {
      fail(file, 'must not send a Gemini API key from browser code');
    }
  }

  const dataFiles = globSync('data/*.json', { windowsPathsNoEscape: true });
  const sensitiveDataKeys = new Set([
    'apikey',
    'geminiapikey',
    'googleapikey',
    'accesstoken',
    'refreshtoken',
    'idtoken',
    'authorization',
    'serviceaccount',
    'privatekey',
    'clientsecret',
    'password',
    'credentials'
  ]);

  for (const file of dataFiles) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }

    const visit = (value, location) => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${location}[${index}]`));
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        const normalizedKey = key.replace(/[_\-\s]/g, '').toLowerCase();
        if (sensitiveDataKeys.has(normalizedKey)) {
          fail(`${file}${location}.${key}`, 'contains a persisted credential field');
        }
        visit(child, `${location}.${key}`);
      }
    };
    visit(parsed, '');
  }

  const generatedArtifacts = globSync(['*_test.html', 'out.html'], {
    windowsPathsNoEscape: true
  });
  for (const file of generatedArtifacts) {
    const source = fs.readFileSync(file, 'utf8');
    if (/"(?:api_key|gemini_api_key)"\s*:\s*"(?!\s*")[^"]+/i.test(source)) {
      fail(file, 'contains a non-empty persisted Gemini credential in a generated artifact');
    }
  }
}

function checkStructuredAiResponses() {
  const routeFiles = globSync('src/routes/*.ts', { windowsPathsNoEscape: true });
  let structuredCallCount = 0;

  for (const file of routeFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const marker = /responseMimeType\s*:\s*['"]application\/json['"]/g;
    let match;
    while ((match = marker.exec(source)) !== null) {
      structuredCallCount += 1;
      const nearbyConfig = source.slice(match.index, match.index + 1_200);
      if (!/responseSchema\s*:/.test(nearbyConfig)) {
        fail(file, `JSON AI config near character ${match.index} is missing responseSchema`);
      }
    }
  }

  return structuredCallCount;
}

function checkArchitectureRegressions() {
  const serverSource = fs.readFileSync('server.ts', 'utf8');
  const serverLines = serverSource.split(/\r?\n/).length;
  if (serverLines > 90) {
    fail('server.ts', `entry point grew to ${serverLines} lines; keep route and lifecycle logic modular`);
  }
  if (/\bapp\.(?:get|post|put|patch|delete)\s*\(/.test(serverSource)) {
    fail('server.ts', 'raw endpoint handler found in the modular entry point');
  }

  const pdfSource = fs.readFileSync('src/services/pdf.ts', 'utf8');
  if (/\b(?:execSync|spawnSync|readFileSync|writeFileSync)\b/.test(pdfSource)) {
    fail('src/services/pdf.ts', 'synchronous filesystem or subprocess work is forbidden in PDF processing');
  }
}

const templateCount = lintEjsTemplates();
const jsonCount = validateJsonFiles();
checkSecretRegressions();
const structuredCallCount = checkStructuredAiResponses();
checkArchitectureRegressions();

if (failures.length > 0) {
  console.error(`Verification failed with ${failures.length} problem(s):`);
  failures.forEach((problem) => console.error(`- ${problem}`));
  process.exitCode = 1;
} else {
  console.log(
    `Verified ${templateCount} EJS templates, ${jsonCount} JSON files, and ${structuredCallCount} structured AI configs.`
  );
}
