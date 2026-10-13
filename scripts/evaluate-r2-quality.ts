import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { verifyQuestionBatch } from '../src/services/aiQuestionVerifier.ts';
import { r2Fixtures } from '../test/fixtures/r2-quality.ts';
import { configureGeminiRateLimiterForTests } from '../src/services/geminiRateLimiter.ts';
import { detectPrintedSourceIds } from '../src/services/questionQuality.ts';
import { reconcileWorksheetPages } from '../src/services/worksheetPipeline.ts';

// This is a hermetic comparison against actual R1 verifier source, not invented baseline percentages.
const baselineRef='0925c696f9fc2a0f912312b6060f5572ad57a5a3';
const temporary=resolve(`src/services/.r2-baseline-${process.pid}.ts`);
configureGeminiRateLimiterForTests({rpm:10000,reserve:0});
async function measure(verifier: typeof verifyQuestionBatch) {
  let requests=0;
  const started=performance.now();
  const items=[];
  for (const q of r2Fixtures) {
    const before=requests, at=performance.now();
    const output=await verifier({questions:[q],...('golden' in q?{authoritativeAnswers:{[q.id]:q.golden}}:{}),ai:{models:{async generateContent(request:any) {
      requests++;
      const prompt=String(request.contents[0]);
      if (prompt.includes('"wrong":') || prompt.includes('"expected":') || prompt.includes('"golden":')) throw new Error('Fixture labels leaked into solver prompt.');
      if ('solverAnswers' in q) {
        if(prompt.includes('blind adjudicator')) return {text:JSON.stringify([{id:q.id,decision:'corrected',corrected_answer:q.adjudicatedAnswer,corrected_solution:q.solution,confidence:'high'}])};
        return {text:JSON.stringify([{id:q.id,answer:q.solverAnswers[request.model==='gemini-3.5-flash-lite'?0:1],solution:q.solution,confidence:'high'}])};
      }
      return {text:JSON.stringify([{id:q.id,answer:'solverAnswer' in q?q.solverAnswer:q.answer,solution:q.solution,confidence:'high'}])};
    }}}});
    const actual=output.questions[0];
    items.push({id:q.id,expected:q.expected,status:actual.verification.verification_status,
      known_wrong_answer:'wrong' in q,method:actual.verification.method,
      mathematical:actual.qa_metadata?.local_evidence?.mathematical?.outcome ?? null,
      agreement:actual.qa_metadata?.candidate_answers?.length===2
        && Object.hasOwn(actual.qa_metadata.candidate_answers[0],'answer')
        && Object.hasOwn(actual.qa_metadata.candidate_answers[1],'answer')
        && JSON.stringify(actual.qa_metadata.candidate_answers[0].answer)===JSON.stringify(actual.qa_metadata.candidate_answers[1].answer),
      requests:requests-before,elapsed_ms:Number((performance.now()-at).toFixed(3)),
      issues:actual.verification.issues?.map((i:any)=>i.code) || []});
  }
  const verified=items.filter(i=>i.status==='verified');
  const wrong=verified.filter(i=>i.known_wrong_answer).length;
  const positive=items.filter(i=>i.expected==='verified');
  return {total:items.length,verified:verified.length,verified_wrong:wrong,
    unsafe_verified:verified.filter(i=>i.expected!=='verified').length,
    accuracy_among_verified_percent:verified.length?Number((100*(verified.length-wrong)/verified.length).toFixed(2)):null,
    review_required:items.filter(i=>i.status==='review_required').length,
    false_rejections:positive.filter(i=>i.status!=='verified').length,known_correct:positive.length,
    deterministic:Object.fromEntries(['pass','fail','inconclusive'].map(outcome=>[outcome,items.filter(i=>i.mathematical===outcome).length])),
    solver_agreement_count:items.filter(i=>i.agreement).length,
    adjudication_count:items.filter(i=>i.method==='adjudicated').length,
    adjudication_verified:items.filter(i=>i.method==='adjudicated' && i.status==='verified').length,
    adjudication_success_rate_percent:items.some(i=>i.method==='adjudicated')?100*items.filter(i=>i.method==='adjudicated' && i.status==='verified').length/items.filter(i=>i.method==='adjudicated').length:null,
    diagram_rendering_failures:null,visual_rendering_evaluated:false,
    diagram_source_failures:items.filter(i=>i.issues.includes('invalid_diagram')).length,
    requests,requests_per_accepted_question:verified.length?Number((requests/verified.length).toFixed(3)):null,
    elapsed_ms:Number((performance.now()-started).toFixed(3)),items};
}
let report;
try {
  fs.writeFileSync(temporary,execFileSync('git',['show',`${baselineRef}:src/services/aiQuestionVerifier.ts`],{encoding:'utf8'}));
  const baseline=await import(pathToFileURL(temporary).href);
  const before=await measure(baseline.verifyQuestionBatch),after=await measure(verifyQuestionBatch);
  const detected=detectPrintedSourceIds('21. Calculate\n23. Solve\n7a. Identify');
  const coverage=reconcileWorksheetPages([{page_number:1,source_file:'synthetic.pdf',detected_source_ids:detected,questions:[{original_index:'21',raw_text:'What is $2+3$?'},{original_index:'23',raw_text:'What is $3+4$?'}]}]);
  report={mode:'offline adversarial mocked pipeline comparison; not Gemini accuracy',baseline_ref:baselineRef,
    generated_at:new Date().toISOString(),before,after,
    worksheet_coverage:{detected:detected.length,extracted:coverage.questions.length,missing:coverage.diagnostics.filter(d=>d.code==='review_required').length},
    live_evaluation:'Not run in hermetic offline mode; this script never invokes a live provider.',
    latency_note:'Local wall time includes fixture/mock orchestration, not network/model latency. No visual renderer was invoked.'};
  if(after.verified_wrong || after.unsafe_verified || after.false_rejections) process.exitCode=1;
} finally { fs.unlinkSync(temporary); }
const output=process.argv.find(a=>a.startsWith('--output='));
if(output) fs.writeFileSync(output.slice(9),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
