import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
const output='.local/final-ui';await fs.mkdir(output,{recursive:true});
const server=spawn(process.execPath,['--require','./test/tsx-bootstrap.cjs','--import','tsx','test/r4-browser-server.ts'],{env:{...process.env,FINAL_UI_FIXTURES:'1'},stdio:['ignore','pipe','pipe']});
let logs='',browser;server.stdout.on('data',c=>logs+=c);server.stderr.on('data',c=>logs+=c);
const evidence={checks:[],errors:[],mode:'Synthetic local data; actual app scripts/routes; mocked provider/external assets'};
try {
  for(let i=0;i<150&&!logs.includes('R4 synthetic server ready');i++){if(server.exitCode!==null)throw Error(logs);await new Promise(r=>setTimeout(r,200));}
  assert.match(logs,/R4 synthetic server ready/);browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1366,height:900},extraHTTPHeaders:{authorization:'Bearer user_teacher_test'}});
  const png=await (await import('sharp')).default({create:{width:40,height:40,channels:3,background:'#123456'}}).png().toBuffer();
  await context.route('https://**/*',async r=>{
    const url=r.request().url();
    if(url.endsWith('/broken'))return r.fulfill({status:404,body:'not found'});
    if(url.endsWith('/slow')){await new Promise(resolve=>setTimeout(resolve,12000));return r.fulfill({status:200,contentType:'image/png',body:png}).catch(()=>{});}
    return r.fulfill({status:200,contentType:'application/javascript',body:url.includes('firebase-auth.js')?'export const getAuth=()=>({}),signOut=async()=>{};':url.includes('firebase-app.js')?'export const initializeApp=()=>({});':'/* synthetic external assets */'});
  });
  await context.addInitScript(()=>localStorage.setItem('tour_completed','true'));
  const page=await context.newPage();page.on('pageerror',e=>evidence.errors.push(e.message));page.on('dialog',d=>d.dismiss());
  const go=path=>page.goto('http://127.0.0.1:3000'+path,{waitUntil:'domcontentloaded'});
  const clean=async()=>{
    assert.equal(await page.locator('#publication-status').textContent(),'Published');assert.equal(await page.locator('#save-status').textContent(),'Saved');
    assert.equal(await page.evaluate(()=>editorSnapshot()===savedSnapshot),true);
    assert.equal(await page.evaluate(()=>quizData.questions.every(q=>q.verification.verification_status==='verified')),true);
  };
  await go('/edit/reliable_diagrams');const initial=await page.evaluate(()=>JSON.stringify(quizData));
  assert.equal(await page.locator('.question-block:visible').count(),30);
  await page.waitForTimeout(11000);await clean();
  assert.ok(await page.locator('img[data-render-state=waiting]').count()>0,'Offscreen diagrams must stay waiting beyond old timeout');
  for(let i=0;i<30;i++){
    const card=page.locator('#question-block-'+i);await card.scrollIntoViewIfNeeded();
    await card.locator('img[data-render-state=decoded]').waitFor();
  }
  await clean();assert.equal(await page.evaluate(()=>JSON.stringify(quizData)),initial);
  await page.screenshot({path:output+'/published-diagrams.png'});await page.reload();await clean();
  console.log('Final UI scenario complete');evidence.checks.push('30 published source-labelled diagrams: wait 11s offscreen, scroll/decode every question, no metadata or dirty changes, reload clean');
  for(const id of ['broken','corrupt']){
    await go('/edit/image_'+id);await page.locator('.live-preview img').scrollIntoViewIfNeeded();await page.locator('img[data-render-state=failed]').waitFor();await clean();
    assert.equal(await page.locator('.diagram-render-notice:visible').count(),1);
    let writes=0;const listener=r=>{if(r.url().includes('/update/'))writes++;};page.on('request',listener);
    assert.equal(await page.evaluate(()=>saveQuiz(false,null,null,'publish')),false);assert.equal(writes,0);page.off('request',listener);
  }
  console.log('Final UI scenario complete');evidence.checks.push('Broken and corrupt images show one transient warning, do not dirty/approve questions and block explicit publication');
  await go('/edit/image_slow');await page.locator('.live-preview img').scrollIntoViewIfNeeded();
  await page.locator('img[data-render-state=loading]').waitFor({state:'attached'});await page.waitForTimeout(10500);await clean();
  assert.match(await page.locator('.diagram-render-notice').textContent(),/still loading/);
  await page.locator('img[data-render-state=decoded]').waitFor();await clean();
  console.log('Final UI scenario complete');evidence.checks.push('12-second active image load stays loading (not failed), eventually decodes, quiz stays saved');
  await go('/edit/image_slow');await page.locator('.live-preview img').scrollIntoViewIfNeeded();
  await page.evaluate(()=>{window.oldImage=document.querySelector('.live-preview img');renderQuestions();oldImage.dispatchEvent(new Event('error'));});
  await page.waitForTimeout(12000);await clean();assert.equal(await page.locator('.diagram-render-notice:visible').count(),0);
  console.log('Final UI scenario complete');evidence.checks.push('Detached/obsolete render callbacks cannot dirty or warn on replacement preview');
  await go('/');await page.locator('.qm-owned-tasks summary').click();await page.locator('.qm-owned-tasks').getByRole('link',{name:'Open quiz',exact:true}).waitFor();
  assert.equal(await page.locator('.qm-owned-tasks a[href="/edit/reliable_diagrams"]').count(),1);
  assert.match(await page.locator('.qm-owned-tasks').textContent(),/Saved quiz is Published/);
  assert.doesNotMatch(await page.locator('.qm-owned-tasks').textContent(),/needs attention/);
  assert.match(await page.locator('.qm-owned-tasks').textContent(),/Synthetic provider unavailable/);
  assert.equal(await page.getByRole('link',{name:'Review inputs & retry'}).count(),1);
  assert.equal(await page.locator('#sync-history-btn,#today-total-calls,#all-time-calls').count(),0);
  console.log('Final UI scenario complete');evidence.checks.push('Historical flagged published job reconciles to current quiz; duplicates suppressed; failures show errors and deliberate retry; fake usage controls absent');
  await go('/worksheet/r4_published');await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth+1);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.ok(await page.locator('#worksheet-content').evaluate(e=>Number(getComputedStyle(e).zoom)<1));
  assert.equal(await page.locator('#worksheet-content').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');
  assert.ok(await page.locator('#paperSize').evaluate(e=>e.getBoundingClientRect().width>120));
  const pageSize=await page.locator('#dynamic-page-style').textContent();await page.emulateMedia({media:'print'});
  assert.equal(await page.locator('#worksheet-content').evaluate(e=>getComputedStyle(e).zoom),'1');assert.equal(await page.locator('#dynamic-page-style').textContent(),pageSize);
  await page.emulateMedia({media:'screen'});await page.screenshot({path:output+'/worksheet-mobile.png',fullPage:true});
  console.log('Final UI scenario complete');evidence.checks.push('390px paper preview fits screen; print zoom resets to 1 and paper @page dimensions remain unchanged');
  assert.deepEqual(evidence.errors,[]);evidence.pass=true;
}catch(error){evidence.failure=error.stack;throw error;}
finally{await fs.writeFile(output+'/evidence.json',JSON.stringify(evidence,null,2));await browser?.close();server.kill();}
console.log(JSON.stringify(evidence,null,2));
