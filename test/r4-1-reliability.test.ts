import { reconcileWorksheetPages } from '../src/services/worksheetPipeline.ts';
import sharp from 'sharp';
import { boundedEvaluationClient } from '../scripts/evaluationSupport.ts';
import { gradeSemanticQuestion } from '../src/services/semanticGrading.ts';
import { extractedWorksheetLabel } from '../src/services/worksheetSourceOrder.ts';
import { extractionQualityIssues } from '../src/services/questionQuality.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { registerRoutes } from '../src/routes/index.ts';
import { aiJobs, quizzes, results, users, liveSessions } from '../src/store/db.ts';
import { createSessionToken } from '../src/middleware/auth.ts';
import { initSocketServer, monitoringRoom, reconcileLiveResults } from '../src/services/socket.ts';
import { configureGeminiClientForTests } from '../src/services/gemini.ts';
import { buildAiTaskConfig } from '../src/services/aiTaskProfiles.ts';
import { generateGeminiContent, configureGeminiRateLimiterForTests, resetGeminiRateLimiterForTests } from '../src/services/geminiRateLimiter.ts';
import { ownedJobs } from '../src/services/ownedJobs.ts';
import { syntheticPdf, tutorialProvider } from './r4-1-fixtures.ts';
import { normalizeAiLatexText, normalizeMathQuestionText } from '../src/services/latex.ts';

const question = (id: string) => ({id,question:'Choose Alpha.',type:'multiple_choice',options:['Alpha','Beta','Gamma','Delta'],answer:'A',points:2});
const pause = (ms:number) => new Promise(resolve=>setTimeout(resolve,ms));
async function fixture() {
  const app=express(); app.set('view engine','ejs'); app.use(express.json({limit:'30mb'}));
  registerRoutes(app);
  app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status || 500).json({success:false,error:'Request failed'}));
  const server=createServer(app); const io=initSocketServer(server); app.set('io',io);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const owner={uid:'r41_owner',role:'teacher',name:'Teacher',email:'teacher@example.invalid',stored_custom_key:'synthetic-only'} as any;
  users.set(owner.uid,owner);
  const token=createSessionToken(owner,600_000);
  const post=async (path:string,body:any,auth?:string)=>{
    const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{authorization:'Bearer '+auth}:{})},body:JSON.stringify(body)});
    return {response,data:await response.json()};
  };
  return {app,io,base,token,post,async close(){configureGeminiClientForTests();io.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
// Exercise actual Engine.IO/Socket.IO over HTTP polling without another client dependency.
async function socketClient(base:string,token?:string) {
  const headers=token?{authorization:'Bearer '+token}:{};
  const root=base+'/socket.io/?EIO=4&transport=polling';
  const initial=await (await fetch(root,{headers})).text(); const sid=JSON.parse(initial.slice(1)).sid;
  const url=root+'&sid='+encodeURIComponent(sid);
  const send=async (packet:string)=>{assert.equal((await fetch(url,{method:'POST',headers,body:packet})).status,200);};
  const read=async ()=> (await fetch(url,{headers,signal:AbortSignal.timeout(2500)})).text();
  await send('40');await read();
  return {send:(event:string,data:any)=>send('42'+JSON.stringify([event,data])),read,close:()=>send('1')};
}

test('R4.1 actual socket rooms isolate teacher roster, private whiteboard and public controls',async()=>{
  const f=await fixture();const id='r41_security';quizzes.set(id,{id,user_id:'r41_owner',title:'Class',questions:[question('1')]});
  const student={uid:'r41_student',role:'student',name:'Student',email:'s@example.invalid'} as any;users.set(student.uid,student);
  const studentToken=createSessionToken(student,600_000);
  const teacher=await socketClient(f.base,f.token);const anon=await socketClient(f.base);const other=await socketClient(f.base,studentToken);
  try {
    await teacher.send('join_quiz',{quiz_id:id,monitor:true});await teacher.read();
    await anon.send('join_quiz',{quiz_id:id,monitor:true});assert.match(await anon.read(),/FORBIDDEN/);
    await other.send('join_quiz',{quiz_id:id,monitor:true});assert.match(await other.read(),/FORBIDDEN/);
    assert.equal(f.io.sockets.adapter.rooms.get(monitoringRoom(id))?.size,1);
    results.set('res_r41_private',{id:'res_r41_private',quiz_id:id,session_id:'r41_private',user_id:student.uid,is_in_progress:true,total_score:2,max_score:2});
    await anon.send('ping',{quiz_id:id,session_id:'r41_private',student_name:'Forged'});assert.match(await anon.read(),/access denied/);
    assert.equal((await f.post('/ping',{quiz_id:id,session_id:'r41_private'})).response.status,403);
    await other.send('ping',{quiz_id:id,session_id:'r41_private',student_name:'Student',score:999});assert.match(await other.read(),/ping_ack/);
    assert.match(await teacher.read(),/update_session/);
    const privateRoom=f.io.sockets.adapter.rooms.get(`quiz_session_${id}_r41_private`);assert.equal(privateRoom?.size,1);
    await f.post(`/api/live/${id}/whiteboard/r41_private/toggle`,{},f.token);
    assert.match(await other.read(),/whiteboard_disabled/);
    await f.post(`/api/live/${id}/toggle_pause`,{},f.token);assert.match(await anon.read(),/pause_state/);
    const denied=await fetch(f.base+'/api/live/'+id,{headers:{authorization:'Bearer '+studentToken}});assert.equal(denied.status,403);
  } finally {await Promise.all([teacher.close(),anon.close(),other.close()]);await f.close();quizzes.delete(id);results.delete('res_r41_private');}
});

test('R4.1 four-student classroom preserves grades, pending answers, reconnect and finalization',async()=>{
  const f=await fixture();const id='r41_classroom';const ids=Array.from({length:4},()=>`sess_${randomUUID()}`);
  quizzes.set(id,{id,user_id:'r41_owner',title:'Tutorial',quiz_mode:'back_and_forth',questions:[...Array.from({length:11},(_,i)=>question(String(i+1))),{id:'12',question:'Explain a clear claim.',type:'open_ended',answer:'A reasoned claim.',points:3}]});
  let providerCalls=0;
  configureGeminiClientForTests(()=>({models:{generateContent:async()=>{providerCalls++;await pause(40);throw Object.assign(new Error('Synthetic outage'),{status:503});}}}));
  const start=performance.now();
  try {
    await Promise.all(ids.map((sid,i)=>f.post('/ping',{quiz_id:id,session_id:sid,student_name:'Synthetic '+i,status:'Started'})));
    await Promise.all(ids.map(sid=>f.post('/api/grade_individual',{quiz_id:id,session_id:sid,question_index:0,student_answer:'Alpha',answer_revision:1,student_name:'Synthetic'})));
    const pending=ids.map(sid=>f.post('/api/grade_individual',{quiz_id:id,session_id:sid,question_index:11,student_answer:'My preserved explanation.',answer_revision:1}));
    await pause(20);
    assert.equal(results.get('res_'+ids[0])?.answers?.['11'],'My preserved explanation.');
    const failures=await Promise.all(pending);assert.ok(failures.every(r=>r.data.grade_status==='retryable_error'));
    for(const sid of ids) assert.equal(results.get('res_'+sid)?.total_score,2);
    await f.post('/ping',{quiz_id:id,session_id:ids[0],current_q:6,ping_revision:20,score:900});
    await f.post('/ping',{quiz_id:id,session_id:ids[0],current_q:2,ping_revision:10});
    const snapshot=await (await fetch(f.base+'/api/live/'+id,{headers:{authorization:'Bearer '+f.token}})).json();
    assert.equal(Object.keys(snapshot.sessions).length,4);assert.equal(snapshot.sessions[ids[0]].score,2);assert.equal(snapshot.sessions[ids[0]].current_q,6);assert.equal(snapshot.sessions[ids[0]].pending_grades,1);
    await f.post(`/api/live/${id}/toggle_pause`,{},f.token);assert.equal((await f.post('/ping',{quiz_id:id,session_id:ids[0]})).data.paused,true);
    await f.post(`/api/live/${id}/toggle_pause`,{},f.token);
    const incomplete=await f.post('/submit',{quiz_id:id,session_id:ids[0],answers:{0:'Alpha',11:'My preserved explanation.'},answer_revisions:{0:1,11:1},session_revision:1});
    assert.equal(incomplete.data.grading_incomplete,true);assert.equal(results.get('res_'+ids[0])?.is_in_progress,true);
    // A separate exact-only attempt finishes under the same authoritative routes.
    const finalId='r41_final';quizzes.set(finalId,{id:finalId,user_id:'r41_owner',title:'Final',questions:[question('1')]});
    const sid='sess_'+randomUUID();const body={quiz_id:finalId,session_id:sid,answers:{0:'Alpha'},answer_revisions:{0:1},session_revision:1};
    const first=await f.post('/submit',body);const retry=await f.post('/submit',body);assert.equal(first.response.status,200);assert.equal(retry.data.result_id,first.data.result_id);
    assert.equal((await f.post('/api/grade_individual',{quiz_id:finalId,session_id:sid,question_index:0,student_answer:'Beta',answer_revision:2})).response.status,409);
    liveSessions.delete(id);const recovered=reconcileLiveResults(id);assert.equal(Object.keys(recovered.sessions).length,4);assert.equal(recovered.sessions[ids[0]].last_active,0);
    console.log(JSON.stringify({classroom_students:4,questions:12,mocked_provider_calls:providerCalls,elapsed_ms:Math.round(performance.now()-start),reconciliation_failures:0}));
    quizzes.delete(finalId);results.delete('res_'+sid);
  } finally {ids.forEach(sid=>results.delete('res_'+sid));quizzes.delete(id);await f.close();}
});

test('R4.1 detached generation is owned, idempotent, private and restart-honest',async()=>{
  const f=await fixture();let calls=0;
  configureGeminiClientForTests(()=>({models:{generateContent:async(request:any)=>{
    calls++;await pause(40);const schema=request.config.responseSchema;
    if(schema.items?.properties?.confidence){const prompt=String(request.contents[0]);const payload=JSON.parse(prompt.slice(prompt.indexOf('QUESTIONS:')+'QUESTIONS:'.length).trim());return {text:JSON.stringify(payload.map((q:any)=>({id:q.id,answer:'A',solution:'Alpha is explicitly requested.',confidence:'high'})))};}
    return {text:JSON.stringify([question('generated_1'),{...question('generated_2'),question:'Which option is the word Alpha?'}])};
  }}}));
  try {
    const body={async_job:true,idempotency_key:randomUUID(),topic:'Words',subject:'English',test_type:'Multiple Choice',num_items:2,batch_size:2};
    const responses=await Promise.all(Array.from({length:4},()=>f.post('/api/generate_ai',body,f.token)));
    assert.ok(responses.every(r=>r.response.status===202),JSON.stringify(responses.map(r=>r.data)));const id=responses[0].data.job_id;assert.ok(responses.every(r=>r.data.job_id===id));
    assert.equal((await fetch(f.base+'/api/tasks/'+id,{headers:{authorization:'Bearer user_other'}})).status,404);
    for(let i=0;i<80&&aiJobs.get(id).status==='running';i++)await pause(20);
    const job=aiJobs.get(id);assert.ok(['completed','needs_attention'].includes(job.status),JSON.stringify(job));assert.equal(calls,3);assert.equal(quizzes.get(job.quiz_id)?.is_draft,true);
    assert.equal((await f.post('/api/generate_ai',body,f.token)).data.job_id,id);assert.equal(calls,3);
    assert.equal((await fetch(f.base+'/quiz/'+job.quiz_id)).status,409);
    aiJobs.set('interrupted-fixture',{...job,id:'interrupted-fixture',status:'running',quiz_id:undefined});
    const restored=await ownedJobs('r41_owner');assert.equal(restored.find(j=>j.id==='interrupted-fixture')?.status,'interrupted');
    assert.doesNotMatch(JSON.stringify(job),/synthetic-only|api_key|access_token/);
    quizzes.delete(job.quiz_id);aiJobs.delete(id);aiJobs.delete('interrupted-fixture');
  } finally {await f.close();}
});

test('R4.1 scheduler serves interactive work ahead of background and bounds quota starts',async()=>{
  resetGeminiRateLimiterForTests();configureGeminiRateLimiterForTests({rpm:1,reserve:0,windowMs:100,maxQueueWaitMs:2000});
  const starts:string[]=[];const client={models:{generateContent:async(req:any)=>{starts.push(req.contents);return {text:'{}'};}}};
  try {
    await generateGeminiContent(client,{model:'gemini-3.5-flash-lite',contents:'first'});
    const background=generateGeminiContent(client,{model:'gemini-3.5-flash-lite',contents:'background'});
    const interactive=generateGeminiContent(client,{model:'gemini-3.5-flash-lite',contents:'interactive',config:buildAiTaskConfig('semantic_grading')});
    await Promise.all([background,interactive]);assert.deepEqual(starts,['first','interactive','background']);
    const controller=new AbortController();const cancelled=generateGeminiContent(client,{model:'gemini-3.5-flash-lite',contents:'cancelled',config:{abortSignal:controller.signal}});controller.abort();await assert.rejects(cancelled);assert.equal(starts.length,3);
  } finally {resetGeminiRateLimiterForTests();}
});

test('R4.1 real three-page PDF decoding retains successful pages and retries only failed page',async()=>{
  const f=await fixture();const provider=tutorialProvider(5);configureGeminiClientForTests(()=>provider.client);
  const extract=async(recovery?:string,token=f.token)=>{
    const body=new FormData();body.append('files',new Blob([new Uint8Array(syntheticPdf())],{type:'application/pdf'}),'synthetic.pdf');
    body.append('api_key','synthetic-only');body.append('subject','English');if(recovery)body.append('recovery_id',recovery);
    const response=await fetch(f.base+'/api/extract_worksheet',{method:'POST',headers:{authorization:'Bearer '+token},body});
    return {response,data:await response.json()};
  };
  try {
    const first=await extract();assert.equal(first.response.status,200,JSON.stringify(first.data));
    assert.equal(first.data.incomplete,true);assert.deepEqual(first.data.questions.map((q:any)=>q.original_index),['7a','8']);assert.equal(first.data.failed_pages[0].page_number,2);
    const retry=await extract(first.data.recovery_id);assert.equal(retry.data.incomplete,false);assert.deepEqual(retry.data.questions.map((q:any)=>q.original_index),['7a','7b','8']);
    assert.deepEqual(provider.pageCalls,[1,2,1]);assert.equal(provider.calls,4);
    assert.equal(retry.data.questions.find((q:any)=>q.original_index==='7b').extracted_label,'*7b');
    assert.equal((await extract(first.data.recovery_id,'user_other')).response.status,409);
    console.log(JSON.stringify({worksheet_pages:3,failed_pages_retried:1,mocked_requests:4,successful_pages_repeated:0}));
  } finally {await f.close();}
});

test('R4.1 mathematical currency normalization preserves values across repeated display passes',()=>{
  const text=String.raw`The prices are $\text{\$52}$, $\text{\$49}$ and $\text{\$48.50}$.`;
  for (const normalize of [normalizeAiLatexText,normalizeMathQuestionText]) {
    assert.equal(normalize(text),text);
    assert.equal(normalize(normalize(text)),text);
    assert.equal(normalize(String.raw`Pay $\text{$1,250.75}$ today.`),String.raw`Pay $\text{\$1,250.75}$ today.`);
  }
});

test('R4.1 screenshot margin stars stay separate from immutable main IDs and drawing tasks require review',()=>{
  assert.deepEqual(extractedWorksheetLabel('*6'),{original_index:'6',extracted_label:'*6'});
  assert.deepEqual(extractedWorksheetLabel('★ 07b'),{original_index:'07b',extracted_label:'★ 07b'});
  assert.deepEqual(extractedWorksheetLabel('A*6'),{original_index:'A*6'});
  assert.deepEqual(extractedWorksheetLabel('7b'),{original_index:'7b'});
  assert.ok(extractionQualityIssues({raw_text:'Plot points on a coordinate plane, then draw segments to make a rectangle. Find the perimeter.',type:'open_ended'}).some(issue=>issue.code==='drawing_response_required'));
  assert.ok(!extractionQualityIssues({raw_text:'Plot points on a coordinate plane.',type:'graphing'}).some(issue=>issue.code==='drawing_response_required'));
  assert.ok(extractionQualityIssues({raw_text:'Plot the location on a number line.',type:'open_ended'}).some(issue=>issue.code==='drawing_response_required'));
});

test('R4.1 bounded live evaluator preserves the underlying transport cancellation signal',async()=>{
  const controller=new AbortController();let cancelled=false;
  const underlying={models:{generateContent:(request:any)=>new Promise((_resolve,reject)=>{
    request.config.abortSignal.addEventListener('abort',()=>{cancelled=true;reject(new DOMException('Cancelled','AbortError'));},{once:true});
  })}};
  const bounded=boundedEvaluationClient(underlying,1);
  const pending=generateGeminiContent(bounded.client,{model:'gemini-3.5-flash-lite',contents:'synthetic',config:{abortSignal:controller.signal}});
  await pause(5);controller.abort();await assert.rejects(pending);assert.equal(cancelled,true);assert.equal(bounded.stats().actual_requests,1);
});

test('R4.1 unanchored rubric partial credit stays pending instead of accepting an arbitrary allocation',async()=>{
  const client={models:{generateContent:async()=>({text:JSON.stringify({score_fraction:0.3,feedback:'A correct first step is shown; the final value is incorrect.',criteria:[{id:'method',score_fraction:0.5,evidence:'Subtract three from both sides.'},{id:'answer',score_fraction:0,evidence:'The final value is incorrect.'}]})})}};
  const question={type:'open_ended',question:'Solve $2*x+3=7$ and show your work.',answer:'2',grading_rubric:{version:1,criteria:[{id:'method',description:'Valid equation transformation',weight:0.6},{id:'answer',description:'Correct final value',weight:0.4}]}};
  const outcome=await gradeSemanticQuestion({clients:[client],question,studentAnswer:'Subtract $3$; $2*x=4$; $x=3$.'});
  assert.equal(outcome.gradeStatus,'pending');assert.equal(outcome.scoreFraction,undefined);assert.match(outcome.feedback,/explicit step criteria|teacher review/i);
});

test('R4.1 quota rejection preserves the answer and exposes Retry-After without academic zero',async()=>{
  const f=await fixture();const id='r41_quota';const sid='sess_'+randomUUID();
  quizzes.set(id,{id,user_id:'r41_owner',title:'Quota',questions:[{question:'Explain evaporation.',type:'open_ended',answer:'Energetic surface molecules escape.'}]});
  configureGeminiClientForTests(()=>({models:{generateContent:async()=>{throw Object.assign(new Error('Synthetic quota'),{status:429,retryAfterSeconds:7});}}}));
  try {
    const response=await f.post('/api/grade_individual',{quiz_id:id,session_id:sid,question_index:0,student_answer:'My explanation.',answer_revision:1});
    assert.equal(response.response.status,429);assert.equal(response.response.headers.get('retry-after'),'7');assert.equal(response.data.grade_status,'retryable_error');assert.equal(response.data.score_fraction,undefined);assert.equal(results.get('res_'+sid)?.answers?.['0'],'My explanation.');
  } finally {quizzes.delete(id);results.delete('res_'+sid);await f.close();resetGeminiRateLimiterForTests();}
});

test('R4.1 explicit shared data crosses page/file seams by source ID and ambiguous repeated IDs stay review-required',()=>{
  const context='Use the following information for problems $7$ and $8$. The prices are $52$, $49$ and $48$.';
  const q=(id:string,raw:string,prefix='')=>({original_index:id,raw_text:raw,verbatim_text:raw,context_prefix:prefix,type:'open_ended',options:[]});
  const pages=[{source_file:'first.png',page_number:1,questions:[q('7','Find the mean.',context)]},{source_file:'next.png',page_number:1,questions:[q('8','Which measure changes most?')]}];
  const result=reconcileWorksheetPages(pages);
  const target=result.questions.find(q=>q.original_index==='8')!;
  assert.equal(target.context_prefix,context);assert.match(target.question,/52/);assert.equal(target.verbatim_text,'Which measure changes most?');assert.equal(target.source.original_index,'8');assert.equal(target.source.source_file,'next.png');assert.equal((target.shared_context_source as any).source_file,'first.png');assert.equal(target.source_review_required,true);
  const ambiguous=reconcileWorksheetPages([...pages,{source_file:'unrelated.png',page_number:1,questions:[q('8','Another unrelated item.')]}]);
  assert.ok(ambiguous.diagnostics.some(d=>d.message.includes('Shared source context is ambiguous')));
  for(const item of ambiguous.questions.filter(q=>q.original_index==='8')) {assert.equal(item.source_review_required,true);assert.doesNotMatch(item.question,/52/);}
});

test('R4.1 extraction HTTP response restores explicitly shared text across uploaded image files',async()=>{
  const f=await fixture();let calls=0;
  const context='Use the following data for problems $7$ and $8$. The prices are $52$, $49$ and $48$.';
  configureGeminiClientForTests(()=>({models:{generateContent:async()=>{
    calls++;const verbatim=calls===1?'Find the mean.':'Which measure changes most?';
    return {text:JSON.stringify([{original_index:calls===1?'7':'8',verbatim_text:verbatim,raw_text:verbatim,context_prefix:calls===1?context:'',options:[],type:'open_ended',bounding_box:[]}])};
  }}}));
  try {
    const form=new FormData();
    for(const [name,color] of [['first.png','red'],['next.png','blue']]) {
      const bytes=await sharp({create:{width:20,height:20,channels:3,background:color}}).png().toBuffer();form.append('files',new Blob([new Uint8Array(bytes)],{type:'image/png'}),name);
    }
    form.append('api_key','synthetic-only');form.append('subject','Mathematics');
    const response=await fetch(f.base+'/api/extract_worksheet',{method:'POST',headers:{authorization:'Bearer '+f.token},body:form});const data=await response.json();
    assert.equal(response.status,200);assert.equal(calls,2);
    const target=data.questions.find((q:any)=>q.original_index==='8');assert.equal(target.context_prefix,context);assert.match(target.raw_text,/52/);assert.equal(target.source.source_file,'next.png');assert.equal(target.shared_context_source.source_file,'first.png');assert.equal(target.source_review_required,true);
  } finally {await f.close();}
});

test('R4.1 finalization preserves review diagnostics and rejects missing credentials before job acceptance',async()=>{
  const f=await fixture();const before=aiJobs.size;
  try {
    const body={questions:[question('7')],worksheet_diagnostics:[{code:'review_required',severity:'error',source_id:'7',message:'Source needs review.'}]};
    for(const async_job of [false,true]) {
      const result=await f.post('/api/generate_quiz_from_extracted',{...body,async_job,idempotency_key:randomUUID()},f.token);
      assert.equal(result.response.status,422);assert.equal(result.data.review_required,true);assert.equal(result.data.diagnostics[0].source_id,'7');
    }
    const missing=await f.post('/api/generate_quiz_from_extracted',{async_job:true,idempotency_key:randomUUID(),questions:[{...question('7'),answer:''}]},f.token);
    assert.equal(missing.response.status,400);assert.equal(aiJobs.size,before);
  } finally {await f.close();}
});
