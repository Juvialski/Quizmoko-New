import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { verifyQuestionBatch } from '../src/services/aiQuestionVerifier.ts';
import { normalizeQuestionForStorage } from '../src/services/grading.ts';
import { worksheetSourceIdentifiersEqual } from '../src/services/worksheetSourceOrder.ts';
import { runBoundedWorksheetModelRequest } from '../src/services/worksheetSolver.ts';

const gold = JSON.parse(fs.readFileSync('test/fixtures/ai-quality-gold.json', 'utf8'));
const review = JSON.parse(fs.readFileSync('test/fixtures/ai-quality-review.json', 'utf8'));

test('expanded corpus has at least 100 questions and independently checks arithmetic oracle answers', () => {
  assert.ok(gold.length >= 100);
  assert.equal(new Set(gold.map((q: any) => q.id)).size, gold.length);
  for (const question of gold) {
    assert.equal(normalizeQuestionForStorage(question).valid, true, question.id);
    const oracle = question.oracle;
    if (!oracle) continue;
    const [a, b, c, d] = oracle.args;
    const calculated = oracle.op === 'sum' ? a + b : oracle.op === 'linear' ? (c - b) / a
      : oracle.op === 'fractionSum' ? a / b + c / d : oracle.op === 'percent' ? a * b / 100
      : oracle.op === 'product' ? a * b : oracle.op === 'slope' ? (d - b) / (c - a)
      : oracle.op === 'mean' ? oracle.args.reduce((x: number, y: number) => x + y, 0) / oracle.args.length
      : oracle.op === 'coin' ? Math.pow(0.5, a) : NaN;
    assert.equal(Number(question.answer), calculated, question.id);
  }
  for (const id of ['7a', '7b', '10(i)', '10(ii)', 'A-3']) {
    assert.ok(gold.some((q: any) => q.source_id === id));
  }
  assert.equal(worksheetSourceIdentifiersEqual('7a', '7b'), false);
});

test('offline full corpus verifies with exact coverage and gold never enters solver prompts', async () => {
  let requests = 0;
  const output = await verifyQuestionBatch({ questions: gold, ai: { models: { async generateContent(request: any) {
    requests++;
    const prompt = String(request.contents[0]);
    assert.ok(!prompt.includes('"answer":'));
    assert.ok(!prompt.includes('"solution":'));
    assert.ok(!prompt.includes('"oracle":'));
    return { text: JSON.stringify(gold.map((q: any) => ({ id: q.id, answer: q.answer, solution: 'Checked from the stated information.', confidence: 'high' }))) };
  } } } });
  assert.equal(requests, 2);
  assert.equal(output.modelFailures.length, 0);
  for (let i = 0; i < gold.length; i++) {
    assert.equal(output.questions[i].verification.verification_status, 'verified', gold[i].id);
    assert.deepEqual(normalizeQuestionForStorage(output.questions[i]).normalized.answer,
      normalizeQuestionForStorage(gold[i]).normalized.answer, gold[i].id);
  }
});

test('ambiguous, unsolvable, absent diagrams, golden conflicts, malformed output and LaTeX fail closed', async () => {
  for (const q of review) {
    const output = await verifyQuestionBatch({ questions: [q],
      ...(q.scenario === 'golden_conflict' ? { authoritativeAnswers: { [q.id]: q.answer } } : {}),
      ai: { models: { async generateContent() {
        if (q.scenario === 'malformed') return { text: 'not json' };
        return { text: JSON.stringify([{ id: q.id, answer: q.scenario === 'golden_conflict' ? '5' : q.answer,
          solution: 'Insufficient evidence or teacher review required.', confidence: q.scenario === 'low_confidence' ? 'low' : 'high' }]) };
      } } }
    });
    assert.equal(output.questions[0].verification.verification_status, q.expected_status, q.id);
    if (q.scenario === 'golden_conflict') assert.equal(output.questions[0].answer, '4');
  }
});

test('worksheet request timeout bounds a provider that ignores cancellation', async () => {
  const started = Date.now();
  await assert.rejects(runBoundedWorksheetModelRequest({ label: 'ignored abort', deadlineAt: Date.now() + 500,
    timeoutMs: 20, maxAttempts: 1, operation: () => new Promise(() => {}) }), /failed/);
  assert.ok(Date.now() - started < 500);
});
