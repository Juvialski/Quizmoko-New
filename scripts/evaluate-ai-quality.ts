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
const corpus = JSON.parse(fs.readFileSync(fixtureUrl, 'utf8')) as GoldQuestion[];
const limitArg = process.argv.find(arg=>arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.slice(8)) : corpus.length;
if (!Number.isInteger(limit) || limit<1 || limit>corpus.length) throw new Error('Evaluation limit must be a positive integer within the gold corpus.');
const questions = corpus.slice(0,limit);
const live = process.argv.includes('--live');
let requestCount = 0;
let malformedOutputs = 0;
const underlying = live ? getGeminiClient() : {
  models: { async generateContent(request: any) {
    // The mock is a regression oracle. It is not a measurement of Gemini accuracy.
    const prompt = String(request.contents?.[0] || '');
    if (prompt.includes('"answer":') || prompt.includes('"solution":') || prompt.includes('"oracle":')) {
      throw new Error('Gold metadata leaked into solver prompt.');
    }
    return { text: JSON.stringify(questions.map(q => ({ id: q.id, answer: q.answer,
      solution: 'The answer follows from the stated information.', confidence: 'high' }))) };
  } }
};
if (!underlying) throw new Error('Live evaluation requires GEMINI_API_KEY or API_KEY.');
const ai = { models: { async generateContent(request: any) {
  requestCount++;
  const response = await underlying.models.generateContent(request);
  try { JSON.parse(response.text || ''); } catch { malformedOutputs++; }
  return response;
} } };

const startedAt = Date.now();
const result: Awaited<ReturnType<typeof verifyQuestionBatch>> = { questions: [], reviewRequiredIds: [], invalidIds: [], modelFailures: [] };
const batchSize = live ? 10 : questions.length;
for (let offset = 0; offset < questions.length; offset += batchSize) {
  const batch = await verifyQuestionBatch({ ai, questions: questions.slice(offset, offset + batchSize),
    subject: 'Mixed evaluation set', topic: 'QuizMoKo AI quality regression',
    preferredModel: PRIMARY_FLASH_LITE_MODEL, contextLabel: 'gold evaluation; answers are hidden from solvers' });
  result.questions.push(...batch.questions);
  result.reviewRequiredIds.push(...batch.reviewRequiredIds);
  result.invalidIds.push(...batch.invalidIds);
  result.modelFailures.push(...batch.modelFailures);
}
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
  mode: live ? "live Gemini measurement" : "offline mocked regression (not model accuracy)",
  generated_at: new Date().toISOString(),
  elapsed_ms: elapsedMs,
  total: questions.length,
  final_answer_accuracy_percent: percent(finalCorrect, questions.length),
  verified,
  review_required: reviewRequired,
  invalid,
  verified_wrong: verifiedWrong,
  accuracy_among_verified_percent: percent(verified - verifiedWrong, verified),
  review_required_percent: percent(reviewRequired, questions.length),
  adjudication_count: result.questions.filter(q => q.verification?.method === 'adjudicated').length,
  adjudication_percent: percent(result.questions.filter(q => q.verification?.method === 'adjudicated').length, questions.length),
  malformed_output_count: malformedOutputs,
  malformed_output_percent: percent(malformedOutputs, requestCount),
  request_count: requestCount,
  requests_per_accepted_question: verified ? Number((requestCount/verified).toFixed(4)) : null,
  deterministic_validation: Object.fromEntries(['pass','fail','inconclusive'].map(outcome=>[outcome,result.questions.filter(q=>q.qa_metadata?.local_evidence?.mathematical?.outcome===outcome).length])),
  diagram_rendering_failures: null,
  visual_rendering_evaluated: false,
  categories: Object.fromEntries([...new Set(questions.map(q => q.category))].map(category => [category, questions.filter(q => q.category === category).length])),
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

const outputArg = process.argv.find(arg => arg.startsWith('--output='));
if (outputArg) fs.writeFileSync(outputArg.slice('--output='.length), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (!live && (verifiedWrong || finalCorrect !== questions.length || verified !== questions.length)) process.exitCode = 1;
