import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
const output='docs/r4-2-browser';await fs.mkdir(output,{recursive:true});
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
    ctx.on('page',p=>{p.on('pageerror',e=>evidence.errors.push(e.stack));p.on('dialog',d=>d.accept());});return ctx;}
  const teacher=await context(tokens.teacher),monitor=await teacher.newPage();await monitor.goto(base+'/live/tutorial');
  await monitor.locator('#run-label').filter({hasText:'Standalone'}).waitFor();
  await monitor.getByRole('button',{name:'Start New Session',exact:true}).click();
  await monitor.waitForFunction(()=>document.querySelector('#run-label').textContent.includes('Active'));
  const current=()=>monitor.evaluate(async()=> (await (await fetch('/api/live/tutorial')).json()));
  const a=(await current()).run;
  async function student(index,label) {
    const ctx=await context(tokens.students[index]),page=await ctx.newPage();await page.goto(base+'/quiz/tutorial');
    await page.locator('#student-name').fill(label);await page.getByRole('button',{name:'Start Quiz',exact:true}).click();
    await page.locator('.option-btn').first().click();await page.locator('#btn-next').click();
    await page.waitForFunction(()=>progressiveResults[0]?.grade_status==='graded');
    return {ctx,page,id:await page.evaluate(()=>sessionId)};
  }
  const old=await student(0,'Morning Student');
  await monitor.waitForFunction(()=>document.querySelector('#live-table tbody').textContent.includes('Morning Student'));
  assert.equal((await current()).sessions[old.id].score,1);
  await monitor.getByRole('button',{name:'End Session',exact:true}).click();
  await monitor.waitForFunction(()=>document.querySelector('#run-label').textContent.includes('Ended'));
  await monitor.getByRole('button',{name:'Start New Session',exact:true}).click();
  await monitor.waitForFunction(()=>document.querySelector('#run-label').textContent.includes('Active'));
  assert.equal(Object.keys((await current()).sessions).length,0);
  const b=(await current()).run;assert.notEqual(a.id,b.id);
  const afternoon=await student(1,'Afternoon Student'),second=await student(2,'Second Afternoon');
  await monitor.waitForFunction(()=>document.querySelector('#live-table tbody').textContent.includes('Second Afternoon'));
  let snapshot=await current();assert.deepEqual(Object.keys(snapshot.sessions).sort(),[afternoon.id,second.id].sort());
  assert.equal(snapshot.sessions[afternoon.id].score,1);assert.equal(snapshot.terminated,false);
  assert.ok(!await monitor.locator('#live-table tbody').textContent().then(t=>t.includes('Morning Student')));
  evidence.scenarios.push({name:'Terminate morning run, start afternoon run, two new students answer and only afternoon roster appears',pass:true});
  const historical=await old.page.evaluate(async sid=> {
    const response=await fetch('/api/load_progressive_result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({quiz_id:'tutorial',session_id:sid})});return response.json();
  },old.id);assert.equal(historical.success,true);
  const stale=await old.page.evaluate(async sid=>(await (await fetch('/ping',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({quiz_id:'tutorial',session_id:sid})})).json()),old.id);
  assert.equal(stale.terminated,true);assert.equal(Object.keys((await current()).sessions).length,2);
  evidence.scenarios.push({name:'Morning grades remain readable; old-run ping cannot join afternoon roster',pass:true});
  const before=await afternoon.page.evaluate(()=>({id:sessionId,answer:answers[0]}));
  await afternoon.ctx.setOffline(true);await afternoon.page.waitForTimeout(200);await afternoon.ctx.setOffline(false);await afternoon.page.reload();
  await afternoon.page.waitForFunction(()=>quizStartTime && studentName==='Afternoon Student');
  assert.equal(await afternoon.page.evaluate(()=>sessionId),before.id);assert.equal(await afternoon.page.evaluate(()=>answers[0]),before.answer);
  await monitor.getByRole('button',{name:/Pause Timers/}).click();await afternoon.page.waitForFunction(()=>isPaused===true);
  await monitor.getByRole('button',{name:/Resume Timers/}).click();await afternoon.page.waitForFunction(()=>isPaused===false);
  assert.equal(Object.keys((await current()).sessions).length,2);
  evidence.scenarios.push({name:'Refresh/reconnect retains run, attempt and answer without duplicate rows; pause/resume reaches current students',pass:true});
  await monitor.screenshot({path:output+'/live-desktop.png',fullPage:true});evidence.screenshots.push('live-desktop.png');
  await monitor.setViewportSize({width:390,height:844});await monitor.screenshot({path:output+'/live-mobile.png',fullPage:true});evidence.screenshots.push('live-mobile.png');
  assert.ok(await monitor.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile overflow');
  await monitor.getByRole('button',{name:'Start New Session',exact:true}).click();
  await monitor.waitForFunction(()=>Object.keys(sessionsCache).length===0);
  assert.notEqual((await current()).run.id,b.id);
  evidence.scenarios.push({name:'Explicit replacement of active afternoon run starts third empty session; desktop/mobile layout fits',pass:true});
  assert.deepEqual(evidence.errors,[]);evidence.pass=true;
} catch(error){evidence.pass=false;evidence.failure=error.stack;console.error(error);process.exitCode=1;}
finally {if(browser)await browser.close();server.kill();await fs.writeFile(output+'/evidence.json',JSON.stringify(evidence,null,2));await fs.writeFile(output+'/server.log',logs);}
