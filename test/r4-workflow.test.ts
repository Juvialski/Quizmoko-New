import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import quizRoutes from '../src/routes/quizRoutes.ts';
import { quizzes, results } from '../src/store/db.ts';

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
