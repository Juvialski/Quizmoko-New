import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import * as acorn from 'acorn';
import postcss from 'postcss';

const VIEWS_DIR = path.join(process.cwd(), 'views');

function walk(node: any, callback: (node: any) => void) {
  if (!node || typeof node !== 'object') return;
  callback(node);
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (Array.isArray(val)) {
      for (const child of val) {
        walk(child, callback);
      }
    } else if (val && typeof val === 'object') {
      walk(val, callback);
    }
  }
}

function addParents(node: any, parent: any = null) {
  if (!node || typeof node !== 'object') return;
  node.parent = parent;
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const child of val) {
        addParents(child, node);
      }
    } else if (val && typeof val === 'object') {
      addParents(val, node);
    }
  }
}

function getEnclosingScopes(node: any): any[] {
  const scopes = [];
  let curr = node;
  while (curr) {
    if (curr.type === 'FunctionDeclaration' || 
        curr.type === 'FunctionExpression' || 
        curr.type === 'ArrowFunctionExpression' || 
        curr.type === 'Program') {
      scopes.push(curr);
    }
    curr = curr.parent;
  }
  return scopes;
}

function getAllEjsFiles(dir: string = process.cwd(), excludeDirs: string[] = ['node_modules', 'dist', 'build', 'coverage', '.git']): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      if (excludeDirs.includes(file)) continue;
      results = results.concat(getAllEjsFiles(fullPath, excludeDirs));
    } else if (file.endsWith('.ejs')) {
      const TEST_FIXTURES_ALLOWLIST: string[] = ['test_fixture.ejs', 'mock_view.ejs'];
      if (TEST_FIXTURES_ALLOWLIST.includes(file)) continue;
      results.push(fullPath);
    }
  }
  return results;
}

function getEjsFiles(): string[] {
  return getAllEjsFiles();
}

test('UI Consistency - Theme files inclusion', () => {
  const files = getEjsFiles();
  assert.ok(files.length > 0, 'Should find EJS templates');

  for (const file of files) {
    const filePath = path.isAbsolute(file) ? file : path.join(VIEWS_DIR, file);
    const relativeName = path.relative(process.cwd(), filePath);
    const content = fs.readFileSync(filePath, 'utf-8');

    // Every EJS page must include our primary UI stylesheet
    assert.ok(
      content.includes('quizmoko-ui.css') || content.includes('/css/quizmoko-ui.css'),
      `Template ${relativeName} must include quizmoko-ui.css`
    );

    // Every EJS page must include the theme management script
    assert.ok(
      content.includes('quizmoko-theme.js') || content.includes('/js/quizmoko-theme.js'),
      `Template ${relativeName} must include quizmoko-theme.js`
    );
  }
});

test('UI Consistency - No duplicated global component CSS blocks', () => {
  const files = getEjsFiles();

  for (const file of files) {
    const filePath = path.isAbsolute(file) ? file : path.join(VIEWS_DIR, file);
    const relativeName = path.relative(process.cwd(), filePath);
    const content = fs.readFileSync(filePath, 'utf-8');

    const hasStandaloneBtnPrimary = /(?<![a-zA-Z0-9_-])\.btn-primary\s*\{\s*background:\s*var\(--primary\)/.test(content);
    assert.ok(
      !hasStandaloneBtnPrimary,
      `Template ${relativeName} should not redefine global .btn-primary`
    );

    const hasStandaloneBtnSecondary = /(?<![a-zA-Z0-9_-])\.btn-secondary\s*\{\s*background:\s*var\(--surface-elevated\)/.test(content);
    assert.ok(
      !hasStandaloneBtnSecondary,
      `Template ${relativeName} should not redefine global .btn-secondary`
    );

    const hasStandaloneInputStyles = /(?<![a-zA-Z0-9_-])input\[type="text"\]/.test(content);
    assert.ok(
      !hasStandaloneInputStyles,
      `Template ${relativeName} should not redefine global input styles`
    );
  }
});

test('UI Consistency - No malformed attributes or mismatched quotes', () => {
  const files = getEjsFiles();

  for (const file of files) {
    const filePath = path.isAbsolute(file) ? file : path.join(VIEWS_DIR, file);
    const relativeName = path.relative(process.cwd(), filePath);
    const content = fs.readFileSync(filePath, 'utf-8');

    assert.ok(
      !content.includes('contenteditable="true\''),
      `Template ${relativeName} has malformed selector contenteditable="true'`
    );
    assert.ok(
      !content.includes("contenteditable='true\""),
      `Template ${relativeName} has malformed selector contenteditable='true"`
    );
  }
});

test('UI Consistency - Theme toggler accessibility & configuration checks', () => {
  const files = getEjsFiles();

  for (const file of files) {
    const filePath = path.isAbsolute(file) ? file : path.join(VIEWS_DIR, file);
    const relativeName = path.relative(process.cwd(), filePath);
    const content = fs.readFileSync(filePath, 'utf-8');

    if (content.includes('toggleTheme(')) {
      assert.ok(
        content.includes('data-theme-toggle'),
        `Template ${relativeName} theme toggler must have "data-theme-toggle" attribute`
      );
      assert.ok(
        content.includes('aria-label='),
        `Template ${relativeName} theme toggler must have accessibility "aria-label" attribute`
      );
    }
  }
});

test('UI Consistency - Shared resource occurrence counts', () => {
  const files = getEjsFiles();

  for (const file of files) {
    const filePath = path.isAbsolute(file) ? file : path.join(VIEWS_DIR, file);
    const relativeName = path.relative(process.cwd(), filePath);
    const content = fs.readFileSync(filePath, 'utf-8');

    const cssMatches = content.match(/quizmoko-ui\.css/g) || [];
    assert.ok(cssMatches.length <= 1, `Template ${relativeName} contains duplicated references to quizmoko-ui.css (${cssMatches.length} times)`);

    const jsMatches = content.match(/quizmoko-theme\.js/g) || [];
    assert.ok(jsMatches.length <= 1, `Template ${relativeName} contains duplicated references to quizmoko-theme.js (${jsMatches.length} times)`);
  }
});

test('UI Consistency - Quiz theme toggle aria-label matches exactly', () => {
  const filePath = path.join(VIEWS_DIR, 'quiz.ejs');
  const content = fs.readFileSync(filePath, 'utf-8');

  const toggleMatch = content.match(/data-theme-toggle[^>]*aria-label="([^"]*)"/i) || 
                      content.match(/aria-label="([^"]*)"[^>]*data-theme-toggle/i);
  
  assert.ok(toggleMatch, 'Quiz theme toggle button with data-theme-toggle must have aria-label attribute');
  assert.equal(toggleMatch[1], 'Switch to light theme', 'Quiz theme toggle aria-label must match exactly "Switch to light theme"');
});

test('UI Consistency - No duplicate HTML attributes in the same element tag', () => {
  const files = getEjsFiles();

  for (const file of files) {
    const filePath = path.isAbsolute(file) ? file : path.join(VIEWS_DIR, file);
    const relativeName = path.relative(process.cwd(), filePath);
    const content = fs.readFileSync(filePath, 'utf-8');

    const contentWithoutEjs = content.replace(/<%[\s\S]*?%>/g, '');

    const tagRegex = /<([a-zA-Z0-9:-]+)([^>]*)\/?>/g;
    let match;
    while ((match = tagRegex.exec(contentWithoutEjs)) !== null) {
      const tagContent = match[2];
      const attrRegex = /\b([a-zA-Z0-9-]+)(?:\s*=\s*(?:'[^']*'|"[^"]*"|[^\s>]+))?/g;
      const attrs: string[] = [];
      let attrMatch;
      while ((attrMatch = attrRegex.exec(tagContent)) !== null) {
        attrs.push(attrMatch[1].toLowerCase());
      }

      const standardAttrsToValidate = ['id', 'class', 'onclick', 'src', 'href', 'style', 'type', 'name', 'value', 'placeholder', 'disabled', 'readonly', 'checked'];
      const seen = new Set<string>();
      for (const attr of attrs) {
        if (standardAttrsToValidate.includes(attr)) {
          if (seen.has(attr)) {
            assert.fail(`Template ${relativeName} has duplicated attribute "${attr}" in tag <${match[1]} ${tagContent.trim()}>`);
          }
          seen.add(attr);
        }
      }
    }
  }
});

test('UI Consistency - EJS/JS/CSS structure parsing & validation', () => {
  const files = getEjsFiles();

  for (const file of files) {
    const filePath = path.isAbsolute(file) ? file : path.join(VIEWS_DIR, file);
    const relativeName = path.relative(process.cwd(), filePath);
    const content = fs.readFileSync(filePath, 'utf-8');

    const cleanedContent = content.replace(/(["'`])(?:\\.|(?!\1).)*?\1/g, '');

    const openStyles = (cleanedContent.match(/<style\b[^>]*>/gi) || []).length;
    const closeStyles = (cleanedContent.match(/<\/style>/gi) || []).length;
    assert.equal(openStyles, closeStyles, `Template ${relativeName} has mismatched <style> tags (${openStyles} open vs ${closeStyles} close)`);

    const openScripts = (cleanedContent.match(/<script\b[^>]*>/gi) || []).length;
    const closeScripts = (cleanedContent.match(/<\/script>/gi) || []).length;
    assert.equal(openScripts, closeScripts, `Template ${relativeName} has mismatched <script> tags (${openScripts} open vs ${closeScripts} close)`);

    const styleBlockRegex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
    let match;
    while ((match = styleBlockRegex.exec(cleanedContent)) !== null) {
      const styleContent = match[1];
      const openBraces = (styleContent.match(/\{/g) || []).length;
      const closeBraces = (styleContent.match(/\}/g) || []).length;
      assert.equal(openBraces, closeBraces, `Style block inside ${relativeName} has mismatched curly braces ({ count: ${openBraces}, } count: ${closeBraces})`);
    }
  }
});

test('UI Consistency - Dynamic Lucide icon rendering regression checks via Acorn AST', () => {
  const files = getEjsFiles();

  for (const file of files) {
    const filePath = path.isAbsolute(file) ? file : path.join(VIEWS_DIR, file);
    const relativeName = path.relative(process.cwd(), filePath);
    const content = fs.readFileSync(filePath, 'utf-8');

    const scriptBlockRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = scriptBlockRegex.exec(content)) !== null) {
      const scriptContent = match[1];
      if (!scriptContent.includes('data-lucide')) continue;

      const sanitizedJs = scriptContent
        .replace(/<%=[-]?([\s\S]*?)%>/g, '"ejs_expr_placeholder"')
        .replace(/<%([\s\S]*?)%>/g, '/* ejs_block_placeholder */');

      try {
        const ast = acorn.parse(sanitizedJs, { ecmaVersion: 'latest', sourceType: 'script' });
        addParents(ast);

        const targets: any[] = [];
        const refreshCalls: any[] = [];

        walk(ast, (node) => {
          let isTarget = false;
          if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression') {
            const propName = node.left.property.name;
            if (propName === 'innerHTML' || propName === 'outerHTML') {
              if (node.right.type === 'Literal' && typeof node.right.value === 'string' && node.right.value.includes('data-lucide')) {
                isTarget = true;
              } else if (node.right.type === 'TemplateLiteral') {
                const hasLucide = node.right.quasis.some((q: any) => q.value.raw.includes('data-lucide'));
                if (hasLucide) isTarget = true;
              }
            }
          }
          if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
            const propName = node.callee.property.name;
            if (propName === 'insertAdjacentHTML' || propName === 'createElement') {
              const hasLucideArg = node.arguments.some((arg: any) => {
                if (arg.type === 'Literal' && typeof arg.value === 'string' && arg.value.includes('data-lucide')) return true;
                if (arg.type === 'TemplateLiteral' && arg.quasis.some((q: any) => q.value.raw.includes('data-lucide'))) return true;
                return false;
              });
              if (hasLucideArg || propName === 'createElement') {
                isTarget = true;
              }
            }
          }

          if (isTarget) {
            targets.push(node);
          }

          if (node.type === 'CallExpression') {
            let calleeName = '';
            if (node.callee.type === 'Identifier') {
              calleeName = node.callee.name;
            } else if (node.callee.type === 'MemberExpression' && node.callee.property.type === 'Identifier') {
              calleeName = node.callee.property.name;
            } else if (node.callee.type === 'ChainExpression' && node.callee.expression.type === 'CallExpression') {
              const innerNode = node.callee.expression;
              if (innerNode.callee.type === 'MemberExpression' && innerNode.callee.property.type === 'Identifier') {
                calleeName = innerNode.callee.property.name;
              }
            } else if (node.callee.type === 'ChainExpression' && node.callee.expression.type === 'MemberExpression' && node.callee.expression.property.type === 'Identifier') {
              calleeName = node.callee.expression.property.name;
            }
            if (calleeName === 'refreshQuizmokoIcons') {
              refreshCalls.push(node);
            }
          }
        });

        for (const target of targets) {
          const scopesT = getEnclosingScopes(target);
          const innermostT = scopesT[0];
          const allowedScopes = innermostT.type !== 'Program' ? scopesT.filter(s => s.type !== 'Program') : [innermostT];

          let satisfied = false;
          for (const call of refreshCalls) {
            const scopesC = getEnclosingScopes(call);
            const isMatch = scopesC.some(s => allowedScopes.includes(s));
            if (isMatch) {
              satisfied = true;
              break;
            }
          }

          assert.ok(
            satisfied,
            `Template ${relativeName} has dynamic Lucide icon modifications, but is missing a corresponding "refreshQuizmokoIcons" call within its enclosing execution function/scope.`
          );
        }
      } catch (err) {
        const hasDynamicIconRegex = /data-lucide/i.test(scriptContent);
        if (hasDynamicIconRegex) {
          assert.ok(
            scriptContent.includes('refreshQuizmokoIcons'),
            `Template ${relativeName} dynamically inserts icons but lacks "refreshQuizmokoIcons" fallback check.`
          );
        }
      }
    }
  }
});

test('UI Consistency - PostCSS scoped style verification', () => {
  const files = getEjsFiles();

  for (const file of files) {
    const filePath = path.isAbsolute(file) ? file : path.join(VIEWS_DIR, file);
    const relativeName = path.relative(process.cwd(), filePath);
    const content = fs.readFileSync(filePath, 'utf-8');

    const styleBlockRegex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
    let match;
    while ((match = styleBlockRegex.exec(content)) !== null) {
      const styleContent = match[1];
      if (!styleContent.trim()) continue;

      const root = postcss.parse(styleContent);
      root.walkRules(rule => {
        const selector = rule.selector.trim();
        assert.ok(
          selector !== '.card' && selector !== '.icon-sm',
          `Template ${relativeName} redefines global CSS selector "${selector}" in a style tag. Style tags must be scoped.`
        );
      });
    }
  }
});

test('UI Consistency - File inputs label verification', () => {
  const files = getEjsFiles();

  for (const file of files) {
    const filePath = path.isAbsolute(file) ? file : path.join(VIEWS_DIR, file);
    const relativeName = path.relative(process.cwd(), filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    const dom = new JSDOM(content);
    const { document } = dom.window;

    const fileInputs = document.querySelectorAll('input[type="file"]');
    for (const input of fileInputs) {
      const id = input.getAttribute('id');
      assert.ok(id, `File input in template ${relativeName} must have an id attribute`);

      const label = document.querySelector(`label[for="${id}"]`);
      assert.ok(label, `File input with id "${id}" in template ${relativeName} must have a matching label element`);
      assert.ok(label.textContent && label.textContent.trim().length > 0, `Label for file input "${id}" in template ${relativeName} must not be empty`);
    }
  }
});

test('UI Consistency - Full-width action button assertions', () => {
  const filesToVerify = [
    {
      file: 'worksheet_upload.ejs',
      assertions: [
        { selector: 'id="extract-btn"', expectedClass: 'btn-block' },
        { selector: 'id="solve-btn"', expectedClass: 'btn-block' }
      ]
    },
    {
      file: 'worksheet_answers_upload.ejs',
      assertions: [
        { selector: 'id="extract-btn"', expectedClass: 'btn-block' },
        { selector: 'id="generate-btn"', expectedClass: 'btn-block' }
      ]
    },
    {
      file: 'rmxflash_upload.ejs',
      assertions: [
        { selector: 'id="extract-btn"', expectedClass: 'btn-block' }
      ]
    },
    {
      file: 'index.ejs',
      assertions: [
        { selector: 'onclick="saveApiKey()"', expectedClass: 'btn-block' },
        { selector: 'id="btn-scan-ollama"', expectedClass: 'btn-block' }
      ]
    }
  ];

  for (const item of filesToVerify) {
    const filePath = path.join(VIEWS_DIR, item.file);
    const content = fs.readFileSync(filePath, 'utf-8');

    for (const assertInfo of item.assertions) {
      const escapedSelector = assertInfo.selector.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
      const tagRegex = new RegExp(`<[^>]*${escapedSelector}[^>]*>`, 'i');
      const tagMatch = content.match(tagRegex);
      
      assert.ok(tagMatch, `Expected to find element with "${assertInfo.selector}" in ${item.file}`);
      const tagStr = tagMatch[0];
      
      const classMatch = tagStr.match(/class\s*=\s*['"]([^'"]*)['"]/i);
      assert.ok(classMatch, `Element matching "${assertInfo.selector}" in ${item.file} must have a class attribute`);
      
      const classes = classMatch[1].split(/\s+/);
      assert.ok(
        classes.includes(assertInfo.expectedClass),
        `Element "${tagStr}" in ${item.file} is missing required class "${assertInfo.expectedClass}"`
      );
    }
  }
});

test('UI Consistency - No inline/local declarations of toggleTheme', () => {
  const files = getEjsFiles();
  const forbiddenPatterns = [
    /function\s+toggleTheme\b/,
    /window\.toggleTheme\s*=/,
    /const\s+toggleTheme\b/,
    /let\s+toggleTheme\b/,
    /var\s+toggleTheme\b/
  ];

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const relativeName = path.relative(process.cwd(), filePath);
    for (const pattern of forbiddenPatterns) {
      assert.ok(
        !pattern.test(content),
        `Template ${relativeName} contains forbidden inline toggleTheme declaration matching pattern: ${pattern.toString()}`
      );
    }
  }
});

test('UI Consistency - JSDOM Theme toggling behavior and state attributes', () => {
  const themeJsPath = path.join(process.cwd(), 'public/js/quizmoko-theme.js');
  const themeJsContent = fs.readFileSync(themeJsPath, 'utf-8');

  // Set up JSDOM with a button and a nested icon element
  const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body>
    <button data-theme-toggle aria-label="Toggle Theme"><i data-lucide="moon"></i>Theme</button>
  </body></html>`, {
    runScripts: 'dangerously',
    url: 'http://localhost/'
  });

  const { window } = dom;
  let store: Record<string, string> = {};
  
  // Set default theme to 'dark' in mock localStorage to ensure dark initialization
  store['theme'] = 'dark';

  Object.defineProperty(window, 'localStorage', {
    value: {
      getItem: (key: string) => store[key] || null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
      clear: () => { store = {}; }
    },
    writable: true
  });

  // Inject script
  const scriptElement = window.document.createElement('script');
  scriptElement.textContent = themeJsContent;
  window.document.head.appendChild(scriptElement);

  // Trigger DOMContentLoaded manually so the script's DOM ready listener fires
  const event = window.document.createEvent('Event');
  event.initEvent('DOMContentLoaded', true, true);
  window.document.dispatchEvent(event);

  const toggleThemeFn = (window as any).toggleTheme;
  assert.equal(typeof toggleThemeFn, 'function', 'toggleTheme should be defined as a function on window');

  const button = window.document.querySelector('[data-theme-toggle]');
  assert.ok(button, 'Theme toggle button must exist');
  const icon = button.querySelector('[data-lucide]');
  assert.ok(icon, 'Icon inside theme toggle button must exist');

  // Verify Dark initialization
  assert.equal(window.document.documentElement.getAttribute('data-theme'), 'dark', 'documentElement data-theme must be dark initially');
  assert.equal(icon.getAttribute('data-lucide'), 'sun', 'icon data-lucide must be sun in dark mode');
  assert.equal(button.getAttribute('aria-label'), 'Switch to light theme', 'aria-label must be Switch to light theme in dark mode');
  assert.equal(button.getAttribute('aria-pressed'), 'true', 'aria-pressed must be true in dark mode');

  // Toggle to light theme
  toggleThemeFn();

  // Verify light theme attributes
  assert.equal(window.document.documentElement.getAttribute('data-theme'), 'light', 'documentElement data-theme must be light after toggle');
  assert.equal(icon.getAttribute('data-lucide'), 'moon', 'icon data-lucide must be moon in light mode');
  assert.equal(button.getAttribute('aria-label'), 'Switch to dark theme', 'aria-label must be Switch to dark theme in light mode');
  assert.equal(button.getAttribute('aria-pressed'), 'false', 'aria-pressed must be false in light mode');
  assert.equal(window.localStorage.getItem('theme'), 'light', 'localStorage theme must be light');

  // Toggle back to dark theme
  toggleThemeFn();

  // Verify dark theme attributes again
  assert.equal(window.document.documentElement.getAttribute('data-theme'), 'dark', 'documentElement data-theme must be dark after second toggle');
  assert.equal(icon.getAttribute('data-lucide'), 'sun', 'icon data-lucide must be sun in dark mode');
  assert.equal(button.getAttribute('aria-label'), 'Switch to light theme', 'aria-label must be Switch to light theme in dark mode');
  assert.equal(button.getAttribute('aria-pressed'), 'true', 'aria-pressed must be true in dark mode');
  assert.equal(window.localStorage.getItem('theme'), 'dark', 'localStorage theme must be dark');
});

test('UI Consistency - Worksheet font selector options verification', () => {
  const filePath = path.join(VIEWS_DIR, 'worksheet.ejs');
  const content = fs.readFileSync(filePath, 'utf-8');
  const dom = new JSDOM(content);
  const { document } = dom.window;

  const fontStyleSelect = document.getElementById('fontStyle');
  assert.ok(fontStyleSelect, 'Worksheet must contain a select element with id "fontStyle"');

  const options = fontStyleSelect.querySelectorAll('option');
  assert.ok(options.length > 0, 'fontStyle selector must contain option elements');

  const expectedFonts: Record<string, string> = {
    'Times New Roman': "'Times New Roman', Times, serif",
    'Arial': 'Arial, Helvetica, sans-serif',
    'Georgia': 'Georgia, serif',
    'Courier New': "'Courier New', Courier, monospace",
    'Verdana': 'Verdana, Geneva, sans-serif'
  };

  for (const option of options) {
    const text = option.textContent?.trim() || '';
    const val = option.getAttribute('value');
    
    assert.ok(val && val.trim().length > 0, `Option with text "${text}" inside #fontStyle must not have an empty value`);
    
    if (expectedFonts[text] !== undefined) {
      assert.equal(val, expectedFonts[text], `Expected option for "${text}" to have value "${expectedFonts[text]}", but got "${val}"`);
    }
  }

  // Also assert we checked all expected fonts
  const foundTexts = Array.from(options).map(o => o.textContent?.trim() || '');
  for (const font of Object.keys(expectedFonts)) {
    assert.ok(foundTexts.includes(font), `fontStyle selector must contain an option for "${font}"`);
  }
});


test('UI Consistency - Back-and-forth question buttons preserve guarded grading navigation', () => {
  const filePath = path.join(VIEWS_DIR, 'quiz.ejs');
  const content = fs.readFileSync(filePath, 'utf-8');

  assert.ok(
    content.includes('id="question-jump-panel"') && content.includes('id="question-jump-buttons"'),
    'Back-and-forth quizzes must render the question-number navigation panel'
  );
  assert.ok(
    content.includes('function jumpToQuestion(targetIndex)')
      && content.includes('navigateBackAndForth(targetIndex);'),
    'Question-number buttons must use the shared guarded navigation function'
  );
  assert.ok(
    content.includes('function shouldGradeQuestionBeforeNavigation(qIndex)')
      && content.includes('requestQuestionGrade(qIndex)'),
    'Guarded navigation must retain the individual grading request flow'
  );
  assert.ok(
    content.includes('navigateBackAndForth(currentIndex + 1, btnNext)')
      && content.includes('navigateBackAndForth(currentIndex - 1, btnPrev)'),
    'Previous and Next buttons must use the same guarded navigation path as question-number buttons'
  );
  assert.ok(
    !content.includes("question-jump-btn.correct") && !content.includes("question-jump-btn.incorrect"),
    'Question-number navigation must not reveal correctness in back-and-forth mode'
  );
});
