import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
const output='docs/r4-1-browser';await fs.mkdir(output,{recursive:true});
await fs.mkdir('docs/audit-2026-10-28',{recursive:true});
const server=spawn(process.execPath,['--require','./test/tsx-bootstrap.cjs','--import','tsx','test/r4-1-browser-server.ts'],{stdio:['ignore','pipe','pipe']});
let logs='';server.stdout.on('data',chunk=>logs+=chunk);server.stderr.on('data',chunk=>logs+=chunk);
const evidence={mode:'isolated Chromium; actual routes, PDF decoding, browser scripts and Socket.IO; mocked Gemini only',scenarios:[],errors:[],screenshots:[]};let browser;
try {
  for(let i=0;i<60&&!logs.includes('R4.1 synthetic server ready');i++){if(server.exitCode!==null)throw Error(logs);await new Promise(r=>setTimeout(r,200));}
  assert.match(logs,/R4.1 synthetic server ready/);browser=await chromium.launch({headless:true});
  const base='http://127.0.0.1:3000';const tokens=await (await fetch(base+'/__fixtures')).json();
  async function context(token){const ctx=await browser.newContext({viewport:{width:1366,height:900}});
    await ctx.addCookies([{name:'quizmoko_session',value:token,url:base}]);
    await ctx.route('https://**/*',r=>r.fulfill({status:200,contentType:'application/javascript',body:r.request().url().includes('firebase-auth.js')?'export const getAuth=()=>({}),signOut=async()=>{};':r.request().url().includes('firebase-app.js')?'export const initializeApp=()=>({});':'/* synthetic optional assets */'}));
    await ctx.addInitScript(()=>{try {localStorage.setItem('tour_completed','true');localStorage.setItem('gemini_api_keys',JSON.stringify(['synthetic-key']));}catch{}});
    ctx.on('page',p=>{p.on('pageerror',e=>evidence.errors.push(e.message));p.on('dialog',d=>d.accept());});return ctx;}
  async function awaitTask(id) {
    for(let attempt=0;attempt<150;attempt++) {
      const response=await fetch(base+'/api/tasks/'+id,{headers:{authorization:'Bearer '+tokens.teacher}});
      const job=(await response.json()).job;
      if (job && ['completed','needs_attention','failed','interrupted'].includes(job.status)) return job;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error('Owned task did not finish in browser fixture budget');
  }
  const teacher=await context(tokens.teacher);const monitor=await teacher.newPage();await monitor.goto(base+'/live/tutorial');
  const students=await Promise.all(tokens.students.map(async(token,i)=>{const ctx=await context(token);const page=await ctx.newPage();await page.goto(base+'/quiz/tutorial');await page.locator('#student-name').fill('Synthetic Student '+i);await page.getByRole('button',{name:'Start Quiz',exact:true}).click();return {ctx,page};}));
  await monitor.waitForFunction(()=>document.querySelectorAll('#live-table tbody tr').length===4);
  const start=Date.now();
  await Promise.all(students.map(async({page})=>{await page.locator('.option-btn').first().click();await page.locator('#btn-next').click();}));
  await monitor.waitForFunction(()=>[...document.querySelectorAll('#live-table tbody tr')].every(row=>row.textContent.includes('1.00')));
  console.log('Browser scenario complete');evidence.scenarios.push({name:'Four students join and answer concurrently; authoritative teacher scores',pass:true,observed_ms:Date.now()-start});
  // Actual semantic grade routes with synthetic provider delays alongside background generation.
  const dashboard=await teacher.newPage();await dashboard.goto(base+'/');await dashboard.getByRole('button',{name:'Generate with AI',exact:true}).click();await dashboard.locator('#topic-input').fill('Language tutorial');
  await dashboard.locator('[name=num_items]').fill('2');
  const accepted=dashboard.waitForResponse(r=>r.url().endsWith('/api/generate_ai')&&r.request().method()==='POST');
  await dashboard.locator('#generate-btn').click();const job=(await (await accepted).json()).job_id;assert.ok(job);
  const semantic=await Promise.all(students.map(({page},i)=>page.evaluate(async i=>{
    const response=await fetch('/api/grade_individual',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({quiz_id:quizId,session_id:sessionId,question_index:11,answer_revision:1,student_answer:i===0?'TEMPORARY provider case':'My claim and reason.',student_name:studentName})});return response.json();
  },i)));
  assert.equal(semantic[0].grade_status,'retryable_error');assert.ok(semantic.slice(1).every(g=>g.grade_status==='graded'));
  console.log('Browser scenario complete');evidence.scenarios.push({name:'Mocked Gemini grading delay/outage alongside owned generation',pass:true,graded:3,retryable:1});
  await dashboard.waitForFunction(()=>document.querySelector('#generator-feedback')?.textContent.includes('Generation finished'));
  await dashboard.screenshot({path:'docs/audit-2026-10-28/generator-after-desktop.png'});
  await dashboard.setViewportSize({width:390,height:844});
  await dashboard.screenshot({path:'docs/audit-2026-10-28/generator-after-mobile.png'});
  await dashboard.setViewportSize({width:1366,height:900});
  await dashboard.evaluate(id=>window.dispatchEvent(new CustomEvent('qm-tasks-updated',{detail:[{id,status:'failed'}]})),job);
  assert.match(await dashboard.locator('#generator-feedback').textContent(),/Generation failed/);
  await dashboard.goto(base+'/preview/tutorial');await dashboard.goBack();
  await dashboard.waitForFunction(()=>document.querySelector('.qm-owned-tasks')?.textContent.includes('Generating Quiz'));
  const same=await dashboard.evaluate(async id=>(await (await fetch('/api/tasks/'+id)).json()).job.id,job);assert.equal(same,job);
  await dashboard.waitForFunction(()=>document.querySelector('.qm-owned-tasks a')?.textContent==='Open draft');
  await dashboard.getByRole('navigation',{name:'Create quiz method'}).getByRole('link',{name:'Generate with AI',exact:true}).click();await dashboard.locator('#topic-input').fill('Language tutorial');await dashboard.locator('[name=num_items]').fill('2');
  const [repeated]=await Promise.all([dashboard.waitForResponse(r=>r.url().endsWith('/api/generate_ai')&&r.request().method()==='POST'),dashboard.locator('#generate-btn').click()]);assert.equal((await repeated.json()).job_id,job);
  await dashboard.reload();assert.equal((await dashboard.evaluate(async()=> (await (await fetch('/api/tasks')).json()).jobs.length)),1);
  console.log('Browser scenario complete');evidence.scenarios.push({name:'Preview, Back and refresh recover the same completed generation job and draft link',pass:true});
  const first=students[0];const before=await first.page.evaluate(()=>({id:sessionId,answer:answers[0],index:currentIndex}));
  await first.ctx.setOffline(true);await first.page.waitForTimeout(800);await first.ctx.setOffline(false);await first.page.reload();
  await first.page.waitForFunction(()=>quizStartTime && studentName==='Synthetic Student 0');assert.equal(await first.page.evaluate(()=>sessionId),before.id);assert.equal(await first.page.evaluate(()=>answers[0]),before.answer);
  await monitor.getByRole('button',{name:/Pause Timers/}).click();await first.page.waitForFunction(()=>isPaused===true);await monitor.getByRole('button',{name:/Resume Timers/}).click();await first.page.waitForFunction(()=>isPaused===false);
  console.log('Browser scenario complete');evidence.scenarios.push({name:'Student offline/reconnect/refresh retains attempt and answer; pause/resume reconciles',pass:true});
  // Exercise final submission from a browser against a new small synthetic exact-answer quiz via existing tutorial answers.
  const finalized=await students[1].page.evaluate(async()=>{const body={quiz_id:quizId,session_id:sessionId,student_name:studentName,answers:Object.fromEntries(Array.from({length:11},(_,i)=>[i,'Alpha']).concat([[11,'My claim and reason.']])),answer_revisions:Object.fromEntries(Array.from({length:12},(_,i)=>[i,1])),session_revision:10};const r=await fetch('/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};});assert.equal(finalized.status,200,JSON.stringify(finalized));
  await monitor.waitForFunction(()=>document.querySelector('#live-table tbody')?.textContent.includes('Completed'));
  console.log('Browser scenario complete');evidence.scenarios.push({name:'Final submission updates teacher completion without ghost active attempt',pass:true});
  const ws=await teacher.newPage();await ws.goto(base+'/worksheet');const pdf=Buffer.from(await (await fetch(base+'/__worksheet')).arrayBuffer());
  await ws.locator('#file-input').setInputFiles({name:'synthetic.pdf',mimeType:'application/pdf',buffer:pdf});await ws.locator('#extract-btn').click();
  await ws.getByRole('button',{name:'Retry failed pages',exact:true}).waitFor({state:'visible'});await ws.getByRole('button',{name:'Retry failed pages',exact:true}).click();
  await ws.waitForFunction(()=>window.worksheetIncomplete===false);const metrics=await(await fetch(base+'/__metrics')).json();assert.deepEqual(metrics.page_calls,[1,2,1]);
  assert.deepEqual(await ws.evaluate(()=>extractedQuestions.map(q=>q.original_index)),['7a','7b','8']);
  console.log('Browser scenario complete');evidence.scenarios.push({name:'Real three-page PDF: one mocked page failure, targeted retry, exact 7a/7b/8',pass:true,page_requests:metrics.page_calls});
  for(const [name,page] of [['dashboard',dashboard],['live',monitor],['worksheet',ws]]){await page.screenshot({path:output+'/'+name+'-desktop.png',fullPage:true});evidence.screenshots.push(name+'-desktop.png');await page.setViewportSize({width:390,height:844});await page.screenshot({path:output+'/'+name+'-mobile.png',fullPage:true});evidence.screenshots.push(name+'-mobile.png');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' mobile overflow');}
  const sourceQuestions=await ws.evaluate(()=>extractedQuestions);
  const solvingResponse=ws.waitForResponse(r=>r.url().endsWith('/api/solve_worksheet'));
  await ws.locator('#solve-btn').click();const solving=(await (await solvingResponse).json()).job_id;assert.ok(solving);
  await ws.goto(base+'/');
  const solved=await awaitTask(solving);
  assert.ok(['completed','needs_attention'].includes(solved.status),JSON.stringify(solved));
  await ws.goto(base+'/edit/'+solved.quiz_id);assert.match(await ws.textContent('body'),/7b/);
  const finalizedJob=await dashboard.evaluate(async questions=>{const r=await fetch('/api/generate_quiz_from_extracted',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({async_job:true,idempotency_key:crypto.randomUUID(),questions,api_key:'synthetic-key',subject:'English',topic:'Answer-key finalization',create_draft:true})});return r.json();},sourceQuestions);
  assert.ok(finalizedJob.job_id,JSON.stringify(finalizedJob));await dashboard.goto(base+'/worksheet_answers');
  const finalTask=await awaitTask(finalizedJob.job_id);
  assert.ok(['completed','needs_attention'].includes(finalTask.status),JSON.stringify(finalTask));
  console.log('Browser scenario complete');evidence.scenarios.push({name:'Worksheet solving and finalization jobs survive navigation and open drafts preserving 7b',pass:true});
  for(const path of ['/worksheet_answers','/edit/tutorial']){await dashboard.goto(base+path);assert.ok(await dashboard.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),path+' mobile overflow');}
  console.log('Browser scenario complete');evidence.scenarios.push({name:'Desktop/mobile dashboard, live, worksheet, answer-key page and editor',pass:true});
  assert.deepEqual(evidence.errors,[]);evidence.pass=true;
} catch(error){evidence.pass=false;evidence.failure=error.stack;console.error(error);process.exitCode=1;}
finally {if(browser)await browser.close();server.kill();await fs.writeFile(output+'/evidence.json',JSON.stringify(evidence,null,2));await fs.writeFile(output+'/server.log',logs);}
