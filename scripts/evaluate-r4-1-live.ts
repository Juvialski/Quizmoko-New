// Explicit opt-in: three extraction calls by default; --extended uses a bounded actual-SDK ledger.
// No production hydration or writes; all detailed output must stay in a private local directory.
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import dotenv from 'dotenv';
import { registerRoutes } from '../src/routes/index.ts';
import { users, quizzes, results } from '../src/store/db.ts';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { getGeminiClient, configureGeminiClientForTests } from '../src/services/gemini.ts';
import { boundedEvaluationClient } from './evaluationSupport.ts';
import { gradingFixtures } from '../test/fixtures/r3-grading.ts';
import { gradeQuestionLocally } from '../src/services/grading.ts';
import { createSessionToken } from '../src/middleware/auth.ts';
import { configureGeminiRateLimiterForTests, getGeminiReliabilitySnapshot } from '../src/services/geminiRateLimiter.ts';

if (!process.argv.includes('--live')) throw new Error('Explicit --live is required');
if (process.env.AI_STUDIO_SANDBOX !== 'true' || process.env.FIREBASE_ADMIN_ENABLED !== 'false') throw new Error('Isolated no-Firestore execution is required');
const option=(name:string)=>process.argv.find(a=>a.startsWith(name+'='))?.slice(name.length+1);
const envFile=option('--env');const sourceFolder=option('--source');const output=option('--output');
if(!envFile||!sourceFolder||!output)throw new Error('--env, --source and private --output are required');
const config=dotenv.parse(await fs.readFile(envFile));
if(!config.GEMINI_API_KEY?.trim())throw new Error('Local Gemini credential is missing');
process.env.GEMINI_API_KEY=config.GEMINI_API_KEY.trim();
const extended=process.argv.includes('--extended');
const budget=extended?boundedEvaluationClient(getGeminiClient(),Math.min(60,Number(option('--budget')) || 54),8*60_000):null;
let observedResponses=0;
if(budget)configureGeminiClientForTests(()=>({models:{generateContent:async(request:any)=>{const response:any=await budget.client.models.generateContent(request);await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,`provider-response-${++observedResponses}.json`),JSON.stringify({model:request.model,text:response.text,candidates:response.candidates?.map((c:any)=>({finishReason:c.finishReason})),usage:response.usageMetadata},null,2));return response;}}}));
configureGeminiRateLimiterForTests({rpm:15,reserve:1,windowMs:60_000,maxQueueWaitMs:180_000});
const samples=[{file:'L12_11-18.png',expected:['11','12','13','14','15','16','17','18'],diagrams:['11','12']},
  {file:'L20_1-7.png',expected:['1','2','3','4','5','6','7'],diagrams:[]},
  {file:'L54 _1-4.png',expected:['1','2','3','4'],diagrams:[]}];
const owner={uid:'local_smoke_teacher',role:'teacher',name:'Local evaluation',email:'local@example.invalid'} as any;users.set(owner.uid,owner);
const app=express();app.use(express.json());registerRoutes(app);
app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status||500).json({success:false,error:'Local extraction failed safely'}));
const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${(server.address() as any).port}`;const token=createSessionToken(owner,30*60_000);
const evidence:any={mode:'live Gemini, private user sample files, isolated local extraction route; no production data',request_cap:budget?budget.stats().request_cap:3,results:[],started_at:new Date().toISOString()};
try {
  await fs.mkdir(output,{recursive:true});
  const extractedSamples:any[]=[];
  if(process.argv.includes('--continuation-only')) {
    const form=new FormData();
    for(const file of ['L20_1-7.png','L20_8-14.png']) form.append('files',new Blob([await fs.readFile(path.join(sourceFolder,file))],{type:'image/png'}),file);
    form.append('subject','Mathematics');
    const response=await fetch(base+'/api/extract_worksheet',{method:'POST',headers:{authorization:'Bearer '+token},body:form});const data=await response.json();
    await fs.writeFile(path.join(output,'continuation-extraction.json'),JSON.stringify(data,null,2));
    const target=(data.questions || []).find((q:any)=>q.original_index==='8');
    evidence.continuation={http_status:response.status,questions:data.questions?.length || 0,incomplete:Boolean(data.incomplete),context_values_preserved:['52','49','48','50','51'].every(n=>String(target?.context_prefix || '').includes(n)),source_provenance_preserved:Boolean(target?.shared_context_source),review_required:Boolean(target?.source_review_required)};
    console.log(JSON.stringify(evidence.continuation));
  }
  for(const [index,sample] of samples.entries()) {
    if(process.argv.includes('--continuation-only')) continue;
    if(process.argv.includes('--skip-extraction')) continue;
    if(option('--sample') && Number(option('--sample'))!==index+1) continue;
    const form=new FormData();const bytes=await fs.readFile(path.join(sourceFolder,sample.file));
    form.append('files',new Blob([bytes],{type:'image/png'}),sample.file);form.append('subject','Mathematics');
    form.append('topic_hint','Preserve the complete worksheet tasks, shared figures and all subparts.');
    const start=performance.now();const response=await fetch(base+'/api/extract_worksheet',{method:'POST',headers:{authorization:'Bearer '+token},body:form,signal:AbortSignal.timeout(240_000)});
    const data=await response.json();
    await fs.writeFile(path.join(output,`sample-${index+1}.json`),JSON.stringify(data,null,2));
    extractedSamples.push(data);
    const ids=(data.questions || []).map((q:any)=>String(q.original_index || q.source?.original_index));
    const actualDiagrams=(data.questions || []).filter((q:any)=>/<img\s/i.test(q.raw_text || q.question || '')).map((q:any)=>String(q.original_index || q.source?.original_index));
    const row={sample:index+1,http_status:response.status,elapsed_ms:Math.round(performance.now()-start),extracted_questions:ids.length,expected_questions:sample.expected.length,
      exact_id_coverage:ids.length===sample.expected.length && sample.expected.every(id=>ids.includes(id)),
      required_diagrams_present:sample.diagrams.every(id=>actualDiagrams.includes(id)),
      incomplete:Boolean(data.incomplete),failed_pages:data.failed_pages?.length || 0,
      number_words_preserved:index===1 ? /\bthree\b[\s\S]*\bten\b/i.test((data.questions || []).find((q:any)=>String(q.original_index)==='3')?.raw_text || '') : null,
      currency_values_preserved: index===0 ? (data.questions || []).find((q:any)=>String(q.original_index)==='14')?.raw_text.includes('168') : index===1 ? ['52','49','48','50','51'].every(n=>(data.questions || []).find((q:any)=>String(q.original_index)==='7')?.raw_text.includes(n)) && (data.questions || []).find((q:any)=>String(q.original_index)==='1')?.raw_text.includes('50.40') : null};
    evidence.results.push(row);console.log(JSON.stringify(row));
    const metrics=Object.values(getGeminiReliabilitySnapshot());
    if(metrics.reduce((sum,m)=>sum+(m.rate_limit||0),0)>0)break;
  }
  if (budget && !budget.signal.aborted) {
    const post=async(url:string,body:any)=>{const response=await fetch(base+url,{method:'POST',headers:{authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:budget.signal});return {http_status:response.status,data:await response.json()};};
    const awaitJob=async(id:string)=>{
      for(let i=0;i<1200&&!budget.signal.aborted;i++) {
        const payload=await(await fetch(base+'/api/tasks/'+id,{headers:{authorization:'Bearer '+token}})).json();
        if (payload.job?.status!=='running')return payload.job;
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      throw new Error('Live job budget elapsed');
    };
    const categories=option('--cases') ? option('--cases')!.split(',') : ['partial method','invalid method correct answer','alternative method','science explanation','student injection','graphical evidence'];
    const fixtures=process.argv.includes('--skip-grading') ? [] : categories.map(category=>{
      if(category!=='explicit method rubric') return gradingFixtures.find(f=>f.category===category)!;
      const original=gradingFixtures.find(f=>f.category==='partial method')!;
      return {...original,category,question:{...original.question,grading_rubric:{version:1,criteria:[
        {id:'method',weight:0.6,description:'Award full method credit when subtracting three from both sides correctly produces 2*x=4. Judge the final value only in the answer criterion; do not deduct its arithmetic error here.'},
        {id:'answer',weight:0.4,description:'Correct final value x=2.'}]}}};
    });
    const quizId='live_semantic_'+randomUUID();
    quizzes.set(quizId,{id:quizId,user_id:owner.uid,title:'Synthetic live grading',quiz_mode:'back_and_forth',questions:fixtures.map((f,i)=>({...f.question,id:'case_'+i}))});
    const generated=process.argv.includes('--skip-generation') ? {http_status:0,data:{job_id:undefined}} : await post('/api/generate_ai',{async_job:true,idempotency_key:randomUUID(),topic:'Basic fractions and linear equations',subject:'Mathematics',num_items:2,batch_size:2,test_type:'Multiple Choice',images_count:0,create_draft:true});
    evidence.generation_acceptance={http_status:generated.http_status,job_id:generated.data.job_id};
    const gradeStart=performance.now();
    const grading=fixtures.map(async(f,index)=>{
      const start=performance.now();const sid='sess_'+randomUUID();
      const result=await post('/api/grade_individual',{quiz_id:quizId,session_id:sid,question_index:index,answer_revision:1,student_answer:f.response,solution_snapshots:f.snapshots,student_name:'Synthetic live case'});
      const score=result.data.score_fraction;
      const row={case:f.category,http_status:result.http_status,grade_status:result.data.grade_status,score_fraction:score ?? null,
        expected_range:f.expected.range,within_expected_range:typeof score==='number' ? score>=f.expected.range[0]&&score<=f.expected.range[1] : null,elapsed_ms:Math.round(performance.now()-start)};
      await fs.writeFile(path.join(output,`grading-${index+1}.json`),JSON.stringify(result,null,2));return row;
    });
    await new Promise(resolve=>setTimeout(resolve,500));
    const snapshot=await(await fetch(base+'/api/live/'+quizId,{headers:{authorization:'Bearer '+token}})).json();
    evidence.concurrent_pending_observed=Object.values(snapshot.sessions || {}).filter((s:any)=>s.pending_grades>0).length;
    evidence.grading=await Promise.all(grading);evidence.concurrent_grading_elapsed_ms=Math.round(performance.now()-gradeStart);
    if(generated.data.job_id) {
      const job=await awaitJob(generated.data.job_id);const quiz=quizzes.get(job.quiz_id);
      evidence.generation={status:job.status,questions:quiz?.questions.length || 0,private_draft:quiz?.is_draft===true,verification:quiz?.verification_summary};
      await fs.writeFile(path.join(output,'generated-draft.json'),JSON.stringify(quiz,null,2));
    }
    const retainedSource=option('--worksheet-source') ? JSON.parse(await fs.readFile(option('--worksheet-source')!,'utf8')) : extractedSamples[0];
    const source=(retainedSource?.questions || []).slice(0,6);
    if(source.length && !budget.signal.aborted && !process.argv.includes('--skip-worksheet')) {
      const accepted=await post('/api/solve_worksheet',{async_job:true,idempotency_key:randomUUID(),questions:source,batch_size:3,subject:'Mathematics',topic:'Geometry and arithmetic worksheet',create_draft:true});
      if(accepted.data.job_id) {
        const job=await awaitJob(accepted.data.job_id);const quiz=quizzes.get(job.quiz_id);
        const expected:Record<string,string>={'11':'28','12':'34','13':'8','14':'21','15':'36'};
        evidence.worksheet_solving={status:job.status,questions:quiz?.questions.length || 0,private_draft:quiz?.is_draft===true,
          items:(quiz?.questions || []).map((q:any)=>{const id=String(q.source?.original_index || q.original_index || q.id);const score=expected[id]?gradeQuestionLocally({...q,type:'identification',answer:expected[id]},q.answer,false):null;return {source_id:id,verification:q.verification?.verification_status,expected_numeric_answer_matched:score?.scoreFraction===1,compound_response_requires_teacher_review:!expected[id]};})};
        await fs.writeFile(path.join(output,'solved-draft.json'),JSON.stringify(quiz,null,2));
      } else evidence.worksheet_solving={http_status:accepted.http_status,status:'not_accepted'};
    }
    if(process.argv.includes('--cancel-case') && !budget.signal.aborted) {
      const id='live_cancel_'+randomUUID();quizzes.set(id,{id,user_id:owner.uid,title:'Synthetic cancellation',questions:[{question:'Explain why liquid water evaporates.',type:'open_ended',answer:'Surface molecules with sufficient kinetic energy escape.'}]});
      const sid='sess_'+randomUUID();const body={quiz_id:id,session_id:sid,question_index:0,answer_revision:1,student_answer:'Energetic surface molecules escape into the gas phase.'};
      const controller=new AbortController();
      const pending=fetch(base+'/api/grade_individual',{method:'POST',headers:{authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal}).catch(()=>null);
      await new Promise(resolve=>setTimeout(resolve,750));controller.abort();await pending;await new Promise(resolve=>setTimeout(resolve,150));
      const saved=results.get('res_'+sid);const detail=saved?.graded_details?.[0];
      const retry=await post('/api/grade_individual',body);
      evidence.cancellation={answer_preserved:saved?.answers?.['0']===body.student_answer,status_after_cancel:detail?.grade_status,academic_fraction_after_cancel:detail?.score_fraction ?? null,retry_status:retry.data.grade_status,retry_fraction:retry.data.score_fraction ?? null};
    }
    if(process.argv.includes('--answer-key') && !budget.signal.aborted) {
      const keyPng=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="220"><rect width="600" height="220" fill="white"/><text x="30" y="60" font-size="28" fill="black">Synthetic answer key</text><text x="30" y="115" font-size="28" fill="black">13. 8</text><text x="30" y="170" font-size="28" fill="black">14. 21</text></svg>')).png().toBuffer();
      const form=new FormData();form.append('worksheet_files',new Blob([await fs.readFile(path.join(sourceFolder,samples[0].file))],{type:'image/png'}),samples[0].file);form.append('answer_files',new Blob([keyPng],{type:'image/png'}),'synthetic-answer-key.png');form.append('subject','Mathematics');
      const response=await fetch(base+'/api/extract_worksheet_with_answers',{method:'POST',headers:{authorization:'Bearer '+token},body:form,signal:budget.signal});const data=await response.json();
      await fs.writeFile(path.join(output,'answer-key-extraction.json'),JSON.stringify(data,null,2));
      evidence.answer_key={http_status:response.status,questions:data.questions?.length || 0,incomplete:Boolean(data.incomplete),keys_matched:data.golden_reference?.['13']==='8' && data.golden_reference?.['14']==='21',golden_source_preserved:(data.questions || []).filter((q:any)=>['13','14'].includes(String(q.original_index))).every((q:any)=>q.verification?.answer_source==='golden_key')};
    }
    const finalQuiz='live_exact_'+randomUUID();quizzes.set(finalQuiz,{id:finalQuiz,user_id:owner.uid,title:'Synthetic exact check',questions:[{question:'Evaluate $2+3$.',type:'identification',answer:'5',points:2}]});
    const body={quiz_id:finalQuiz,session_id:'sess_'+randomUUID(),answers:{0:'5'},answer_revisions:{0:1},session_revision:1};
    const first=await post('/submit',body);const retry=await post('/submit',body);
    evidence.finalization={first_status:first.http_status,retry_status:retry.http_status,idempotent:first.data.result_id===retry.data.result_id,canonical_total:results.get(first.data.result_id)?.total_score};
    console.log(JSON.stringify({extended:true,generation:evidence.generation,grading:evidence.grading,worksheet_solving:evidence.worksheet_solving,finalization:evidence.finalization,cancellation:evidence.cancellation,answer_key:evidence.answer_key,requests:budget.stats()}));
  }
} finally {
  evidence.metrics=getGeminiReliabilitySnapshot();
  if(budget)evidence.actual_request_budget=budget.stats();
  configureGeminiClientForTests();evidence.finished_at=new Date().toISOString();
  await fs.writeFile(path.join(output,'summary.json'),JSON.stringify(evidence,null,2));
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  delete process.env.GEMINI_API_KEY;
}
