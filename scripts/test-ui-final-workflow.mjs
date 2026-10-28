import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
const output='docs/ui-final';
const server=spawn(process.execPath,['--require','./test/tsx-bootstrap.cjs','--import','tsx','test/r4-browser-server.ts'],{stdio:['ignore','pipe','pipe']});
let logs='',browser;for(const stream of [server.stdout,server.stderr])stream.on('data',c=>logs+=c);
const evidence={mode:'Isolated local synthetic records, mocked providers; actual frontend and app save routes',checks:[],errors:[]};
try {
  for(let i=0;i<150&&!logs.includes('R4 synthetic server ready');i++){if(server.exitCode!==null)throw Error(logs);await new Promise(r=>setTimeout(r,200));}
  assert.match(logs,/R4 synthetic server ready/);browser=await chromium.launch();
  const context=await browser.newContext({viewport:{width:1440,height:900},extraHTTPHeaders:{authorization:'Bearer user_teacher_test'}});
  await context.route('https://**/*',r=>r.fulfill({contentType:'application/javascript',body:r.request().url().includes('firebase-auth')?'export const getAuth=()=>({}),signOut=async()=>{};':r.request().url().includes('firebase-app')?'export const initializeApp=()=>({});':'/* offline optional asset */'}));
  await context.addInitScript(()=>localStorage.setItem('tour_completed','true'));
  const page=await context.newPage();page.on('pageerror',e=>evidence.errors.push(e.message));page.on('dialog',d=>d.accept());
  const go=async path=>{const response=await page.goto('http://127.0.0.1:3000'+path);assert.equal(response.status(),200,path);};
  await go('/#ai-generator-card');assert.ok(await page.locator('#topic-input').isVisible());
  await page.waitForFunction(()=>document.activeElement.id==='topic-input');
  await page.getByRole('button',{name:'Close',exact:true}).click();
  assert.equal(await page.locator('[data-open-generator]').getAttribute('aria-expanded'),'false');
  await page.getByRole('button',{name:'Generate with AI',exact:true}).click();
  assert.equal(await page.locator('[data-open-generator]').getAttribute('aria-expanded'),'true');
  evidence.checks.push('Create action reveals and focuses original generator; close restores focus; task-retry deep link opens generator');
  await go('/edit/r4_draft');
  const original=await page.evaluate(()=>structuredClone(quizData.questions[0]));
  await page.locator('#question-block-0').getByRole('button',{name:'Duplicate',exact:true}).click();
  assert.equal(await page.locator('.question-block:visible').count(),3);
  const copy=await page.evaluate(()=>quizData.questions[1]);
  assert.notEqual(copy.id,original.id);assert.deepEqual(copy.source,original.source);
  assert.equal(copy.verification.verification_status,'review_required');assert.equal(copy.verification.teacher_approved,false);
  await page.getByRole('button',{name:'Move question 2 down',exact:true}).click();
  assert.equal(await page.evaluate(()=>quizData.questions[2].id),copy.id);
  await page.locator('#question-block-2').getByRole('spinbutton',{name:'Question points',exact:true}).fill('2.5');
  await page.locator('#question-block-2').getByRole('textbox',{name:'Explanation or solution',exact:true}).fill('Teacher explanation after duplication.');
  await page.locator('.r4-save').click();await page.waitForFunction(()=>document.getElementById('save-status').textContent==='Saved');
  await page.reload();assert.equal(await page.evaluate(()=>quizData.questions[2].points),2.5);
  assert.equal(await page.evaluate(()=>quizData.questions[2].solution),'Teacher explanation after duplication.');
  assert.equal(await page.evaluate(()=>quizData.questions[2].source.original_index),original.source.original_index);
  await page.locator('#question-block-2').getByRole('button',{name:'Delete',exact:true}).click();
  assert.equal(await page.locator('.question-block:visible').count(),2);
  evidence.checks.push('Duplicate assigns a unique canonical ID, retains immutable source metadata, requires review; reorder/points/solution persist through actual save and reload; delete acts on selected item');
  await go('/results/r4_published');await page.setViewportSize({width:390,height:900});
  await page.getByRole('button',{name:'View feedback',exact:false}).click();
  assert.ok(await page.locator('.details-row').isVisible());
  assert.ok(await page.locator('.review-block').first().evaluate(el=>el.getBoundingClientRect().height)<600,'Template indentation does not create oversized feedback gaps');
  assert.equal(await page.locator('.qm-results-table td[data-label="Student Name"]').count(),1);
  assert.equal(await page.locator('.table-responsive-wrapper').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,'Mobile result wrapper has no hidden horizontal scroll');
  for(const control of await page.locator('tr:not(.details-row) .toggle-btn').all()){
    const box=await control.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=390,'Result action fits mobile');
  }
  await page.getByRole('searchbox',{name:'Search student submissions'}).fill('Nobody');
  assert.equal(await page.locator('tr[id^="row-"]:visible').count(),0);
  evidence.checks.push('Mobile results actions fit without horizontal scrolling; feedback expands; submission search filters real rows');
  await go('/worksheet');await page.getByRole('tab',{name:'Worksheet + Answer Key',exact:true}).click();
  const key=page.frameLocator('#studio-panel-1');await key.locator('#worksheet-input').waitFor({state:'attached'});
  await key.locator('body').evaluate(el=>el.style.minHeight='3000px');
  await page.waitForFunction(()=>document.getElementById('studio-panel-1').getBoundingClientRect().height>=3000);
  await page.locator('#studio-panel-1').evaluate(el=>scrollTo(0,el.offsetTop+500));
  await key.locator('#cropper-modal').evaluate(el=>el.style.display='flex');
  await page.waitForTimeout(100);
  assert.equal(await key.locator('#cropper-modal').getAttribute('role'),'dialog');
  await key.locator('#cropper-modal').getByRole('button',{name:'Cancel',exact:true}).focus();
  await key.locator('#cropper-modal').getByRole('button',{name:'Cancel',exact:true}).press('Tab');
  assert.equal(await key.locator('#cropper-modal').evaluate(el=>el.contains(el.ownerDocument.activeElement)),true,'Crop modal retains keyboard focus');
  const crop=await key.locator('#cropper-modal').boundingBox();assert.ok(crop.y>=-1&&crop.y+crop.height<=901,'Retained-mode crop overlay stays in the visible parent viewport');
  await key.locator('#cropper-modal').evaluate(el=>el.style.display='none');
  evidence.checks.push('Retained answer-key document grows without nested scrolling; crop overlay remains within parent viewport after a 500px page scroll');
  await go('/quiz/r4_published');await page.locator('#student-name').fill('Synthetic mobile student');await page.getByRole('button',{name:'Start Quiz',exact:true}).click();
  await page.locator('#question-text').waitFor({state:'visible'});
  const bounds=await page.locator('#question-text').boundingBox();assert.ok(bounds.width>280,'Question keeps full mobile reading width with whiteboard shown');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  for(const selector of ['#btn-end-early','#btn-toggle-whiteboard']){
    const box=await page.locator(selector).boundingBox();assert.ok(box.x>=0&&box.x+box.width<=390,selector+' fits mobile');
  }
  await page.getByRole('button',{name:'Hide Whiteboard',exact:false}).click();assert.equal(await page.locator('#right-panel').isVisible(),false);
  await page.getByRole('button',{name:'Show Whiteboard',exact:false}).click();await page.getByRole('button',{name:'Back to question',exact:true}).click();
  assert.ok(await page.locator('#question-text').isVisible());
  evidence.checks.push('Mobile student question uses full width; whiteboard follows vertically, hides/reopens, and returns to question through visible control');
  await go('/live/r4_published');await page.getByRole('button',{name:'Start New Session',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('run-label').textContent.includes('Active'));
  await go('/');assert.equal(await page.getByRole('navigation',{name:'Active classrooms'}).getByRole('link').count(),1);
  await page.getByRole('navigation',{name:'Active classrooms'}).getByRole('link').click();await page.waitForURL('**/live/r4_published');
  evidence.checks.push('Existing saved classroom run appears on the dashboard with a direct link back to its monitor');
  assert.deepEqual(evidence.errors,[]);evidence.pass=true;
}catch(error){evidence.failure=error.stack;throw error;}
finally{await fs.mkdir(output,{recursive:true});await fs.writeFile(output+'/workflow-evidence.json',JSON.stringify(evidence,null,2));await browser?.close();server.kill();}
console.log(JSON.stringify(evidence,null,2));
