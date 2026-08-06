import fs from 'node:fs';
import { getGeminiClient } from '../src/services/gemini.ts';
import { verifyQuestionBatch } from '../src/services/aiQuestionVerifier.ts';
import { normalizeQuestionForStorage } from '../src/services/grading.ts';
import {
  PEER_FLASH_LITE_MODEL,
  PRIMARY_FLASH_LITE_MODEL
} from '../src/services/aiTaskProfiles.ts';

interface GoldQuestion {
  id: string;
  category: string;
  question: string;
  options: string[];
  answer: string;
  solution: string;
  type: string;
}

function canonicalAnswer(question: GoldQuestion, answer: unknown): unknown {
  const normalized = normalizeQuestionForStorage({ ...question, answer });
  if (!normalized.valid) throw new Error(`Invalid gold question ${question.id}: ${normalized.errors[0]?.message || 'unknown error'}`);
  return normalized.normalized.answer;
}

function sameAnswer(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const fixtureUrl = new URL('../test/fixtures/ai-quality-gold.json', import.meta.url);
const questions = JSON.parse(fs.readFileSync(fixtureUrl, 'utf8')) as GoldQuestion[];
const ai = getGeminiClient();
if (!ai) {
  throw new Error('Set GEMINI_API_KEY or API_KEY before running npm run eval:ai.');
}

const startedAt = Date.now();
const result = await verifyQuestionBatch({
  ai,
  questions,
  subject: 'Mixed evaluation set',
  topic: 'QuizMoKo AI quality regression',
  preferredModel: PRIMARY_FLASH_LITE_MODEL,
  contextLabel: 'gold evaluation; answers are hidden from solvers'
});
const elapsedMs = Date.now() - startedAt;

const perModel = new Map<string, { correct: number; answered: number }>([
  [PRIMARY_FLASH_LITE_MODEL, { correct: 0, answered: 0 }],
  [PEER_FLASH_LITE_MODEL, { correct: 0, answered: 0 }]
]);
let finalCorrect = 0;
let verified = 0;
let verifiedWrong = 0;
let reviewRequired = 0;
let invalid = 0;
let solverAgreement = 0;
const failures: Array<Record<string, unknown>> = [];

for (let index = 0; index < questions.length; index += 1) {
  const gold = questions[index];
  const output = result.questions[index];
  const expected = canonicalAnswer(gold, gold.answer);
  const outputNormalized = normalizeQuestionForStorage(output);
  const actual = outputNormalized.valid ? outputNormalized.normalized.answer : null;
  const isCorrect = outputNormalized.valid && sameAnswer(actual, expected);
  if (isCorrect) finalCorrect += 1;

  const status = String(output?.verification?.verification_status || 'review_required');
  if (status === 'verified') verified += 1;
  else if (status === 'invalid') invalid += 1;
  else reviewRequired += 1;
  if (status === 'verified' && !isCorrect) verifiedWrong += 1;

  const candidates = Array.isArray(output?.qa_metadata?.candidate_answers)
    ? output.qa_metadata.candidate_answers
    : [];
  const candidateAnswers: unknown[] = [];
  for (const candidate of candidates) {
    const stats = perModel.get(String(candidate?.model || ''));
    if (!stats || !Object.prototype.hasOwnProperty.call(candidate || {}, 'answer')) continue;
    stats.answered += 1;
    candidateAnswers.push(candidate.answer);
    if (sameAnswer(candidate.answer, expected)) stats.correct += 1;
  }
  if (candidateAnswers.length === 2 && sameAnswer(candidateAnswers[0], candidateAnswers[1])) {
    solverAgreement += 1;
  }

  if (!isCorrect || status !== 'verified') {
    failures.push({
      id: gold.id,
      category: gold.category,
      expected,
      actual,
      status,
      reason: output?.verification?.reason || '',
      candidates
    });
  }
}

const percent = (value: number, total: number) => total > 0 ? Number((100 * value / total).toFixed(1)) : 0;
const report = {
  generated_at: new Date().toISOString(),
  elapsed_ms: elapsedMs,
  total: questions.length,
  final_answer_accuracy_percent: percent(finalCorrect, questions.length),
  verified,
  review_required: reviewRequired,
  invalid,
  verified_wrong: verifiedWrong,
  solver_agreement_percent: percent(solverAgreement, questions.length),
  model_accuracy: Object.fromEntries(
    Array.from(perModel, ([model, stats]) => [model, {
      ...stats,
      accuracy_percent: percent(stats.correct, stats.answered)
    }])
  ),
  model_failures: result.modelFailures,
  items_needing_attention: failures
};

console.log(JSON.stringify(report, null, 2));
