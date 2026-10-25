import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';

const output='.local/ui-audit-2026-10-25';
await fs.mkdir(output,{recursive:true});
const server=spawn(process.execPath,['--require','./test/tsx-bootstrap.cjs','--import','tsx','test/r4-browser-server.ts'],{stdio:['ignore','pipe','pipe']});
let logs='',browser;
server.stdout.on('data',c=>logs+=c);server.stderr.on('data',c=>logs+=c);
const evidence={mode:'Local synthetic records; mocked AI and external assets; actual app routes/scripts',checks:[],inventory:[],layouts:[],errors:[],failedRequests:[]};
try {
  for(let i=0;i<100&&!logs.includes('R4 synthetic server ready');i++){if(server.exitCode!==null)throw Error(logs);await new Promise(r=>setTimeout(r,200));}
  assert.match(logs,/R4 synthetic server ready/);
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1366,height:900},extraHTTPHeaders:{authorization:'Bearer user_teacher_test'}});
  await context.route('https://**/*',r=>r.fulfill({status:200,contentType:'application/javascript',body:r.request().url().includes('firebase-auth.js')?'export const getAuth=()=>({}),signOut=async()=>{};':r.request().url().includes('firebase-app.js')?'export const initializeApp=()=>({});':'/* offline external asset */'}));
  await context.addInitScript(()=>localStorage.setItem('tour_completed','true'));
  const page=await context.newPage();page.on('pageerror',e=>evidence.errors.push(e.message));page.on('requestfailed',r=>evidence.failedRequests.push({url:r.url(),error:r.failure()?.errorText}));
  await page.route('**/api/usage/stats',r=>r.fulfill({status:403,json:{error:'Synthetic teacher cannot access admin usage'}}));
  page.on('dialog',d=>d.dismiss());
  const go=async path=>{const r=await page.goto('http://127.0.0.1:3000'+path);assert.ok(r.status()<400,path);};
  await go('/');await page.getByRole('button',{name:'Generate with AI',exact:true}).click();await page.locator('#generator-advanced').evaluate(e=>e.open=true);
  assert.equal(await page.locator('#api-counter-badge').textContent(),'Quota unavailable');
  await page.locator('#model_select').selectOption('gemini-3.1-flash-lite');
  await page.waitForFunction(()=>document.getElementById('api-counter-badge').textContent.trim()==='Quota unavailable');
  evidence.checks.push('Dashboard quota stays unknown for both hosted models without browser keys');
  await page.evaluate(()=>localStorage.setItem('gemini_api_keys',JSON.stringify(['synthetic-a','synthetic-b'])));
  await page.reload();await page.getByRole('button',{name:'Generate with AI',exact:true}).click();
  await page.locator('#generator-advanced').evaluate(e=>e.open=true);
  assert.equal(await page.locator('#api-counter-badge').textContent(),'Quota unavailable');
  evidence.checks.push('Two synthetic keys and a denied usage endpoint never fabricate provider quota');
  await page.locator('#searchInput').fill('no such synthetic quiz');assert.equal(await page.locator('.quiz-item:visible').count(),0);
  await page.locator('#searchInput').fill('');await page.locator('#library-status').selectOption('draft');
  evidence.checks.push('Search empty state and draft filter exercised');
  for(const [name,path] of [['dashboard','/'],['editor','/edit/r4_draft'],['worksheet','/worksheet'],['answer-key','/worksheet_answers'],['rmx','/rmxflash'],['student','/quiz/r4_published'],['live','/live/r4_published'],['results','/results/r4_published'],['solutions','/solutions/r4_result'],['preview','/preview/r4_published'],['print','/worksheet/r4_published'],['admin','/admin']]) {
    await go(path);
    if(['worksheet','answer-key'].includes(name)) {
      await page.getByText('Extraction options',{exact:true}).click();
      await page.waitForFunction(()=>document.getElementById('api-counter-badge').textContent.trim()==='Quota unavailable');
      await page.locator('#model_select').selectOption('gemini-3.1-flash-lite');
      assert.equal(await page.locator('#api-counter-badge').textContent(),'Quota unavailable');
      evidence.checks.push(name+': truthful quota for both hosted models');
    }
    evidence.inventory.push({page:name,controls:await page.locator('button,a,input,select,textarea,summary').evaluateAll(elements=>elements.map(e=>({tag:e.tagName,label:e.getAttribute('aria-label')||e.getAttribute('placeholder')||e.textContent.trim().slice(0,100),id:e.id,type:e.type,disabled:e.disabled||false,visible:!!e.getClientRects().length,status:'Inventoried; see report for exercised subsets'})))});
    for(const [width,theme] of [[1366,'dark'],[390,'light']]) {
      await page.setViewportSize({width,height:900});
      await page.evaluate(theme=>{if(document.documentElement.dataset.theme!==theme)window.toggleTheme?.();},theme);
      if(name==='print') await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth+1);
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
      if(name==='rmx') assert.equal(overflow,false,'RMX header must fit mobile with admin controls');
      evidence.layouts.push({page:name,width,theme,overflow});
      await page.screenshot({path:output+'/'+name+'-'+width+'-'+theme+'.png',fullPage:true});
    }
  }
  assert.deepEqual(evidence.errors,[]);
} finally {
  await fs.writeFile(output+'/local-evidence.json',JSON.stringify(evidence,null,2));
  await browser?.close();server.kill();
}
console.log(JSON.stringify({checks:evidence.checks,layouts:evidence.layouts,errors:evidence.errors},null,2));
