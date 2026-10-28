import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';

const captures=process.argv.includes('--capture');
const only=process.argv.find(arg=>arg.startsWith('--only='))?.slice(7).split(',');
const output=captures?'docs/ui-final/creation-refinement':'.local/create-workspace';
await fs.mkdir(output,{recursive:true});
const server=spawn(process.execPath,['--require','./test/tsx-bootstrap.cjs','--import','tsx','test/r4-browser-server.ts'],{
  env:{...process.env,UI_FINAL_CAPTURE:captures?'1':'0'},stdio:['ignore','pipe','pipe']
});
let logs='',browser;
for(const stream of [server.stdout,server.stderr])stream.on('data',c=>logs+=c);
const evidence={mode:'Isolated synthetic records, mocked generation/extraction; actual templates, scripts, save routes and RMX export. No production or live provider calls.',checks:[],screens:[],layouts:[],errors:[],assetFailures:[]};
try {
  for(let i=0;i<150&&!logs.includes('R4 synthetic server ready');i++){
    if(server.exitCode!==null)throw Error(logs);await new Promise(r=>setTimeout(r,200));
  }
  assert.match(logs,/R4 synthetic server ready/);
  browser=await chromium.launch();
  const context=await browser.newContext({viewport:{width:1440,height:1000},extraHTTPHeaders:{authorization:'Bearer user_teacher_test'}});
  await context.route(captures?'https://www.gstatic.com/firebasejs/**':'https://**/*',r=>r.fulfill({contentType:'application/javascript',body:r.request().url().includes('firebase-auth')?'export const getAuth=()=>({}),signOut=async()=>{};':r.request().url().includes('firebase-app')?'export const initializeApp=()=>({});':'/* offline optional asset */'}));
  await context.addInitScript(()=>{
    localStorage.setItem('tour_completed','true');localStorage.setItem('theme','light');
    localStorage.setItem('gemini_api_keys','["synthetic-unused"]');localStorage.setItem('gemini_api_key','synthetic-unused');
  });
  const page=await context.newPage();
  page.on('pageerror',e=>evidence.errors.push(e.message));
  page.on('requestfailed',r=>{if(!r.failure()?.errorText.includes('ABORTED'))evidence.assetFailures.push({url:r.url(),error:r.failure()?.errorText});});
  page.on('dialog',d=>d.type()==='beforeunload'?d.accept():d.dismiss());
  const go=async url=>{const response=await page.goto('http://127.0.0.1:3000'+url);assert.equal(response.status(),200,url);};
  const method=name=>page.getByRole('navigation',{name:'Create quiz method'}).getByRole('link',{name,exact:true});
  const worksheet=()=>page.frameLocator('#create-worksheet');
  const tab=name=>worksheet().getByRole('tab',{name,exact:true});
  const key=()=>worksheet().frameLocator('#studio-panel-1');
  const rmx=()=>worksheet().frameLocator('#studio-panel-2');
  const capture=async(name,{full=false}={})=>{
    if(only&&!only.includes(name))return;
    for(const width of captures?[1440,390]:[1440,768,390])for(const theme of ['light','dark']){
      await page.setViewportSize({width,height:1000});
      await page.evaluate(theme=>{if(document.documentElement.dataset.theme!==theme)toggleTheme();},theme);
      await page.evaluate(()=>document.fonts.ready);
      if(captures){
        for(const frame of page.frames())await frame.evaluate(()=>document.fonts.ready);
      }
      await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(captures?350:80);
      for(const frame of page.frames()){
        const layout=await frame.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
        // Hidden retained documents have a zero-width viewport and do not affect layout.
        if(layout.width){assert.ok(layout.scroll<=layout.width+1,JSON.stringify({name,theme,url:frame.url(),...layout}));evidence.layouts.push({screen:name,theme,url:frame.url().replace('http://127.0.0.1:3000',''),...layout});}
        assert.equal(await frame.locator('[role=tabpanel][hidden]:visible').count(),0,'Inactive worksheet panels must actually be hidden');
      }
      if(captures){
        const file=`after/${name}-${width}-${theme}.png`;
        await fs.mkdir(path.join(output,'after'),{recursive:true});
        await page.screenshot({path:path.join(output,file),fullPage:full});evidence.screens.push(file);
      }
    }
  };
  await go('/');await page.getByRole('button',{name:'Generate with AI',exact:true}).click();
  assert.equal(await page.locator('#saved-quizzes-card').isVisible(),false);
  assert.equal(await page.locator('#quiz-library-intro').isVisible(),false);
  assert.equal(await page.locator('#create').isVisible(),true);
  await page.waitForFunction(()=>document.activeElement.id==='topic-input');
  await page.locator('#topic-input').fill('Fractions and linear equations');
  await capture('ai');
  await page.locator('#generator-advanced summary').click();await capture('ai-options',{full:true});
  await page.locator('#generator-advanced summary').click();
  await method('Write manually').click();
  assert.equal(await page.locator('#createBlankModal').getAttribute('aria-modal'),null);
  await page.locator('#blank-quiz-title').fill('Fractions · Classroom practice');
  await capture('manual');
  await method('From a worksheet').click();await worksheet().locator('#file-input').waitFor({state:'attached'});
  assert.equal(await page.locator('.qm-app-header:visible').count(),1);
  assert.equal(await worksheet().locator('.qm-app-header').isVisible(),false);
  await capture('worksheet');
  await page.setViewportSize({width:1440,height:1000});
  const uploadBounds=await worksheet().locator('#upload-card').boundingBox();
  assert.ok(uploadBounds.width>1250,'Empty worksheet upload uses desktop width');
  const filesBounds=await worksheet().locator('.worksheet-source-files').boundingBox();
  const actionsBounds=await worksheet().locator('.worksheet-extract-actions').boundingBox();
  assert.ok(actionsBounds.x>filesBounds.x+filesBounds.width,'Desktop places existing options/action beside files');
  const source={name:'practice-questions.png',mimeType:'image/png',buffer:Buffer.from('Synthetic source; extraction intercepted before decoding')};
  await worksheet().locator('#file-input').setInputFiles(source);
  await worksheet().locator('.r4-details summary').first().click();await capture('worksheet-options',{full:true});
  await worksheet().locator('.r4-details summary').first().click();
  await tab('With answer key').click();await key().locator('#worksheet-input').waitFor({state:'attached'});
  await capture('answer-key');
  await key().locator('#worksheet-input').setInputFiles({...source,name:'key-mode-questions.png'});
  await key().locator('#answer-input').setInputFiles({...source,name:'reference-key.png'});
  await capture('answer-key-files',{full:true});
  await tab('RMX export').click();await rmx().locator('#ws-input').waitFor({state:'attached'});
  assert.match(await rmx().locator('.worksheet-next').innerText(),/does not create a quiz/);
  await capture('rmx');
  await rmx().locator('#ws-input').setInputFiles({...source,name:'contest-questions.png'});
  await rmx().locator('#ans-input').setInputFiles({...source,name:'contest-key.png'});
  await rmx().getByText('Export details',{exact:true}).click();
  await rmx().locator('#year').fill('2026');await rmx().locator('#test_name').fill('Classroom practice');await rmx().locator('#contest').fill('Synthetic contest');
  await capture('rmx-options',{full:true});
  const retained=await page.locator('#create-worksheet').evaluate(el=>{el.contentWindow.retainedCreationMarker='same-document';return true;});assert.ok(retained);
  await method('Generate with AI').click();assert.equal(await page.locator('#topic-input').inputValue(),'Fractions and linear equations');
  await method('Write manually').click();assert.equal(await page.locator('#blank-quiz-title').inputValue(),'Fractions · Classroom practice');
  await method('From a worksheet').click();
  assert.equal(await page.locator('#create-worksheet').evaluate(el=>el.contentWindow.retainedCreationMarker),'same-document');
  assert.equal(await rmx().locator('#year').inputValue(),'2026');
  assert.equal(await rmx().locator('#ws-input').evaluate(el=>el.files[0].name),'contest-questions.png');
  await tab('With answer key').click();assert.equal(await key().locator('#worksheet-input').evaluate(el=>el.files[0].name),'key-mode-questions.png');
  assert.equal(await key().locator('#answer-input').evaluate(el=>el.files[0].name),'reference-key.png');
  await tab('Questions').click();assert.equal(await worksheet().locator('#file-input').evaluate(el=>el.files[0].name),'practice-questions.png');
  await method('Write manually').click();await page.goBack();await worksheet().locator('#file-input').waitFor({state:'attached'});
  assert.equal(await page.locator('#create-worksheet').isVisible(),true);
  await page.getByRole('navigation',{name:'Workspace',exact:true}).getByRole('link',{name:'Quizzes',exact:true}).click();assert.ok(await page.locator('#saved-quizzes-card').isVisible());
  await page.getByRole('link',{name:'Worksheet to Quiz',exact:true}).click();
  assert.equal(await worksheet().locator('#file-input').evaluate(el=>el.files[0].name),'practice-questions.png');
  evidence.checks.push('AI/manual/worksheet share a dedicated Create Quiz surface; library is hidden; returning to library/Back and switching all methods preserves form values and the same worksheet documents with separate files');
  let keyCalls=0;
  await page.route('**/api/extract_worksheet_with_answers',async route=>{
    keyCalls++;await route.fulfill({json:{success:true,questions:[{id:'7b',original_index:'7b',raw_text:'Choose Alpha.',question:'Choose Alpha.',type:'multiple_choice',options:['Alpha','Beta','Gamma','Delta'],answer:'A',points:1,page_number:1}],missing_indices:[],golden_reference:{}}});
  });
  await tab('With answer key').click();await key().locator('#extract-btn').click();await key().locator('#extraction-preview').waitFor({state:'visible'});assert.equal(keyCalls,1);
  await capture('answer-key-review',{full:true});
  await page.setViewportSize({width:1440,height:1000});
  await key().locator('body').evaluate(el=>el.style.minHeight='3000px');
  await page.waitForFunction(()=>document.getElementById('create-worksheet').getBoundingClientRect().height>=3000);
  await page.locator('#create-worksheet').evaluate(el=>scrollTo(0,el.offsetTop+600));
  await key().locator('#cropper-modal').evaluate(el=>el.style.display='flex');await page.waitForTimeout(100);
  const crop=await key().locator('#cropper-modal').boundingBox();
  assert.ok(crop.y>=-1&&crop.y+crop.height<=1001,JSON.stringify(crop));
  await key().locator('#cropper-modal').getByRole('button',{name:'Cancel',exact:true}).click();
  await key().locator('body').evaluate(el=>el.style.minHeight='');
  await tab('RMX export').click();
  await page.route('**/api/extract_rmxflash',route=>route.fulfill({json:{success:true,questions:[{identifier:'practice-7b',original_index:'7b',statement:'Choose Alpha.',answer:'A',choices:['Alpha','Beta','Gamma','Delta']}]}}));
  await rmx().locator('#extract-btn').click();await rmx().locator('#results-card').waitFor({state:'visible'});
  assert.equal(await worksheet().locator('.studio-steps li:visible').count(),4);
  assert.match(await worksheet().locator('#studio-status').innerText(),/export your RMX spreadsheet/);
  const [download]=await Promise.all([page.waitForEvent('download'),rmx().getByRole('button',{name:/Export to Excel/}).click()]);
  const zip=await fs.readFile(await download.path());assert.equal(zip.subarray(0,2).toString(),'PK');assert.ok(zip.includes(Buffer.from('.xlsx')));
  await tab('Questions').click();await worksheet().locator('#extract-btn').click();await worksheet().locator('.question-editor').first().waitFor();
  await page.waitForFunction(()=>!document.getElementById('create-worksheet').contentDocument.getElementById('extract-btn').disabled);
  await worksheet().locator('.question-editor').first().fill('Retained worksheet question 7b.');await capture('worksheet-review',{full:true});
  await method('Generate with AI').click();await method('From a worksheet').click();
  assert.equal(await worksheet().locator('.question-editor').first().innerText(),'Retained worksheet question 7b.');
  await worksheet().locator('#solve-btn').click();await page.waitForURL('**/edit/r4_worksheet');
  assert.match(await page.locator('.question-block').first().textContent(),/7b/);
  evidence.checks.push('All extraction controllers still work, source wording/7b survives method switches and quiz creation reaches the top-level editor; answer-key review and actual RMX XLSX ZIP export work');
  evidence.checks.push('Nested retained crop modal stays within the visible top-level viewport after scrolling; RMX has Upload/Extract/Review/Export steps');
  await go('/#create/manual');assert.ok(await page.locator('#blank-quiz-title').isVisible());
  await page.locator('#blank-quiz-title').fill('Manual Create workspace check');
  await page.locator('#createBlankModal').getByRole('button',{name:'Create Quiz',exact:true}).click();await page.waitForURL('**/edit/**');
  await go('/#ai-generator-card');await page.waitForFunction(()=>document.activeElement.id==='topic-input');
  await page.locator('#topic-input').fill('Rate limit fixture');await page.locator('#generate-btn').click();
  await page.waitForFunction(()=>document.getElementById('generator-feedback').textContent.includes('60 seconds'));
  assert.equal(await page.locator('#topic-input').inputValue(),'Rate limit fixture');assert.equal(await page.locator('#generate-btn').isEnabled(),true);
  await capture('ai-error');
  await page.locator('#topic-input').fill('Synthetic generation success');await page.locator('#generate-btn').click();await page.waitForURL('**/edit/r4_ai');
  for(const route of ['/worksheet','/worksheet_upload','/worksheet_answers','/rmxflash']){
    await go(route);assert.equal(await page.getByRole('navigation',{name:'Create quiz method'}).count(),1);
    assert.ok(await page.getByRole('heading',{name:'Create Quiz',exact:true}).isVisible());
    await capture('direct-'+route.slice(1));
  }
  evidence.checks.push('Direct legacy worksheet URLs retain the shared Create header and active method; manual draft and AI success reach existing editor; retry deep links focus topic; rate limits retain input and unlock submission');
  assert.deepEqual(evidence.errors,[]);assert.deepEqual(evidence.assetFailures,[]);evidence.pass=true;
} catch(error) {evidence.failure=error.stack;throw error;}
finally {
  if(captures&&only){
    const previous=JSON.parse(await fs.readFile(path.join(output,'evidence.json'),'utf8'));
    const replaced=new Set(evidence.layouts.map(x=>x.screen));
    evidence.screens=[...new Set([...previous.screens,...evidence.screens])];
    evidence.layouts=[...previous.layouts.filter(x=>!replaced.has(x.screen)),...evidence.layouts];
  }
  await fs.writeFile(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2));await browser?.close();server.kill();
}
console.log(JSON.stringify({pass:evidence.pass,checks:evidence.checks,screens:evidence.screens.length,errors:evidence.errors,assetFailures:evidence.assetFailures},null,2));
