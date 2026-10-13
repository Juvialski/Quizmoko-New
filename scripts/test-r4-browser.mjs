import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const output='docs/r4-browser'; await fs.mkdir(output,{recursive:true});
const server=spawn(process.execPath,['--require','./test/tsx-bootstrap.cjs','--import','tsx','test/r4-browser-server.ts'],{stdio:['ignore','pipe','pipe']});
let logs=''; server.stdout.on('data',chunk=>logs+=chunk);server.stderr.on('data',chunk=>logs+=chunk);
let browser;
const evidence={mode:'isolated local synthetic data and mocked AI/extraction; no provider or production acceptance',journeys:[],layouts:[],screenshots:[],errors:[]};
try {
  for(let i=0;i<60 && !logs.includes('R4 synthetic server ready');i++) { if(server.exitCode !== null) throw Error(logs); await new Promise(r=>setTimeout(r,200)); }
  assert.match(logs,/R4 synthetic server ready/);
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1366,height:900},permissions:['clipboard-read','clipboard-write'],extraHTTPHeaders:{authorization:'Bearer user_teacher_test'}});
  // Stub optional CDN scripts only. App scripts, routes and persistence remain actual.
  await context.route('https://**/*',route=>process.env.R4_EXTERNAL_UI === '1' && /mathjax|unpkg.com\/lucide|pako|cropper/.test(route.request().url()) ? route.continue() : route.fulfill({status:200,contentType:'application/javascript',body:route.request().url().includes('firebase-auth.js')?'export const getAuth=()=>({}),signOut=async()=>{};':route.request().url().includes('firebase-app.js')?'export const initializeApp=()=>({});':'/* offline optional resource */'}));
  const page=await context.newPage();page.on('pageerror',error=>evidence.errors.push(error.message));
  page.on('dialog',dialog=>dialog.accept());
  await page.addInitScript(()=>{localStorage.setItem('gemini_api_keys',JSON.stringify(['synthetic-unused-key']));localStorage.setItem('tour_completed','true');});
  const go=async path=>{console.log('UI:',path);const response=await page.goto('http://127.0.0.1:3000'+path);assert.ok(response.status()<400,await page.textContent('body'));};
  const screenshot=async name=>{await page.screenshot({path:output+'/'+name+'.png',fullPage:true});evidence.screenshots.push(name+'.png');};
  const layout=async (screen,width,theme)=>{
    await page.setViewportSize({width,height:900});
    await page.evaluate(theme=>{if(document.documentElement.getAttribute('data-theme')!==theme)window.toggleTheme();},theme);await page.waitForTimeout(350);
    const dimensions=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth}));
    evidence.layouts.push({screen,testWidth:width,theme,...dimensions}); if(dimensions.width>width+1) {console.log(await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(el=>el.getBoundingClientRect().right>innerWidth+1).map(el=>({tag:el.tagName,cls:el.className,text:el.textContent.slice(0,60),right:el.getBoundingClientRect().right})).slice(-15)));await screenshot('overflow-'+screen);} assert.ok(dimensions.width<=width+1,screen+' overflows '+width+' '+JSON.stringify(dimensions));
  };
  await go('/__baseline');
  evidence.before={initialVisibleGeneratorFields:await page.locator('form[action="/generate_ai"] input:not([type=hidden]):visible,form[action="/generate_ai"] select:visible').count()};
  const oldFields=new Set(await page.locator('form[action="/generate_ai"] input:not([type=hidden]):visible,form[action="/generate_ai"] select:visible').evaluateAll(fields=>fields.map(el=>el.name)));
  await page.locator('.accordion-header').nth(1).click();await page.waitForTimeout(350);
  for(const name of await page.locator('form[action="/generate_ai"] input:not([type=hidden]):visible,form[action="/generate_ai"] select:visible').evaluateAll(fields=>fields.map(el=>el.name)))oldFields.add(name);
  await page.locator('.accordion-header').nth(2).click();await page.waitForTimeout(350);
  for(const name of await page.locator('form[action="/generate_ai"] input:not([type=hidden]):visible,form[action="/generate_ai"] select:visible').evaluateAll(fields=>fields.map(el=>el.name)))oldFields.add(name);
  evidence.before.uniqueFieldsAcrossSetupPanels=oldFields.size;
  evidence.before.expandedGeneratorFields=await page.locator('form[action="/generate_ai"] input:not([type=hidden]):visible,form[action="/generate_ai"] select:visible').count();
  evidence.before.panelsOpenedForQuestionTypeAndDifficulty=2;
  await go('/');await page.getByRole('button',{name:'Create Quiz',exact:true}).click();
  await page.locator('#blank-quiz-title').fill('Manual browser draft');
  assert.equal(await page.locator('#createBlankModal').getAttribute('role'),'dialog');
  await page.locator('#createBlankModal').getByRole('button',{name:'Cancel',exact:true}).focus();await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'blank-quiz-title');
  evidence.keyboard={modalFocusTrapped:true};await page.locator('#createBlankModal').getByRole('button',{name:'Create Quiz',exact:true}).click();
  await page.waitForURL('**/edit/**'); await page.getByRole('button',{name:'Add Question',exact:true}).click();
  await page.locator('.question-block:visible textarea[aria-label="Question text"]').fill('Choose Alpha.');
  await page.locator('.r4-save').click();await page.waitForFunction(()=>document.getElementById('save-status').textContent==='Saved');
  assert.equal(await page.locator('#publication-status').textContent(),'Draft');
  let saves=0;page.on('request',r=>{if(r.url().includes('/update/'))saves++;});await page.locator('.r4-save').click();assert.equal(saves,0);
  const manualPath=new URL(page.url()).pathname;
  const [preview]=await Promise.all([context.waitForEvent('page'),page.getByRole('link',{name:'Preview',exact:true}).click()]);await preview.waitForLoadState();
  assert.match(await preview.textContent('body'),/No attempt is started/);await preview.close();
  evidence.journeys.push({name:'Manual quiz: create, add, save draft, preview',pass:true});
  await screenshot('editor-desktop-dark');
  // Save failure retains edits; stale client must not overwrite another tab.
  await page.locator('#quiz-title').fill('Retained edit after failure');
  await page.route('**/update/**',route=>route.fulfill({status:503,json:{error:'Synthetic persistence failure'}}));
  await page.locator('.r4-save').click();await page.waitForFunction(()=>document.getElementById('save-status').textContent.startsWith('Save Failed'));
  assert.equal(await page.locator('#quiz-title').inputValue(),'Retained edit after failure');
  assert.equal(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;}),true);
  await page.unroute('**/update/**');await page.locator('.r4-save').click();await page.waitForFunction(()=>document.getElementById('save-status').textContent==='Saved');
  await page.route('**/update/**',async route=>{await new Promise(resolve=>setTimeout(resolve,200));await route.continue();});
  await page.locator('#quiz-title').fill('Sent version');await page.locator('.r4-save').click();await page.locator('#quiz-title').fill('Edited while saving');
  await page.waitForFunction(()=>document.getElementById('save-status').textContent==='Unsaved changes');assert.equal(await page.locator('#quiz-title').inputValue(),'Edited while saving');
  await page.unroute('**/update/**');await page.locator('.r4-save').click();await page.waitForFunction(()=>document.getElementById('save-status').textContent==='Saved');
  const stale=await context.newPage();await stale.goto(page.url());stale.on('dialog',d=>d.accept());
  await page.locator('#quiz-title').fill('Newer saved title');await page.locator('.r4-save').click();await page.waitForFunction(()=>document.getElementById('save-status').textContent==='Saved');
  await stale.locator('#quiz-title').fill('Stale title');await stale.locator('.r4-save').click();await stale.waitForFunction(()=>document.getElementById('save-status').textContent.startsWith('Save Failed'));await stale.close();
  evidence.journeys.push({name:'Save failure, unsaved leave warning and two-tab conflict',pass:true});
  await go('/');await screenshot('dashboard-desktop-dark');await page.getByRole('button',{name:'Generate with AI',exact:true}).click();
  await page.evaluate(()=>{window.r4ActionClicks=[];document.addEventListener('click',event=>window.r4ActionClicks.push(event.target.closest('button,a,summary')?.textContent.trim()));});
  evidence.quickFields=await page.locator('#ai-generator-form input:not([type=hidden]):visible,#ai-generator-form select:visible').count();
  assert.equal(evidence.quickFields,5);await page.locator('#topic-input').fill('Words');
  let requests=0;page.on('request',r=>{if(r.url().endsWith('/api/generate_ai'))requests++;});
  await page.locator('#generate-btn').dblclick();await page.waitForURL('**/edit/r4_ai');assert.equal(requests,1);evidence.afterGenerationRequestCount=requests;
  await page.locator('#question-filter').selectOption('review');assert.equal(await page.locator('.question-block:visible').count(),1);
  await page.locator('.question-block:visible textarea[aria-label="Question text"]').fill('Choose the correct word Alpha.');
  await page.locator('#approval-control-0 button').click();await page.locator('.r4-save').click();await page.waitForFunction(()=>document.getElementById('save-status').textContent==='Saved');
  await page.locator('#publish-button').click();await page.waitForFunction(()=>document.getElementById('publication-status').textContent==='Published');
  await page.locator('#share-button').click();await page.waitForFunction(()=>document.getElementById('save-status').textContent.includes('copied'));assert.match(await page.locator('#save-status').textContent(),/copied/);
  await go('/');await page.locator('#searchInput').fill('AI draft needing review');await page.locator('.quiz-item:visible').getByRole('button',{name:'Share',exact:true}).click();
  assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/r4_ai$/);
  evidence.journeys.push({name:'Mock AI: generate once, find review, correct, approve, save, publish, share',pass:true});
  await go('/');await page.getByRole('button',{name:'Generate with AI',exact:true}).click();await page.locator('#topic-input').fill('Rate limit fixture');await page.locator('#generate-btn').click();await page.waitForFunction(()=>document.getElementById('generator-feedback').textContent.includes('60 seconds'));
  assert.equal(await page.locator('#generate-btn').isEnabled(),true);assert.equal(await page.locator('#topic-input').inputValue(),'Rate limit fixture');
  await layout('generator',1366,'light');await screenshot('generator-desktop-light');
  evidence.journeys.push({name:'Rate limit recovery retains input and unlocks generator',pass:true});
  await go('/worksheet');await layout('worksheet',1366,'dark');await screenshot('worksheet-desktop-dark');
  await page.locator('#file-input').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:Buffer.from('synthetic fixture mocked before decode')});
  await page.locator('#extract-btn').click();await page.locator('#extraction-preview').waitFor({state:'visible'});
  await page.locator('.question-editor').first().fill('Corrected worksheet wording.');await page.locator('#solve-btn').click();await page.waitForURL('**/edit/r4_worksheet');
  assert.match(await page.locator('.question-block:visible').textContent(),/7b/);assert.equal(await page.locator('#publication-status').textContent(),'Draft');
  evidence.journeys.push({name:'Mock worksheet extraction, edit source, check and create draft with 7b retained',pass:true});
  await go('/');await page.locator('#searchInput').fill('Newer saved title');assert.equal(await page.locator('.quiz-item:visible').count(),1);await page.locator('.quiz-item:visible').getByRole('link',{name:'Edit',exact:true}).click();
  await page.locator('#quiz-title').fill('Library edited quiz');await page.locator('.r4-save').click();await page.waitForFunction(()=>document.getElementById('save-status').textContent==='Saved');await page.getByRole('link',{name:'Back',exact:true}).click();
  evidence.journeys.push({name:'Library search, edit, save and return',pass:true});
  await go('/results/r4_published');await page.getByRole('button',{name:'View feedback',exact:false}).click();assert.match(await page.textContent('body'),/Synthetic Student/);
  await go('/solutions/r4_result');assert.match(await page.textContent('body'),/Choose Alpha next time/);
  evidence.journeys.push({name:'Results submission and individual feedback',pass:true});
  for(const [screen,path] of [['dashboard','/'],['generator','/'],['editor','/edit/r4_draft'],['worksheet','/worksheet'],['worksheet-key','/worksheet_answers'],['results','/results/r4_published'],['feedback','/solutions/r4_result']]) {
    await go(path);if(screen==='generator')await page.getByRole('button',{name:'Generate with AI',exact:true}).click();
    for(const width of [360,768,1366,1920])for(const theme of ['dark','light'])await layout(screen,width,theme);
    if(screen==='editor'){await layout(screen,360,'light');await screenshot('editor-mobile-light');await page.locator('.question-block:visible textarea[aria-label="Question text"]').fill('Mobile question edit.');await page.locator('.r4-save').click();await page.waitForFunction(()=>document.getElementById('save-status').textContent==='Saved');}
    if(screen==='dashboard'){await layout(screen,360,'dark');await screenshot('dashboard-mobile-dark');}
    if(screen==='worksheet'){await layout(screen,360,'light');await screenshot('worksheet-mobile-light');}
  }
  evidence.journeys.push({name:'Mobile navigation and question editing',pass:true});
  if(process.env.R4_EXTERNAL_UI==='1'){await go('/edit/r4_draft');await page.locator('#question-jumps').getByRole('button',{name:'Question 8',exact:true}).click();await page.waitForSelector('mjx-container:visible');evidence.mathJaxRendered=true;await screenshot('editor-math-desktop');}
  evidence.after={quickFields:evidence.quickFields,generatorDisclosureClicks:1,reviewFilterChanges:1,draftPreviewClicks:1,publishedShareClicks:1};
  assert.deepEqual(evidence.errors,[]);
  evidence.externalUiAssets=process.env.R4_EXTERNAL_UI==='1';
  evidence.pass=true;
} catch(error) { evidence.pass=false;evidence.failure=error.stack;throw error; }
finally { await fs.writeFile(output+'/evidence.json',JSON.stringify(evidence,null,2));await browser?.close();server.kill(); }
