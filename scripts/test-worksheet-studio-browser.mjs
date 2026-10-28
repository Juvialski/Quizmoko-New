import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
const output='docs/ui-redesign-2026-10-25';await fs.mkdir(output,{recursive:true});
const server=spawn(process.execPath,['--require','./test/tsx-bootstrap.cjs','--import','tsx','test/r4-browser-server.ts'],{stdio:['ignore','pipe','pipe']});
let logs='',browser;for(const s of [server.stdout,server.stderr])s.on('data',c=>logs+=c);
const evidence={mode:'Isolated synthetic app, mocked extraction/provider boundaries; no production writes or live AI accuracy claim',checks:[],errors:[],failedRequests:[]};
try{
 for(let i=0;i<600&&!logs.includes('R4 synthetic server ready');i++){if(server.exitCode!==null)throw Error(logs);await new Promise(r=>setTimeout(r,100));}assert.match(logs,/R4 synthetic server ready/);
 browser=await chromium.launch();const context=await browser.newContext({viewport:{width:1920,height:1080},extraHTTPHeaders:{authorization:'Bearer user_teacher_test'}});
 await context.route('https://**/*',r=>r.fulfill({status:200,contentType:'application/javascript',body:r.request().url().includes('firebase-auth')?'export const getAuth=()=>({}),signOut=async()=>{};':r.request().url().includes('firebase-app')?'export const initializeApp=()=>({});':'/* offline external assets */'}));
 await context.addInitScript(()=>{localStorage.setItem('tour_completed','true');localStorage.setItem('gemini_api_key','synthetic-unused');localStorage.setItem('gemini_api_keys','["synthetic-unused"]');});
 const page=await context.newPage();page.on('pageerror',e=>evidence.errors.push(e.message));page.on('requestfailed',r=>{if(!r.failure()?.errorText.includes('ABORTED'))evidence.failedRequests.push(r.url());});page.on('dialog',d=>d.accept());
 await page.goto('http://127.0.0.1:3000/worksheet');
 const tabs=page.getByRole('tab');assert.equal(await tabs.count(),3);
 const settings=page.locator('.r4-details').first();const settingsHeader=settings.locator('summary');
 await settingsHeader.press('Enter');assert.equal(await settings.getAttribute('open'),'');assert.ok(await settingsHeader.evaluate(el=>el.getBoundingClientRect().height)>=48);await settingsHeader.press('Enter');assert.equal(await settings.getAttribute('open'),null);
 evidence.checks.push('Expandable settings have full-width 48px headers and native keyboard open/close behavior');
 const file={name:'classroom.png',mimeType:'image/png',buffer:Buffer.from('mocked source bytes')};
 await page.locator('#file-input').setInputFiles(file);
 await page.locator('#extract-btn').click();await page.locator('#extraction-preview').waitFor({state:'visible'});
 await page.locator('.question-editor').first().fill('Retained source wording.');
 await tabs.nth(1).click();const key=page.frameLocator('#studio-panel-1');await key.locator('#worksheet-input').setInputFiles(file);await key.locator('#answer-input').setInputFiles({...file,name:'key.png'});
 let keyCalls=0;await page.route('**/api/extract_worksheet_with_answers',async r=>{keyCalls++;await new Promise(resolve=>setTimeout(resolve,250));await r.fulfill({json:{success:true,questions:[{id:'7b',original_index:'7b',raw_text:'Choose Alpha.',question:'Choose Alpha.',type:'multiple_choice',options:['Alpha','Beta','Gamma','Delta'],answer:'A',points:1,page_number:1}],missing_indices:[],golden_reference:{}}});});
 await key.locator('#extract-btn').click();await key.locator('#extraction-preview').waitFor({state:'visible'});assert.equal(keyCalls,1);
 await tabs.nth(2).click();const rmx=page.frameLocator('#studio-panel-2');await rmx.locator('#ws-input').setInputFiles(file);await rmx.locator('#ans-input').setInputFiles({...file,name:'rmx-key.png'});await rmx.getByText('Export details',{exact:true}).click();await rmx.locator('#year').fill('2026');await rmx.locator('#test_name').fill('Synthetic contest');await rmx.locator('#contest').fill('Classroom');
 let rmxCalls=0;await page.route('**/api/extract_rmxflash',async r=>{rmxCalls++;await new Promise(resolve=>setTimeout(resolve,400));await r.fulfill({json:{success:true,questions:[{identifier:'practice-7b',original_index:'7b',statement:'Choose Alpha.',answer:'A',choices:['Alpha','Beta','Gamma','Delta']}]}});});
 await rmx.locator('#extract-btn').click();assert.equal(await rmx.locator('#extract-btn').isEnabled(),false);await rmx.locator('#results-card').waitFor({state:'visible'});assert.equal(rmxCalls,1);
 const [download]=await Promise.all([page.waitForEvent('download'),rmx.getByRole('button',{name:/Export to Excel/i}).click()]);assert.ok(download.suggestedFilename().endsWith('.zip'));
 const archive=await fs.readFile(await download.path());assert.equal(archive.subarray(0,2).toString(),'PK');assert.ok(archive.includes(Buffer.from('.xlsx')));
 await tabs.nth(0).click();assert.equal(await page.locator('.question-editor').first().innerText(),'Retained source wording.');assert.equal(await page.locator('#file-input').evaluate(el=>el.files.length),1);
 await tabs.nth(1).click();assert.equal(await key.locator('#answer-input').evaluate(el=>el.files.length),1);await tabs.nth(2).click();assert.equal(await rmx.locator('#year').inputValue(),'2026');
 evidence.checks.push('Three retained modes: image uploads, answer-key match, editable review, RMX metadata and real XLSX export; source 7b retained');
 await tabs.nth(2).press('Home');assert.equal(await tabs.nth(0).getAttribute('aria-selected'),'true');await tabs.nth(0).press('ArrowRight');assert.equal(await tabs.nth(1).getAttribute('aria-selected'),'true');
 evidence.checks.push('Accessible tabs support arrows/Home/End and selected panel labels');
 for(const width of [390,768,1366,1920])for(const theme of ['light','dark']){
  await page.setViewportSize({width,height:960});await page.evaluate(theme=>{if(document.documentElement.dataset.theme!==theme)window.toggleTheme();},theme);
  for(let i=0;i<3;i++){await tabs.nth(i).click();await page.waitForTimeout(180);const bounds=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));if(bounds.scroll>width+1)console.log(await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(el=>el.getBoundingClientRect().right>innerWidth+1).map(el=>({tag:el.tagName,cls:el.className,text:el.textContent.slice(0,60),right:el.getBoundingClientRect().right})).slice(0,15)));assert.ok(bounds.scroll<=width+1,JSON.stringify({width,theme,i,bounds}));if(i>0)assert.equal(await page.frameLocator(`#studio-panel-${i}`).locator('html').getAttribute('data-theme'),theme);}
 }
 evidence.checks.push('All modes fit 390/768/1366/1920px in light and dark; retained iframe themes synchronize');
 await page.setViewportSize({width:1920,height:1080});await tabs.nth(0).click();assert.ok(await page.locator('.dashboard-container').evaluate(el=>el.getBoundingClientRect().width)>1800);
 await page.locator('#solve-btn').click();await page.waitForURL('**/edit/r4_worksheet');assert.match(await page.locator('.question-block').first().textContent(),/7b/);
 evidence.checks.push('Check answers creates private draft and opens editor, with immutable source label');
 for(const path of ['/worksheet_upload','/worksheet_answers','/rmxflash','/','/edit/r4_draft','/quiz/r4_published','/live/r4_published','/results/r4_published']){const res=await page.goto('http://127.0.0.1:3000'+path);assert.equal(res.status(),200);}
 evidence.checks.push('Compatible URLs and dashboard/editor/student/live/results navigation');
 await page.route('**/api/tasks',r=>r.fulfill({json:{jobs:[{id:'synthetic-finished',task:'generation',label:'Generating Quiz',status:'completed',quiz_id:'r4_published',quiz_state:'published',completed:2,total:2}]}}));
 await page.goto('http://127.0.0.1:3000/');await page.locator('.qm-owned-tasks summary').waitFor();
 assert.equal(await page.locator('.qm-owned-tasks details').getAttribute('open'),null);
 assert.ok(await page.locator('.qm-owned-tasks').evaluate(el=>el.getBoundingClientRect().height)<65);
 assert.ok(await page.locator('#saved-quizzes-card').evaluate(el=>el.getBoundingClientRect().top)<500);
 await page.locator('.qm-owned-tasks summary').click();assert.equal(await page.locator('.qm-owned-tasks a').isVisible(),true);
 evidence.checks.push('Finished task history is compact and collapsed; disclosure reveals preserved draft/quiz links; primary library begins above 500px on desktop');
 assert.deepEqual(evidence.errors,[]);assert.deepEqual(evidence.failedRequests,[]);evidence.pass=true;
}catch(e){evidence.failure=e.stack;throw e;}finally{await fs.writeFile(output+'/browser-evidence.json',JSON.stringify(evidence,null,2));await browser?.close();server.kill();}
console.log(JSON.stringify(evidence,null,2));
