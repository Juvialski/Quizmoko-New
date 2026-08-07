import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { describe, test } from 'node:test';
import {
  buildAiTaskConfig,
  getFlashLiteModelPair,
  PRIMARY_FLASH_LITE_MODEL,
  PEER_FLASH_LITE_MODEL
} from '../src/services/aiTaskProfiles.ts';
import { verifyQuestionBatch } from '../src/services/aiQuestionVerifier.ts';
import { normalizeQuestionForStorage } from '../src/services/grading.ts';
import { getRealModelName } from '../src/services/gemini.ts';
import {
  configureGeminiRateLimiterForTests,
  generateGeminiContent,
  resetGeminiRateLimiterForTests
} from '../src/services/geminiRateLimiter.ts';
import {
  SHARED_LATEX_RULES,
  getSubjectPromptMode,
  getSubjectPromptRules,
  shouldUseStrictMathFormatting
} from '../prompts.ts';
import * as promptTemplates from '../prompts.ts';
import {
  normalizeAiLatexText,
  normalizeMathQuestionText,
  normalizeQuestionLayoutText,
  stripDuplicatedChoiceBlock,
  stripRedundantOptionPrefix,
  validateLatexText,
  validateQuestionLatex
} from '../src/services/latex.ts';
import { buildTikzRequirementPlan, hasTikzDiagram, validateTikzRequirement } from '../src/services/tikzGeneration.ts';
import {
  applyLatexPatches,
  createLatexPatchRequests,
  isSafeLatexReplacement,
  latexFieldHash
} from '../src/services/latexPatches.ts';

function multipleChoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'q1',
    question: 'What is $2+3$?',
    options: ['A) 4', 'B) 5', 'C) 6', 'D) 7'],
    answer: 'B',
    solution: '$2+3=5$.',
    type: 'multiple_choice',
    ...overrides
  };
}

function solverResult(
  answer: string,
  solution = 'The correct option follows from a direct check.',
  confidence: 'high' | 'medium' | 'low' = 'high'
) {
  return [{ id: 'q1', answer, solution, confidence }];
}

function mockAi(respond: (request: any, call: number) => unknown | Promise<unknown>) {
  let call = 0;
  return {
    models: {
      async generateContent(request: any) {
        call += 1;
        const output = await respond(request, call);
        return { text: JSON.stringify(output) };
      }
    }
  };
}


describe('subject-aware prompt policy', () => {
  test('does not default Science, Computer Science, or humanities to strict Math formatting', () => {
    assert.equal(getSubjectPromptMode('Math'), 'math');
    assert.equal(getSubjectPromptMode('Science'), 'science');
    assert.equal(getSubjectPromptMode('Physics'), 'science');
    assert.equal(getSubjectPromptMode('Computer Science'), 'technical');
    assert.equal(getSubjectPromptMode('Economics'), 'technical');
    assert.equal(getSubjectPromptMode('English'), 'plain');
    assert.equal(getSubjectPromptMode('History'), 'plain');
    assert.equal(getSubjectPromptMode('Geography'), 'plain');
    assert.equal(getSubjectPromptMode('Biology'), 'plain');
  });

  test('keeps prose numbers plain outside Math while allowing General to detect clear Math content', () => {
    assert.equal(shouldUseStrictMathFormatting('Science', '', 'Water boils at 100 degrees Celsius.'), false);
    assert.equal(shouldUseStrictMathFormatting('History', '', 'The war ended in 1945.'), false);
    assert.equal(shouldUseStrictMathFormatting('Computer Science', '', 'HTTP 404 indicates a missing resource.'), false);
    assert.equal(shouldUseStrictMathFormatting('General', '', 'The war ended in 1945.'), false);
    assert.equal(shouldUseStrictMathFormatting('General', '', 'The ratio is 2 to 5. How many are needed?'), true);
    assert.equal(shouldUseStrictMathFormatting('General', 'Fractions'), true);
  });

  test('uses subject-specific quality rules instead of the Math rules for other subjects', () => {
    const science = getSubjectPromptRules('Science');
    const history = getSubjectPromptRules('History');
    const computing = getSubjectPromptRules('Computer Science');
    assert.match(science, /SCIENCE \/ STEM/);
    assert.match(science, /units and accepted scientific conventions/i);
    assert.match(history, /Never fabricate quotations, citations/i);
    assert.match(computing, /Never insert LaTeX delimiters inside code-like text/i);
    assert.doesNotMatch(science, /EVERY standalone numeric value/);
    assert.doesNotMatch(history, /EVERY standalone numeric value/);
  });
});

describe('exact TikZ diagram generation contract', () => {
  test('spreads the exact requested diagram count across the quiz', () => {
    const plan = buildTikzRequirementPlan(10, 2);
    assert.equal(plan.length, 10);
    assert.equal(plan.filter(Boolean).length, 2);
    assert.deepEqual(plan.map((value, index) => value ? index + 1 : 0).filter(Boolean), [3, 8]);
    assert.equal(buildTikzRequirementPlan(10, 0).filter(Boolean).length, 0);
    assert.equal(buildTikzRequirementPlan(3, 9).filter(Boolean).length, 3);
  });

  test('requires exactly one usable base-TikZ block only on assigned questions', () => {
    const valid = String.raw`Read the graph. [TIKZ]\begin{tikzpicture}\draw[->] (-2,0)--(2,0);\draw[domain=-1:1,samples=20] plot (\x,{\x*\x});\end{tikzpicture}[/TIKZ]`;
    assert.equal(hasTikzDiagram(valid), true);
    assert.equal(validateTikzRequirement(valid, true).valid, true);
    assert.equal(validateTikzRequirement('No diagram here.', true).valid, false);
    assert.equal(validateTikzRequirement(valid, false).valid, false);
    assert.equal(validateTikzRequirement(String.raw`[TIKZ]\begin{axis}\addplot coordinates {(0,0) (1,1)};\end{axis}[/TIKZ]`, true).valid, false);
  });

  test('generator prompt treats diagram count as exact and uses diagram_required flags', () => {
    assert.match(promptTemplates.STRUCTURED_QUIZ_GENERATOR_PROMPT, /exactly \{images_count\}/i);
    assert.match(promptTemplates.STRUCTURED_QUIZ_GENERATOR_PROMPT, /diagram_required="yes"/i);
    assert.match(promptTemplates.STRUCTURED_QUIZ_GENERATOR_PROMPT, /BASE TIKZ ONLY/i);
  });
});

describe('AI task profiles and model restriction', () => {
  test('uses only the two supported hosted Flash-Lite models', () => {
    assert.deepEqual(getFlashLiteModelPair(), [PRIMARY_FLASH_LITE_MODEL, PEER_FLASH_LITE_MODEL]);
    assert.deepEqual(getFlashLiteModelPair(PEER_FLASH_LITE_MODEL), [PEER_FLASH_LITE_MODEL, PRIMARY_FLASH_LITE_MODEL]);
    assert.equal(getRealModelName('gemini-3.1-flash-lite'), PEER_FLASH_LITE_MODEL);
    assert.equal(getRealModelName('gemini-2.5-flash'), PRIMARY_FLASH_LITE_MODEL);
    assert.equal(getRealModelName('gemini-3.5-pro'), PRIMARY_FLASH_LITE_MODEL);
    assert.equal(getRealModelName('ollama:qwen'), 'ollama:qwen');
  });

  test('assigns maximum high thinking to every AI task', () => {
    assert.deepEqual((buildAiTaskConfig('document_extraction') as any).thinkingConfig, { thinkingLevel: 'high' });
    assert.deepEqual((buildAiTaskConfig('question_solving') as any).thinkingConfig, { thinkingLevel: 'high' });
    assert.deepEqual((buildAiTaskConfig('semantic_grading') as any).thinkingConfig, { thinkingLevel: 'high' });
    assert.deepEqual((buildAiTaskConfig('answer_key_extraction') as any).thinkingConfig, { thinkingLevel: 'high' });
    assert.deepEqual((buildAiTaskConfig('latex_polish') as any).thinkingConfig, { thinkingLevel: 'high' });
  });
});

describe('LaTeX validation and guarded formatting patches', () => {
  test('normalizes supported delimiters without corrupting n-prefixed commands', () => {
    assert.equal(normalizeAiLatexText('Solve \\(x+1=3\\).'), 'Solve $x+1=3$.');
    assert.equal(normalizeAiLatexText('$x \\neq 2$'), '$x \\neq 2$');
    assert.equal(normalizeAiLatexText('$\\nabla f$'), '$\\nabla f$');
  });

  test('decodes double-escaped model newlines while preserving LaTeX n-commands', () => {
    assert.equal(
      normalizeQuestionLayoutText(String.raw`Generalize Simplify.\n$\dfrac{x^3}{x^4}$`),
      'Generalize Simplify.\n$\\dfrac{x^3}{x^4}$'
    );
    assert.equal(
      normalizeQuestionLayoutText(String.raw`Use $x \neq 2$ and $\nabla f$.`),
      String.raw`Use $x \neq 2$ and $\nabla f$.`
    );
    assert.equal(
      normalizeQuestionLayoutText(String.raw`In Python, what does \n represent?`),
      String.raw`In Python, what does \n represent?`
    );
  });

  test('places genuine multi-part questions on separate lines without splitting initials', () => {
    assert.equal(
      normalizeQuestionLayoutText('A stem? a. First part? b. Second part.'),
      'A stem?\na. First part?\nb. Second part.'
    );
    assert.equal(
      normalizeQuestionLayoutText('Compute each. (i) First item. (ii) Second item.'),
      'Compute each.\n(i) First item.\n(ii) Second item.'
    );
    assert.equal(
      normalizeQuestionLayoutText('Dr. A. Smith met B. Jones in 1945.'),
      'Dr. A. Smith met B. Jones in 1945.'
    );
  });

  test('normalizes LaTeX-styled multipart letters to plain labels and line breaks', () => {
    assert.equal(
      normalizeQuestionLayoutText(String.raw`Write each as a fraction and decimal: $\mathbf{a}$. $99\%$ $\mathbf{b}$. $\dfrac{180}{360}$`),
      String.raw`Write each as a fraction and decimal:
a. $99\%$
b. $\dfrac{180}{360}$`
    );
    assert.equal(
      normalizeQuestionLayoutText(String.raw`Use $\mathbf{x}$ in the expression.`),
      String.raw`Use $\mathbf{x}$ in the expression.`
    );
  });

  test('removes duplicated structured choice blocks from the end of question stems', () => {
    const stem = String.raw`The number $-\dfrac{1}{2}$ is a member of which sets of numbers? A real numbers B integers C rational numbers D irrational numbers`;
    const expected = String.raw`The number $-\dfrac{1}{2}$ is a member of which sets of numbers?`;
    assert.equal(
      stripDuplicatedChoiceBlock(stem, ['real numbers', 'integers', 'rational numbers', 'irrational numbers']),
      expected
    );
    assert.equal(
      stripDuplicatedChoiceBlock(stem, ['A) real numbers', 'B) integers', 'C) rational numbers', 'D) irrational numbers']),
      expected
    );
    assert.equal(
      stripDuplicatedChoiceBlock('Which statement about option A is true?', ['One', 'Two', 'Three', 'Four']),
      'Which statement about option A is true?'
    );
  });

  test('strips redundant option labels while preserving legitimate option content', () => {
    assert.equal(stripRedundantOptionPrefix('A) 50', 0), '50');
    assert.equal(stripRedundantOptionPrefix('B. $60$', 1), '$60$');
    assert.equal(stripRedundantOptionPrefix('Option C: rational numbers', 2), 'rational numbers');
    assert.equal(stripRedundantOptionPrefix('(D) irrational numbers', 3), 'irrational numbers');
    assert.equal(stripRedundantOptionPrefix('A-rated bonds', 0), 'A-rated bonds');
    assert.equal(stripRedundantOptionPrefix('B) intentionally starts with B', 0), 'B) intentionally starts with B');
  });

  test('wraps every standalone number in math-facing text without corrupting existing LaTeX, HTML, or TikZ', () => {
    assert.equal(
      normalizeMathQuestionText('Of the 1800 people, 3 groups had 12 students each.'),
      'Of the $1800$ people, $3$ groups had $12$ students each.'
    );
    assert.equal(
      normalizeMathQuestionText('The ratio was 2 to 5 and the trip took 90 minutes.'),
      'The ratio was $2$ to $5$ and the trip took $90$ minutes.'
    );
    assert.equal(
      normalizeMathQuestionText('Use 1/2 of 25%.'),
      String.raw`Use $\dfrac{1}{2}$ of $25\%$.`
    );
    assert.equal(
      normalizeMathQuestionText(String.raw`The number $-\dfrac{1}{2}$ is rational.`),
      String.raw`The number $-\dfrac{1}{2}$ is rational.`
    );
    assert.equal(
      normalizeMathQuestionText('<div style="width: 100%">Diagram</div> Find 8.'),
      '<div style="width: 100%">Diagram</div> Find $8$.'
    );
    assert.equal(
      normalizeMathQuestionText(String.raw`[TIKZ]\draw (0,0)--(2,3);[/TIKZ] Find 5.`),
      String.raw`[TIKZ]\draw (0,0)--(2,3);[/TIKZ] Find $5$.`
    );
  });

  test('rejects bare commands, malformed braces, and unbalanced delimiters', () => {
    assert.ok(validateLatexText('Use \\dfrac{1}{2}.').some(issue => issue.code === 'bare_latex_command'));
    assert.ok(validateLatexText('$\\dfrac{1}{2$').some(issue => issue.code === 'unbalanced_brace'));
    assert.ok(validateLatexText('Find $x+1.').some(issue => issue.code === 'unbalanced_delimiter'));
    assert.equal(validateQuestionLatex(multipleChoice()).length, 0);
  });

  test('accepts formatting-only patches and rejects changed values or stale hashes', () => {
    assert.equal(isSafeLatexReplacement('Compute 1/2 + 1/4.', 'Compute $\\dfrac{1}{2}+\\dfrac{1}{4}$.') , true);
    assert.equal(isSafeLatexReplacement('Compute 1/2.', 'Compute $\\dfrac{2}{3}$.') , false);

    const original = multipleChoice({ question: 'Compute 1/2 + 1/4.' });
    const request = createLatexPatchRequests([original]).find(item => item.field === 'question');
    assert.ok(request);
    const applied = applyLatexPatches([original], [{
      id: 'q1',
      field: 'question',
      original_hash: request!.original_hash,
      replacement: 'Compute $\\dfrac{1}{2}+\\dfrac{1}{4}$.'
    }]);
    assert.equal(applied.applied, 1);
    assert.equal(applied.questions[0].question, 'Compute $\\dfrac{1}{2}+\\dfrac{1}{4}$.');

    const changed = applyLatexPatches([original], [{
      id: 'q1',
      field: 'question',
      original_hash: latexFieldHash(original.question),
      replacement: 'Compute $\\dfrac{2}{3}$.'
    }]);
    assert.equal(changed.applied, 0);
    assert.match(changed.rejected[0].reason, /changes content/i);

    const stale = applyLatexPatches([original], [{
      id: 'q1',
      field: 'question',
      original_hash: 'stale',
      replacement: 'Compute $\\dfrac{1}{2}+\\dfrac{1}{4}$.'
    }]);
    assert.equal(stale.applied, 0);
    assert.match(stale.rejected[0].reason, /hash/i);
  });

  test('browser normalizer preserves LaTeX commands and neutralizes broken dollar pairs', () => {
    const source = fs.readFileSync('public/js/math-display.js', 'utf8');
    const context: any = {
      window: { setTimeout() {} },
      document: {},
      console,
      Promise,
      NodeFilter: { SHOW_TEXT: 4 }
    };
    vm.runInNewContext(source, context);
    const math = context.window.QuizMoKoMath;
    assert.equal(math.decodeLegacyNewlines('Use $x \\neq 2$.'), 'Use $x \\neq 2$.');
    assert.equal(math.decodeLegacyNewlines('Line one\\nLine two'), 'Line one\nLine two');
    assert.equal(math.normalizeLatexText('Solve \\(x=2\\).'), 'Solve $x=2$.');
    assert.equal(math.latexDelimitersAreBalanced('Find $x+1.'), false);
    assert.equal(math.normalizeLatexText('Find $x+1.'), 'Find \\$x+1.');
  });
});

describe('dual-model question verification', () => {
  test('verifies only when both independent solvers agree', async () => {
    const ai = mockAi(() => solverResult('B'));
    const result = await verifyQuestionBatch({ ai, questions: [multipleChoice()] });
    assert.equal(result.questions[0].answer, 'B');
    assert.equal(result.questions[0].verification.verification_status, 'verified');
    assert.equal(result.questions[0].verification.method, 'dual_agreement');
    assert.deepEqual(result.reviewRequiredIds, []);
  });

  test('requires high confidence from both agreeing solvers', async () => {
    let call = 0;
    const ai = mockAi(() => {
      call += 1;
      return call === 1 ? solverResult('B') : solverResult('B', 'Same answer with uncertainty.', 'medium');
    });
    const result = await verifyQuestionBatch({ ai, questions: [multipleChoice()] });
    assert.equal(result.questions[0].answer, 'B');
    assert.equal(result.questions[0].verification.verification_status, 'review_required');
    assert.deepEqual(result.reviewRequiredIds, ['q1']);
  });

  test('uses blind high-confidence adjudication for solver disagreement', async () => {
    const ai = mockAi((_request, call) => {
      if (call === 1) return solverResult('B', 'Candidate one check.');
      if (call === 2) return solverResult('C', 'Candidate two check.');
      return [{
        id: 'q1',
        decision: 'candidate_a',
        corrected_answer: '',
        corrected_solution: '',
        confidence: 'high',
        reason: 'Candidate A matches the independently computed value.'
      }];
    });
    const result = await verifyQuestionBatch({ ai, questions: [multipleChoice()] });
    assert.equal(result.questions[0].answer, 'B');
    assert.equal(result.questions[0].verification.verification_status, 'verified');
    assert.equal(result.questions[0].verification.method, 'adjudicated');
  });

  test('retries a solver once after invalid structured coverage', async () => {
    const attempts = new Map<string, number>();
    const ai = mockAi((request) => {
      const count = (attempts.get(request.model) || 0) + 1;
      attempts.set(request.model, count);
      if (request.model === PRIMARY_FLASH_LITE_MODEL && count === 1) return [];
      return solverResult('B');
    });
    const result = await verifyQuestionBatch({ ai, questions: [multipleChoice()] });
    assert.equal(attempts.get(PRIMARY_FLASH_LITE_MODEL), 2);
    assert.equal(result.questions[0].verification.verification_status, 'verified');
    assert.equal(result.questions[0].verification.method, 'dual_agreement');
  });

  test('fails closed when only one solver succeeds', async () => {
    const ai = mockAi((request) => {
      if (request.model === PEER_FLASH_LITE_MODEL) throw new Error('peer unavailable');
      return solverResult('B');
    });
    const result = await verifyQuestionBatch({ ai, questions: [multipleChoice()] });
    assert.equal(result.questions[0].verification.verification_status, 'review_required');
    assert.deepEqual(result.reviewRequiredIds, ['q1']);
    assert.equal(result.modelFailures.length, 1);
  });

  test('preserves an authoritative key but requires review on solver conflict', async () => {
    const ai = mockAi(() => solverResult('C'));
    const result = await verifyQuestionBatch({
      ai,
      questions: [multipleChoice()],
      authoritativeAnswers: { q1: 'B' }
    });
    assert.equal(result.questions[0].answer, 'B');
    assert.equal(result.questions[0].verification.answer_source, 'golden_key');
    assert.equal(result.questions[0].verification.verification_status, 'review_required');
  });

  test('never verifies structurally valid answers with invalid LaTeX', async () => {
    const ai = mockAi(() => solverResult('B'));
    const result = await verifyQuestionBatch({
      ai,
      questions: [multipleChoice({ question: 'What is \\frac{2}{1} + 3?' })]
    });
    assert.equal(result.questions[0].verification.verification_status, 'review_required');
    assert.ok(result.questions[0].verification.issues.some((issue: any) => issue.code === 'latex_bare_latex_command'));
  });
});


test('gold evaluation fixture has unique valid canonical questions', () => {
  const fixture = JSON.parse(fs.readFileSync('test/fixtures/ai-quality-gold.json', 'utf8'));
  assert.equal(Array.isArray(fixture), true);
  assert.ok(fixture.length >= 20);
  const ids = new Set<string>();
  for (const question of fixture) {
    assert.equal(ids.has(question.id), false, `Duplicate gold id ${question.id}`);
    ids.add(question.id);
    const normalized = normalizeQuestionForStorage(question);
    assert.equal(normalized.valid, true, `${question.id}: ${normalized.errors?.[0]?.message || 'invalid'}`);
    assert.deepEqual(validateQuestionLatex(normalized.question), [], `${question.id} has invalid LaTeX`);
  }
});

test('prompt templates preserve literal LaTeX commands and JSON newline examples', () => {
  assert.match(SHARED_LATEX_RULES, /\\dfrac/);
  assert.match(SHARED_LATEX_RULES, /\\text\{\\\$40\}/);
  assert.match(SHARED_LATEX_RULES, /encode line breaks as \\n/);
  assert.doesNotMatch(SHARED_LATEX_RULES, /	(?:imes|ext)/);
});

test('raw prompt templates do not send doubled command backslashes', () => {
  const doubledPrefixes = ['\\\\n', '\\\\dfrac', '\\\\sqrt', '\\\\begin', '\\\\end'];
  for (const [name, value] of Object.entries(promptTemplates)) {
    if (typeof value !== 'string') continue;
    for (const prefix of doubledPrefixes) {
      assert.equal(value.includes(prefix), false, `${name} contains a doubled runtime backslash`);
    }
  }
});

test('active math prompts require standalone numeric values to use LaTeX delimiters', () => {
  const prompts = fs.readFileSync('prompts.ts', 'utf8');
  assert.doesNotMatch(prompts, /real newline inside a JSON string/i);
  assert.match(prompts, /EVERY standalone numeric value must be enclosed in \$\.\.\.\$/i);
  assert.match(prompts, /ratio \$2\$ to \$5\$/i);
  assert.match(prompts, /encode line breaks as \\n/i);
  assert.match(prompts, /options array must contain ONLY the option content/i);
  assert.doesNotMatch(prompts, /Prefix options A\), B\), C\), and D\)/i);
});

test('quiz UI renders choice labels once and restores multi-select by option index', () => {
  const view = fs.readFileSync('views/quiz.ejs', 'utf8');
  assert.match(view, /const optionKey = String\.fromCharCode\(65 \+ optIdx\)/);
  assert.match(view, /const displayOption = String\(o \?\? ''\)\.replace/);
  assert.match(view, /const letter = String\.fromCharCode\(65 \+ optIdx\)/);
});

test('teacher content edits invalidate stale AI verification until explicit approval', () => {
  const view = fs.readFileSync('views/edit_quiz.ejs', 'utf8');
  assert.match(view, /function markQuestionNeedsReview/);
  assert.match(view, /Question text changed after verification/);
  assert.match(view, /An answer choice changed after verification/);
  assert.match(view, /The answer changed and is pending explicit teacher approval/);
  assert.match(view, /approveQuestionAnswer\(\$\{index\}\)/);
  assert.match(view, /function approveAllQuestionAnswers/);
  assert.match(view, /function updateApproveAllButtonState/);
  assert.match(view, /teacher_approved:\s*true/);
  assert.match(view, /✓ APPROVED/);
  assert.match(view, /multiple_choice_multi/);
  assert.match(view, /JSON\.parse\(raw\)/);
  assert.doesNotMatch(
    view,
    /ansInput\.oninput[\s\S]{0,450}verification_status:\s*'verified'/,
    'Typing an answer must not silently mark it verified.'
  );
  assert.doesNotMatch(view, /ansInput\.onchange\s*=\s*\(\)\s*=>\s*approveQuestionAnswer/);
});

describe('per-model Gemini RPM guard', { concurrency: false }, () => {
  test('queues calls beyond a model cap but keeps model buckets independent', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      resetGeminiRateLimiterForTests();
      configureGeminiRateLimiterForTests({
        windowMs: 120,
        rpm: 2,
        reserve: 0,
        maxQueueWaitMs: 2_000
      });
      const starts: Array<{ model: string; at: number }> = [];
      const client = {
        models: {
          async generateContent(request: any) {
            starts.push({ model: request.model, at: Date.now() });
            return { text: '{}' };
          }
        }
      };

      await Promise.all([
        generateGeminiContent(client, { model: PRIMARY_FLASH_LITE_MODEL }),
        generateGeminiContent(client, { model: PRIMARY_FLASH_LITE_MODEL }),
        generateGeminiContent(client, { model: PRIMARY_FLASH_LITE_MODEL })
      ]);
      assert.ok(starts[2].at - starts[0].at >= 100, 'The third same-model request must wait for the rolling window.');

      resetGeminiRateLimiterForTests();
      configureGeminiRateLimiterForTests({
        windowMs: 500,
        rpm: 1,
        reserve: 0,
        maxQueueWaitMs: 2_000
      });
      starts.length = 0;
      await Promise.all([
        generateGeminiContent(client, { model: PRIMARY_FLASH_LITE_MODEL }),
        generateGeminiContent(client, { model: PEER_FLASH_LITE_MODEL })
      ]);
      assert.ok(
        Math.abs(starts[0].at - starts[1].at) < 100,
        'Different Flash-Lite models must not share one RPM bucket.'
      );
    } finally {
      resetGeminiRateLimiterForTests();
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  test('converts upstream 429 responses into retryable Gemini rate-limit errors', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      resetGeminiRateLimiterForTests();
      configureGeminiRateLimiterForTests({ rpm: 100, reserve: 0 });
      const client = {
        models: {
          async generateContent() {
            const error: any = new Error('quota exceeded');
            error.status = 429;
            error.retryAfterSeconds = 7;
            throw error;
          }
        }
      };
      await assert.rejects(
        () => generateGeminiContent(client, { model: PRIMARY_FLASH_LITE_MODEL }),
        (error: any) => error?.status === 429
          && error?.code === 'GEMINI_RATE_LIMITED'
          && error?.retryAfterSeconds === 7
      );
    } finally {
      resetGeminiRateLimiterForTests();
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });
});

