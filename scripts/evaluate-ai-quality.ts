import fs from 'node:fs';
import {boundedEvaluationClient,representativeSubset,writeEvaluationReport,EVALUATION_VERSION} from './evaluationSupport.ts';
import {liveQualityFixtures} from '../test/fixtures/r3-live-quality.ts';
import {withRequestAbortSignal} from '../src/services/requestContext.ts';
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
  expected_answer?: string;
  expected_review?: boolean;
  answer_scorable?: boolean;
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
const live = process.argv.includes('--live');
const evaluationCorpus:GoldQuestion[]=live?await liveQualityFixtures(corpus):corpus;
const limitArg = process.argv.find(arg=>arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.slice(8)) : live?20:corpus.length;
if (!Number.isInteger(limit) || limit<1 || limit>evaluationCorpus.length || (live&&limit>20)) throw new Error('Evaluation limit must be within the corpus and at most 20 for live execution.');
const questions = live?representativeSubset(evaluationCorpus,limit):evaluationCorpus.slice(0,limit);
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
const budget = live?boundedEvaluationClient(underlying,60):null;
const ai = { models: { async generateContent(request: any) {
  requestCount++;
  const response = await (budget?.client || underlying).models.generateContent(request);
  try { JSON.parse(response.text || ''); } catch { malformedOutputs++; }
  return response;
} } };

const startedAt = Date.now();
const result: Awaited<ReturnType<typeof verifyQuestionBatch>> = { questions: [], reviewRequiredIds: [], invalidIds: [], modelFailures: [] };
const batchSize = live ? 10 : questions.length;
for (let offset = 0; offset < questions.length; offset += batchSize) {
  if(budget?.signal.aborted)break;
  const selected=questions.slice(offset,offset+batchSize);
  const inputs=selected.map(({expected_answer,expected_review,answer_scorable,...q})=>q);
  const batch = await withRequestAbortSignal(budget?.signal || AbortSignal.timeout(8*60*1000),()=>verifyQuestionBatch({ ai, questions: inputs,
    ...(live?{authoritativeAnswers:Object.fromEntries(selected.filter(q=>q.id==='r3-golden').map(q=>[q.id,q.answer]))}:{}),
    subject: 'Mixed evaluation set', topic: 'QuizMoKo AI quality regression',
    preferredModel: PRIMARY_FLASH_LITE_MODEL, contextLabel: 'gold evaluation; answers are hidden from solvers' }));
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

const measuredQuestions=questions.filter(q=>result.questions.some(r=>r.id===q.id));
const categoryResults:Record<string,{total:number;correct:number;incorrect:number;verified_wrong:number;review_required:number}>={};
let falseAcceptance=0,falseRejection=0;
for (let index = 0; index < measuredQuestions.length; index += 1) {
  const gold = measuredQuestions[index];
  const output = result.questions.find(q=>q.id===gold.id);
  const expected = canonicalAnswer(gold, gold.expected_answer ?? gold.answer);
  const outputNormalized = normalizeQuestionForStorage(output);
  const actual = outputNormalized.valid ? outputNormalized.normalized.answer : null;
  const isCorrect = gold.answer_scorable !== false && outputNormalized.valid && sameAnswer(actual, expected);
  if (isCorrect) finalCorrect += 1;

  const status = String(output?.verification?.verification_status || 'review_required');
  if (status === 'verified') verified += 1;
  else if (status === 'invalid') invalid += 1;
  else reviewRequired += 1;
  if (status === 'verified' && gold.answer_scorable !== false && !isCorrect) verifiedWrong += 1;
  if(status==='verified'&&gold.expected_review)falseAcceptance++;
  if(status!=='verified'&&!gold.expected_review)falseRejection++;
  const category=categoryResults[gold.category]??={total:0,correct:0,incorrect:0,verified_wrong:0,review_required:0};
  category.total++;category.correct+=Number(isCorrect);category.incorrect+=Number(gold.answer_scorable !== false&&!isCorrect);category.verified_wrong+=Number(status==='verified'&&gold.answer_scorable !== false&&!isCorrect);category.review_required+=Number(status!=='verified');

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
  version:EVALUATION_VERSION,
  mode: live ? "live Gemini measurement" : "offline mocked regression (not model accuracy)",
  generated_at: new Date().toISOString(),
  elapsed_ms: elapsedMs,
  total: measuredQuestions.length,
  requested_questions:questions.length,
  correct:finalCorrect,
  incorrect:measuredQuestions.filter(q=>q.answer_scorable!==false).length-finalCorrect,
  answer_unscorable:measuredQuestions.filter(q=>q.answer_scorable===false).length,
  rate_definitions:{false_acceptance:'Verified expected-review fixture / expected-review fixtures',false_rejection:'Nonverified expected-valid fixture / expected-valid fixtures'},
  false_acceptance_rate: measuredQuestions.filter(q=>q.expected_review).length?falseAcceptance/measuredQuestions.filter(q=>q.expected_review).length:null,
  false_rejection_rate: measuredQuestions.filter(q=>!q.expected_review).length?falseRejection/measuredQuestions.filter(q=>!q.expected_review).length:null,
  category_results:categoryResults,
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
  request_count: budget?budget.stats().actual_requests:requestCount,
  live_budget:budget?.stats()??null,
  aborted:budget?.signal.aborted??false,
  requests_per_accepted_question: verified ? Number(((budget?budget.stats().actual_requests:requestCount)/verified).toFixed(4)) : null,
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
if (outputArg) writeEvaluationReport(outputArg.slice('--output='.length),report,`# AI quality evaluation\n\n${report.mode}.\n\n${report.total} questions; ${finalCorrect} correct final answers; ${verifiedWrong} verified wrong; ${reviewRequired} require review; ${report.request_count} actual requests; ${elapsedMs} ms end to end.\n\nLive results do not establish improvement without a comparable earlier live measurement.`);
console.log(JSON.stringify(report, null, 2));
if (!live && (verifiedWrong || finalCorrect !== questions.length || verified !== questions.length)) process.exitCode = 1;
