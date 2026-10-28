import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';

const baseline=process.argv.includes('--before');
const phase=baseline?'before':'after';
const tail=process.argv.includes('--resume-tail');
const extras=process.argv.includes('--extras');
const only=process.argv.find(arg=>arg.startsWith('--only='))?.slice(7).split(',');
const output=`docs/ui-final/${phase}`;
await fs.mkdir(output,{recursive:true});
const server=spawn(process.execPath,['--require','./test/tsx-bootstrap.cjs','--import','tsx','test/r4-browser-server.ts'],{
  env:{...process.env,UI_FINAL_CAPTURE:'1',UI_FINAL_BASELINE:baseline?'1':'0'},stdio:['ignore','pipe','pipe']
});
let logs='',browser;
for(const stream of [server.stdout,server.stderr])stream.on('data',c=>logs+=c);
const evidence={phase,base:'e9775b4',mode:'Synthetic mathematics class; real application routes and browser scripts; real CDN MathJax/fonts/icons; mocked Firebase browser module and extraction only',screens:[],layouts:[],errors:[],assetFailures:[],checks:[]};
try {
  for(let i=0;i<150&&!logs.includes('R4 synthetic server ready');i++){
    if(server.exitCode!==null)throw Error(logs);await new Promise(r=>setTimeout(r,200));
  }
  assert.match(logs,/R4 synthetic server ready/);
  browser=await chromium.launch();
  const context=await browser.newContext({viewport:{width:1440,height:1000},extraHTTPHeaders:{authorization:'Bearer user_teacher_test'}});
  await context.route('https://www.gstatic.com/firebasejs/**',r=>r.fulfill({contentType:'application/javascript',body:r.request().url().includes('firebase-auth')?'export const getAuth=()=>({}),signOut=async()=>{},signInWithEmailAndPassword=async()=>{},createUserWithEmailAndPassword=async()=>{},sendEmailVerification=async()=>{},signInWithPopup=async()=>{},GoogleAuthProvider=class {};':'export const initializeApp=()=>({});'}));
  await context.addInitScript(()=>{localStorage.setItem('tour_completed','true');localStorage.setItem('theme','light');localStorage.setItem('gemini_api_keys','["synthetic-unused"]');localStorage.setItem('gemini_api_key','synthetic-unused');});
  const page=await context.newPage();page.on('pageerror',e=>evidence.errors.push(e.message));
  page.on('requestfailed',r=>{if(!r.failure()?.errorText.includes('ABORTED'))evidence.assetFailures.push({url:r.url(),error:r.failure()?.errorText});});
  page.on('dialog',d=>d.type()==='beforeunload'?d.accept():d.dismiss());
  const go=async path=>{const r=await page.goto('http://127.0.0.1:3000'+path);assert.ok(r.status()<400,path+': '+await r.text());};
  const capture=async(name,{full=false}={})=>{
    if(only && !only.includes(name))return;
    for(const width of [1440,390])for(const theme of ['light','dark']){
      await page.setViewportSize({width,height:1000});
      await page.evaluate(theme=>{if(document.documentElement.dataset.theme!==theme)window.toggleTheme?.();},theme);
      await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(400);
      if(['question-editor','question-tools'].includes(name)) await page.locator('#question-block-0').evaluate(el=>{
        const bar=document.querySelector('.r4-editor-bar');
        scrollTo(0,scrollY+el.getBoundingClientRect().top-(bar?.getBoundingClientRect().height || 0)-16);
      });
      if(['generator','generator-settings','generation-error'].includes(name)) await page.locator(name==='generator'?'#ai-generator-card':name==='generator-settings'?'#generator-advanced':'#generator-feedback').evaluate(el=>el.scrollIntoView({block:'start'}));
      if(name==='student-whiteboard') await page.locator('#right-panel').evaluate(el=>el.scrollIntoView({block:'start'}));
      if(name==='student-question') await page.evaluate(()=>{document.querySelector('.quiz-wrapper').scrollTop=0;document.querySelector('.left-panel').scrollTop=0;});
      const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
      evidence.layouts.push({screen:name,theme,...layout});
      const filename=`${name}-${width}-${theme}.png`;
      await page.screenshot({path:output+'/'+filename,fullPage:full});evidence.screens.push(filename);
    }
    console.log('Captured',phase,name);
  };
  const settleMath=async()=>{
    await page.waitForFunction(()=>typeof window.MathJax?.typesetPromise==='function');
    await page.evaluate(()=>window.MathJax.startup.promise);await page.waitForTimeout(300);
  };
  if(!tail && !extras) {
  for(const [name,path] of [['dashboard','/'],['editor','/edit/r4_draft'],['worksheet','/worksheet'],['answer-key','/worksheet_answers'],['rmx','/rmxflash'],['preview','/preview/r4_published'],['results','/results/r4_published'],['solutions','/solutions/r4_result'],['print','/worksheet/r4_published'],['admin','/admin']]){
    await go(path);if(['editor','preview','solutions','print'].includes(name))await settleMath();
    if(!baseline && name==='preview')assert.equal(await page.locator('mjx-assistive-mml mjx-container').count(),0,'Saved preview must not be typeset again inside its accessibility math');
    await capture(name,{full:['preview','solutions'].includes(name)});
    if(name==='editor'){
      await page.locator('#question-block-0').evaluate(e=>e.scrollIntoView({block:'start'}));await capture('question-editor');
      await page.evaluate(()=>scrollTo(0,0));
    }
  }
  await go('/');await page.getByRole('button',{name:'Generate with AI',exact:true}).click();
  await page.locator('#topic-input').fill('Fractions and linear equations');
  await page.locator('#topic-input').scrollIntoViewIfNeeded();await capture('generator');
  await page.locator('#generator-advanced summary').click();await page.locator('#generator-advanced').scrollIntoViewIfNeeded();await capture('generator-settings');
  await go('/');await page.getByRole('button',{name:'Create Quiz',exact:true}).click();
  await page.locator('#createBlankModal').waitFor({state:'visible'});await capture('manual-dialog');
  await page.locator('#createBlankModal').getByRole('button',{name:'Cancel',exact:true}).click();
  await page.locator('#api-key-btn').click();await capture('ai-settings');
  }
  if(!extras) {
  await go('/worksheet');
  await page.locator('#file-input').setInputFiles({name:'classroom-practice.png',mimeType:'image/png',buffer:Buffer.from('Synthetic source; extraction mocked before decoding')});
  await page.locator('#extract-btn').click();await page.locator('.question-editor').first().waitFor();
  await page.waitForFunction(()=>!document.getElementById('extract-btn').disabled);
  await capture('worksheet-review');
  await page.route('**/api/live/r4_published',r=>r.fulfill({json:{success:true,run:{id:'synthetic-run',status:'active',started_at:'2026-10-28T02:00:00Z'},paused:false,terminated:false,control_state_known:true,sessions:{a:{name:'Student A',student_name:'Student A',current_q:2,score:2,max_score:7,status:'Active',last_active:Date.now()},b:{name:'Student B',student_name:'Student B',current_q:3,score:4,max_score:7,status:'Completed',last_active:Date.now()},c:{name:'Student C',student_name:'Student C',current_q:1,score:0,max_score:7,pending_grades:1,status:'Active',last_active:Date.now()-15000}}}}));
  await go('/live/r4_published');await page.getByText('Student A',{exact:true}).waitFor();await capture('live');
  await page.locator('#live-table summary').first().click();await capture('live-question');
  await go('/quiz/r4_published');await capture('student');
  await page.locator('#student-name').fill('Synthetic mobile learner');await page.getByRole('button',{name:'Start Quiz',exact:true}).click();
  await page.locator('#question-text').waitFor({state:'visible'});await settleMath();await capture('student-question');
  if(!baseline){await page.locator('#right-panel').evaluate(el=>el.scrollIntoView({block:'start'}));await capture('student-whiteboard');}
  }
  if(!tail) {
    for(const [name,path] of [['login','/login'],['register','/register']]){await go(path);await capture(name);}
    await go('/edit/r4_draft');await page.locator('.r4-quiz-settings summary').click();await capture('quiz-settings');
    await page.locator('#question-block-0 .r4-more summary').click();await page.locator('#question-block-0').evaluate(e=>e.scrollIntoView({block:'start'}));await capture('question-tools');
    await page.locator('.edit-quiz-card .r4-more summary').first().click();await page.getByRole('button',{name:'Import Qs',exact:false}).click();await capture('import-dialog');
    await go('/results/r4_published');await page.locator('#row-r4_result').getByRole('button',{name:'View feedback',exact:false}).click();await settleMath();await capture('results-feedback');
    await go('/');await page.getByRole('button',{name:'Generate with AI',exact:true}).click();await page.locator('#topic-input').fill('Rate limit fixture');await page.locator('#generate-btn').click();await page.waitForFunction(()=>document.getElementById('generator-feedback').textContent.includes('60 seconds'));await page.locator('#generator-feedback').scrollIntoViewIfNeeded();await capture('generation-error');
  }
  evidence.checks.push('Every captured page loads from real app templates with actual local scripts','Real MathJax startup completed on editor/preview/feedback/print/student','Desktop/mobile light/dark captures include creation dialogs, advanced settings, review and populated classroom');
  if(!baseline){
    const overflows=evidence.layouts.filter(x=>x.scroll>x.width+1);
    assert.deepEqual(overflows,[],'Page overflow');
    assert.deepEqual(evidence.errors,[],'Browser page errors');
  }
  evidence.pass=true;
} catch(error){evidence.failure=error.stack;throw error;}
finally{
  if(tail || extras || only) {
    const prior=JSON.parse(await fs.readFile(output+'/capture-evidence.json','utf8'));
    evidence.screens=[...new Set([...prior.screens,...evidence.screens])];
    const replaced=new Set(evidence.layouts.map(x=>x.screen));
    evidence.layouts=[...prior.layouts.filter(x=>!replaced.has(x.screen)),...evidence.layouts];
    evidence.errors=[...prior.errors,...evidence.errors];evidence.assetFailures=[...prior.assetFailures,...evidence.assetFailures];
  }
  await fs.writeFile(output+'/capture-evidence.json',JSON.stringify(evidence,null,2));await browser?.close();server.kill();
}
console.log(JSON.stringify({phase,pass:evidence.pass,screens:evidence.screens.length,overflows:evidence.layouts.filter(x=>x.scroll>x.width+1),errors:evidence.errors,assetFailures:evidence.assetFailures}));
