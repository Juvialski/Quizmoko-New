import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { gradeSemanticQuestion } from '../src/services/semanticGrading.ts';
import {gradeQuestionLocally} from '../src/services/grading.ts';
import {withRequestAbortSignal} from '../src/services/requestContext.ts';
import { getGeminiClient } from '../src/services/gemini.ts';
import { gradingFixtures,gradingFixtureProvenance } from '../test/fixtures/r3-grading.ts';
import { boundedEvaluationClient, representativeSubset,writeEvaluationReport,EVALUATION_VERSION } from './evaluationSupport.ts';
const live=process.argv.includes('--live');
const baselineRef='9e885e2accec00cdb8f57d5472584ad4ca3fa3d3';
const temporary=resolve(`src/services/.r3-baseline-${process.pid}.ts`);
const temporaryDomain=resolve(`src/services/.r3-domain-${process.pid}.ts`);
const underlying=live?getGeminiClient():null;
if(live&&!underlying)throw new Error('Live grading evaluation requires an already available environment key.');
const fixtures=live?representativeSubset(gradingFixtures,20):gradingFixtures;
async function measure(grader:typeof gradeSemanticQuestion,localScorer:typeof gradeQuestionLocally){
  const started=performance.now();let requests=0,failed=0;
  const budget=live?boundedEvaluationClient(underlying):null;
  const items=[];
  for(const fixture of fixtures){
    if(budget?.signal.aborted)break;
    const before=budget?budget.stats().actual_requests:requests,at=performance.now();
    const client=budget?.client || {models:{async generateContent(){requests++;return {text:JSON.stringify(fixture.modelResponse)};}}};
    const local=localScorer(fixture.question,fixture.response,Boolean(fixture.snapshots?.length));
    const outcome=local.gradeStatus==='graded'?{gradeStatus:'graded',scoreFraction:local.scoreFraction,feedback:'Deterministic canonical score.'}
      :await withRequestAbortSignal(budget?.signal || AbortSignal.timeout(8*60*1000),()=>grader({clients:[client],question:fixture.question,studentAnswer:fixture.response,solutionSnapshots:fixture.snapshots,maxModelAttempts:2}));
    const score=outcome.gradeStatus==='graded'?outcome.scoreFraction:undefined;
    const [min,max]=fixture.expected.range;
    const deviation=score===undefined?null:Math.max(min-score,score-max,0);
    const review=outcome.gradeStatus==='pending'||outcome.gradeStatus==='invalid_response';
    if(outcome.gradeStatus==='retryable_error')failed++;
    items.push({id:fixture.id,category:fixture.category,expected:fixture.expected,status:outcome.gradeStatus,score:score??null,
      incorrect_full_credit:score===1&&max<1,incorrect_zero_credit:score===0&&min>0,score_deviation:deviation,
      absolute_score_error:min===max&&score!==undefined?Math.abs(score-min):null,
      false_teacher_review:review&&!fixture.expected.review,expected_review_met:!fixture.expected.review||review,
      rubric_compliant:fixture.question.grading_rubric?deviation===0||review:null,
      requests:(budget?budget.stats().actual_requests:requests)-before,elapsed_ms:performance.now()-at,feedback:outcome.feedback});
  }
  return {total:items.length,incorrect_full_credit:items.filter(i=>i.incorrect_full_credit).length,incorrect_zero_credit:items.filter(i=>i.incorrect_zero_credit).length,
    absolute_score_error:items.reduce((s,i)=>s+(i.absolute_score_error??0),0),range_deviation:items.reduce((s,i)=>s+(i.score_deviation??0),0),
    false_teacher_review:items.filter(i=>i.false_teacher_review).length,missed_review:items.filter(i=>!i.expected_review_met).length,
    invalid_responses:items.filter(i=>i.status==='invalid_response').length,pending:items.filter(i=>i.status==='pending').length,
    rubric_compliance:items.filter(i=>i.rubric_compliant===true).length,rubric_cases:items.filter(i=>i.rubric_compliant!==null).length,
    deterministic_coverage:items.filter(i=>i.status==='graded'&&i.requests===0).length,
    request_count:budget?budget.stats().actual_requests:requests,failures:budget?budget.stats().failures:failed,elapsed_ms:performance.now()-started,
    peak_process_rss_bytes:process.memoryUsage().rss,items};
}
let report:any;
try {
  if(live)report={version:EVALUATION_VERSION,mode:'live Gemini grading measurement',provenance:gradingFixtureProvenance,after:await measure(gradeSemanticQuestion,gradeQuestionLocally)};
  else {
    fs.writeFileSync(temporaryDomain,execFileSync('git',['show',`${baselineRef}:src/services/grading.ts`],{encoding:'utf8'}));
    fs.writeFileSync(temporary,execFileSync('git',['show',`${baselineRef}:src/services/semanticGrading.ts`],{encoding:'utf8'}).replace("'./grading.ts'",`'./.r3-domain-${process.pid}.ts'`));
    const baseline=await import(pathToFileURL(temporary).href);
    const baselineDomain=await import(pathToFileURL(temporaryDomain).href);
    report={version:EVALUATION_VERSION,mode:'offline mocked grading comparison; not Gemini accuracy',baseline_ref:baselineRef,provenance:gradingFixtureProvenance,before:await measure(baseline.gradeSemanticQuestion,baselineDomain.gradeQuestionLocally),after:await measure(gradeSemanticQuestion,gradeQuestionLocally)};
    if(report.after.incorrect_full_credit||report.after.incorrect_zero_credit||report.after.false_teacher_review||report.after.missed_review||report.after.range_deviation)process.exitCode=1;
  }
}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);if(fs.existsSync(temporaryDomain))fs.unlinkSync(temporaryDomain);}
const output=process.argv.find(a=>a.startsWith('--output='));
if(output)writeEvaluationReport(output.slice(9),report,`# R3 grading evaluation\n\n${report.mode}.\n\n${report.after.total} cases; incorrect full credit ${report.after.incorrect_full_credit}, incorrect zero credit ${report.after.incorrect_zero_credit}, deterministic coverage ${report.after.deterministic_coverage}; ${report.after.request_count} requests.\n\nSynthetic expectations await human teacher review. Local mocked latency does not measure Gemini or hosting performance.`);
console.log(JSON.stringify(report,null,2));
