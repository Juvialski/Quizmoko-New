import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import quizRoutes from '../src/routes/quizRoutes.ts';
import { quizzes, results } from '../src/store/db.ts';

test('worksheet modes submit without browser keys and leave credential/quota decisions to the server', async () => {
  for(const [view,inputId,endpoint] of [
    ['worksheet_upload.ejs','file-input','/api/extract_worksheet'],
    ['worksheet_answers_upload.ejs','worksheet-input','/api/extract_worksheet_with_answers'],
    ['rmxflash_upload.ejs','ws-input','/api/extract_rmxflash']
  ]) {
    const html=fs.readFileSync('views/'+view,'utf8');
    const dom=new JSDOM(html,{url:'http://localhost',runScripts:'outside-only'});
    const w=dom.window as any,requests:any[]=[],alerts:string[]=[];
    w.alert=(message:string)=>alerts.push(message);
    w.console.error=()=>{};
    w.QuizMoKoTasks={refresh(){}};w.QuizMoKoTeacher={progressLabel:(s:string)=>s};w.refreshQuizmokoIcons=()=>{};
    w.fetch=async(url:string,options:any)=>{
      requests.push({url,body:options?.body});
      return new Response(JSON.stringify({success:false,error:'Synthetic server rejected missing credentials'}),{status:400,headers:{'Content-Type':'application/json'}});
    };
    w.eval(fs.readFileSync('public/js/ai-key-selection.js','utf8'));
    for(const script of dom.window.document.querySelectorAll('script:not([src])'))w.eval(script.textContent || '');
    Object.defineProperty(dom.window.document.getElementById(inputId),'files',{value:[new w.File(['synthetic'], 'fixture.pdf',{type:'application/pdf'})]});
    try {
      await w.handleExtract({preventDefault(){}});
      assert.equal(requests.length,1,view+': browser credential absence must not block the server request');
      assert.equal(requests[0].url,endpoint);
      assert.equal(requests[0].body.get('api_key'),'');
      assert.ok(!alerts.some(message=>/remaining quota|No API key/i.test(message)));
      assert.equal((dom.window.document.getElementById('extract-btn') as HTMLButtonElement).disabled,false);
    } finally {dom.window.close();}
  }
});

test('browser key selection preserves BYOK and tolerates malformed settings without inventing quota', () => {
  const dom=new JSDOM('',{url:'http://localhost',runScripts:'outside-only'}),w=dom.window as any;
  w.eval(fs.readFileSync('public/js/ai-key-selection.js','utf8'));
  try {
    assert.equal(w.QuizMoKoAiKeys.browserKey(),'');
    w.localStorage.setItem('gemini_api_keys','[null," "," synthetic-browser "]');
    assert.equal(w.QuizMoKoAiKeys.browserKey(),'synthetic-browser');
    w.localStorage.setItem('gemini_api_keys','broken JSON');w.localStorage.setItem('gemini_api_key',' synthetic-legacy ');
    assert.equal(w.QuizMoKoAiKeys.browserKey(),'synthetic-legacy');
    assert.equal(w.QuizMoKoAiKeys.browserKey({getItem(){throw Error('Storage unavailable');}}),'');
    Object.defineProperty(w,'localStorage',{get(){throw Error('Storage blocked');}});
    assert.equal(w.QuizMoKoAiKeys.browserKey(),'');
  } finally {dom.window.close();}
});

test('failed finalization survives repeated end signals and retries only on explicit action', async () => {
  const html=fs.readFileSync('views/quiz.ejs','utf8');
  const submit=html.slice(html.indexOf('        async function submitQuiz('),html.indexOf('        function openSharedSolutions()'));
  const ids=['quiz-screen','result-screen','score-text','save-status-msg','grading-progress-container','grading-progress-bar','grading-progress-detail','pdf-btn','right-panel','review-container'];
  const dom=new JSDOM('<div class="quiz-container"></div>'+ids.map(id=>`<div id="${id}"></div>`).join(''),{url:'http://localhost',runScripts:'outside-only'});
  const w=dom.window as any,requests:any[]=[];let endSignals=0;
  w.console.error=()=>{};w.refreshQuizmokoIcons=()=>{};
  w.fetch=async(url:string,options:any)=>{
    if(url==='/ping')return new Response('{}');
    requests.push(JSON.parse(options.body));
    return requests.length===1
      ? new Response(JSON.stringify({success:false,error:'Synthetic persistence failure'}),{status:503})
      : new Response(JSON.stringify({success:true,result_id:'synthetic-result',result_access_token:'synthetic-token',total_score:2,max_score:2,graded_details:[{question:'What is 2+3?',grade_status:'graded',score_fraction:1,earned_points:2,user_answer:'5',correct_answer:'5'}]}));
  };
  w.sendPing=(status:string)=>{if(status==='Grading incomplete' && endSignals++<3)void w.submitQuiz('terminated');};
  w.eval(`
    let isSubmitting=false, finalizationAttempted=false, lastSubmissionStatus='completed';
    let timerInterval=null, pingInterval=null, pendingGradings=0, progressiveSaveDebounce=null, progressiveSaveChain=Promise.resolve();
    const quizData={questions:[{question:'What is 2+3?',type:'identification'}]}, gradingRequests=new Map();
    let answerRevisions={},answerDigests={},snapshotDigests={},answers={0:'5'},questionPages={},whiteboardDirtyQuestions={},solutionSnapshots={},progressiveResults=[],sessionRevision=0;
    let resultId=null,resultAccessToken=null,totalScore=0,currentIndex=0;
    const quizId='synthetic-quiz',sessionId='synthetic-session',studentName='Synthetic Student',STORAGE_KEY='synthetic-state';
    const currentAnswerRevision=()=>1,questionPageHasContent=()=>false,captureQuestionSnapshots=async()=>{},sanitizeSnapshotsForServer=x=>x;
    const stableSha256Digest=async x=>JSON.stringify(x),sanitizeAnswerForServer=x=>x,isAuthoritativelyGraded=x=>x?.grade_status==='graded';
    const recalculateLiveScore=()=>0,maximumQuizScore=()=>2,getCurrentTimeMetrics=()=>({timeActive:1,finalPausedTime:0,totalDuration:1});
    const abortQuestionGrading=()=>{},formatText=String,questionPoints=()=>2,supportsAiFeedback=()=>false,renderMath=()=>{},saveQuizState=()=>{};
    ${submit}
    window.submitQuiz=submitQuiz;
  `);
  try {
    await w.submitQuiz('terminated');
    await Promise.all(Array.from({length:8},()=>w.submitQuiz('terminated')));
    assert.equal(requests.length,1,'end/ping signals cannot restart failed finalization');
    assert.equal(dom.window.document.getElementById('score-text')!.innerText,'Result not finalized');
    assert.match(dom.window.document.getElementById('save-status-msg')!.textContent!,/Synthetic persistence failure/);
    assert.match(dom.window.document.getElementById('save-status-msg')!.innerHTML,/submitQuiz\(lastSubmissionStatus, true\)/);
    await w.submitQuiz('terminated',true);
    assert.equal(requests.length,2);assert.equal(requests[1].answers['0'],'5');
    assert.equal(dom.window.document.getElementById('score-text')!.innerText,'2.00 / 2.00');
  } finally {dom.window.close();}
});

test('R4 explicit drafts, owner preview, publication and stale updates retain legacy compatibility', async () => {
  const app = express(); app.set('view engine','ejs'); app.use(express.json()); app.use(quizRoutes);
  const server = app.listen(0); await new Promise<void>(resolve => server.once('listening',resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const id = 'r4_contract';
  const question = {id:'stable-1',question:'Choose a word.',type:'multiple_choice',options:['Alpha','Beta','Gamma','Delta'],answer:'A',points:1,source:{original_index:'7b',page_number:1},verification:{answer_source:'manual',verification_status:'verified'}};
  quizzes.set(id,{id,user_id:'r4_owner',title:'R4 draft',time_limit:30,is_draft:true,questions:[question]});
  const owner = {authorization:'Bearer user_r4_owner','Content-Type':'application/json'};
  const update = (body: any, headers=owner) => fetch(base+'/update/'+id,{method:'POST',headers,body:JSON.stringify(body)});
  try {
    assert.equal((await fetch(base+'/quiz/'+id)).status,409);
    const count = results.size;
    const preview = await fetch(base+'/preview/'+id,{headers:owner});
    assert.equal(preview.status,200); const html = await preview.text();
    assert.match(html,/Question 7b/); assert.doesNotMatch(html,/grade_individual|submit_quiz|socket\.io|Alpha.*correct/i);
    assert.equal(results.size,count);
    const original = quizzes.get(id).questions[0].question;
    quizzes.get(id).questions[0].question = '<script>window.r4Injected=true</script><img src="data:image/png;base64,AAAA" onerror="window.r4Injected=true">';
    const inertPreview = await (await fetch(base+'/preview/'+id,{headers:owner})).text();
    assert.doesNotMatch(inertPreview,/<script>window.r4Injected/);
    assert.match(inertPreview,/&lt;script&gt;window.r4Injected/);
    quizzes.get(id).questions[0].question = original;
    assert.equal((await fetch(base+'/preview/'+id,{headers:{authorization:'Bearer user_other'}})).status,403);
    assert.equal((await update({title:'Saved draft',save_intent:'save',expected_revision:0})).status,200);
    assert.equal(quizzes.get(id).is_draft,true);
    assert.equal((await update({title:'stale',save_intent:'save',expected_revision:0})).status,409);
    assert.equal(quizzes.get(id).title,'Saved draft');
    const needsReview = {...question,verification:{answer_source:'manual',verification_status:'review_required'}};
    assert.equal((await update({questions:[needsReview],save_intent:'publish',allow_review_required:true})).status,400);
    assert.equal((await update({save_intent:'publish',expected_revision:1})).status,200);
    assert.equal((await fetch(base+'/quiz/'+id)).status,200);
    assert.equal((await update({title:'Unauthorized'}, {'Content-Type':'application/json',authorization:'Bearer user_other'})).status,403);
    assert.equal((await update({save_intent:'draft',expected_revision:2})).status,200);
    assert.equal((await fetch(base+'/api/quiz/'+id)).status,409);
    // Legacy callers keep automatic publication after successful validation.
    assert.equal((await update({questions:[question]})).status,200);
    assert.equal(quizzes.get(id).is_draft,false);
    const concurrent = await Promise.all([update({title:'First',save_intent:'save',expected_revision:4}),update({title:'Second',save_intent:'save',expected_revision:4})]);
    assert.deepEqual(concurrent.map(r=>r.status),[200,409]);
    const editor = await (await fetch(base+'/edit/'+id,{headers:owner})).text();
    const version = editor.match(/"edit_version":"([a-f0-9]+)"/)![1];
    quizzes.get(id).title = 'Changed by another existing tool';
    assert.equal((await update({title:'Stale other tool',expected_version:version})).status,409);
    assert.equal(quizzes.get(id).title,'Changed by another existing tool');
  } finally { quizzes.delete(id); await new Promise<void>(resolve=>server.close(()=>resolve())); }
});


test('teacher preview removes source scripts, event handlers and unsafe image URLs', () => {
  const dom=new JSDOM('<main><div data-preview-html=""></div></main>',{runScripts:'outside-only'});
  dom.window.document.querySelector('[data-preview-html]')!.setAttribute('data-preview-html','<script>window.r4Injected=true</script><img src="javascript:alert(1)" onerror="window.r4Injected=true"><p onclick="alert(1)">Safe $1+1$ <b>text</b></p>');
  dom.window.eval(fs.readFileSync('public/js/teacher-preview.js','utf8'));
  assert.equal((dom.window as any).r4Injected,undefined);
  assert.equal(dom.window.document.querySelectorAll('script,img,[onclick],[onerror]').length,0);
  assert.match(dom.window.document.querySelector('main')!.textContent!,/Safe \$1\+1\$ text/);
  dom.window.close();
});


test('incomplete teacher edits save privately and cannot bypass publication validation', async () => {
  const app=express();app.use(express.json());app.use(quizRoutes);
  const server=app.listen(0);await new Promise<void>(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${(server.address() as any).port}`,id='hotfix_draft';
  const original={id:'stable',original_index:'7b',question:'Choose Alpha.',type:'multiple_choice',options:['Alpha','Beta','Gamma','Delta'],answer:'A',points:1,verification:{verification_status:'verified'}};
  quizzes.set(id,{id,user_id:'hotfix_owner',title:'Disposable draft',time_limit:30,questions:[original]});
  const update=(body:any)=>fetch(base+'/update/'+id,{method:'POST',headers:{authorization:'Bearer user_hotfix_owner','Content-Type':'application/json'},body:JSON.stringify(body)});
  try {
    const incomplete={...original,options:['','Beta','Gamma','Delta'],answer:''};
    assert.equal((await update({questions:[incomplete],save_intent:'save',allow_review_required:true,expected_revision:0})).status,200);
    assert.equal(quizzes.get(id).is_draft,true);assert.equal(quizzes.get(id).questions[0].options[0],'');
    assert.equal((await fetch(base+'/quiz/'+id)).status,409);
    const rejected=await update({questions:[{...incomplete,verification:{verification_status:'verified',teacher_approved:true}}],save_intent:'publish'});
    assert.equal(rejected.status,400);assert.match((await rejected.json()).error,/Question 7b/);
    const duplicate={...original,options:['Alpha','Alpha','Gamma','Delta']};
    assert.equal((await update({questions:[duplicate],save_intent:'draft',allow_review_required:true})).status,200);
    assert.equal((await update({questions:[duplicate],save_intent:'publish'})).status,400);
    assert.equal((await update({questions:[original],save_intent:'publish'})).status,200);
    assert.equal(quizzes.get(id).is_draft,false);
  } finally {quizzes.delete(id);await new Promise<void>(r=>server.close(()=>r()));}
});
