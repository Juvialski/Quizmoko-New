import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { registerRoutes } from '../src/routes/index.ts';
import { quizzes,results,users,liveSessions,classroomRuns } from '../src/store/db.ts';
import { createSessionToken } from '../src/middleware/auth.ts';
import { initSocketServer,monitoringRoom,reconcileLiveResults } from '../src/services/socket.ts';
import { configureGeminiClientForTests } from '../src/services/gemini.ts';
import { tutorialProvider } from './r4-1-fixtures.ts';
import { clearAttemptRevisionState } from '../src/services/resultSession.ts';
import { changeClassroomRun } from '../src/services/classroomRuns.ts';
const question=(id:string)=>({id,question:'Choose Alpha.',type:'multiple_choice',options:['Alpha','Beta','Gamma','Delta'],answer:'A',points:2});
async function fixture() {
  const app=express(); app.set('view engine','ejs'); app.use(express.json({limit:'30mb'}));
  registerRoutes(app);
  app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status || 500).json({success:false,error:'Request failed'}));
  const server=createServer(app); const io=initSocketServer(server); app.set('io',io);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const owner={uid:'r41_owner',role:'teacher',name:'Teacher',email:'teacher@example.invalid',stored_custom_key:'synthetic-only'} as any;
  users.set(owner.uid,owner);
  const token=createSessionToken(owner,600_000);
  const post=async (path:string,body:any,auth?:string)=>{
    const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{authorization:'Bearer '+auth}:{})},body:JSON.stringify(body)});
    return {response,data:await response.json()};
  };
  return {app,io,base,token,post,async close(){configureGeminiClientForTests();io.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
// Exercise actual Engine.IO/Socket.IO over HTTP polling without another client dependency.
async function socketClient(base:string,token?:string) {
  const headers=token?{authorization:'Bearer '+token}:{};
  const root=base+'/socket.io/?EIO=4&transport=polling';
  const initial=await (await fetch(root,{headers})).text(); const sid=JSON.parse(initial.slice(1)).sid;
  const url=root+'&sid='+encodeURIComponent(sid);
  const send=async (packet:string)=>{assert.equal((await fetch(url,{method:'POST',headers,body:packet})).status,200);};
  const read=async ()=> (await fetch(url,{headers,signal:AbortSignal.timeout(2500)})).text();
  await send('40');await read();
  return {send:(event:string,data:any)=>send('42'+JSON.stringify([event,data])),read,close:()=>send('1')};
}


test('R4.2 reuse, same-day runs, durable recovery and stale pings preserve historical results',async()=>{
  const f=await fixture();const id='r42_class';quizzes.set(id,{id,user_id:'r41_owner',title:'Class',questions:[question('1')]});
  const start=async(expected?:string,confirm_replace=false)=>f.post(`/api/live/${id}/start`,{expected_run_id:expected,confirm_replace},f.token);
  const snapshot=async()=> (await fetch(f.base+'/api/live/'+id,{headers:{authorization:'Bearer '+f.token}})).json();
  const ids=Array.from({length:6},()=>`sess_${randomUUID()}`);
  try {
    const a=(await start()).data.run;assert.ok(a.id);
    for(const sid of ids.slice(0,3)) {
      assert.equal((await f.post('/ping',{quiz_id:id,session_id:sid,student_name:sid})).response.status,200);
      assert.equal((await f.post('/api/grade_individual',{quiz_id:id,session_id:sid,question_index:0,student_answer:'Alpha',answer_revision:1})).data.earned_points,2);
    }
    assert.equal((await start(a.id)).response.status,409);
    assert.equal((await f.post(`/api/live/${id}/terminate`,{expected_run_id:a.id},f.token)).response.status,200);
    assert.equal((await f.post('/ping',{quiz_id:id,session_id:ids[3]})).response.status,409);
    const b=(await start(a.id)).data.run;assert.notEqual(a.id,b.id);
    assert.equal(Object.keys((await snapshot()).sessions).length,0);
    for(const sid of ids.slice(3,5)) assert.equal((await f.post('/ping',{quiz_id:id,session_id:sid})).data.terminated,false);
    const old=await f.post('/ping',{quiz_id:id,session_id:ids[0],live_run_id:b.id});assert.equal(old.data.terminated,true);
    assert.deepEqual(Object.keys((await snapshot()).sessions).sort(),ids.slice(3,5).sort());
    assert.equal((await f.post(`/api/live/${id}/toggle_pause`,{expected_run_id:a.id},f.token)).response.status,409);
    await f.post(`/api/live/${id}/toggle_pause`,{expected_run_id:b.id},f.token);
    const stored=structuredClone(classroomRuns.get(id));liveSessions.delete(id);classroomRuns.delete(id);classroomRuns.set(id,stored!);
    const recovered=await snapshot();assert.equal(recovered.paused,true);assert.equal(recovered.sessions[ids[3]].last_active,0);
    await f.post('/ping',{quiz_id:id,session_id:ids[3],current_q:1});assert.equal(Object.keys((await snapshot()).sessions).length,2);
    const c=(await start(b.id,true)).data.run;assert.notEqual(c.id,b.id);
    await f.post('/ping',{quiz_id:id,session_id:ids[5]});assert.deepEqual(Object.keys((await snapshot()).sessions),[ids[5]]);
    for(const sid of ids.slice(0,3)) assert.equal(results.get('res_'+sid)?.total_score,2);
    const body={quiz_id:id,session_id:ids[0],answers:{0:'Alpha'},answer_revisions:{0:1},session_revision:1};
    const final=await f.post('/submit',body);assert.equal(final.response.status,200);assert.equal(results.get('res_'+ids[0])?.live_run_id,a.id);
    assert.equal((await f.post('/submit',body)).data.result_id,final.data.result_id);
    assert.deepEqual(Object.keys((await snapshot()).sessions),[ids[5]]);
  }finally {ids.forEach(sid=>results.delete('res_'+sid));classroomRuns.delete(id);liveSessions.delete(id);quizzes.delete(id);await f.close();}
});

test('R4.2 run management authorization and real socket routing isolate old participants',async()=>{
  const f=await fixture();const id='r42_security';quizzes.set(id,{id,user_id:'r41_owner',title:'Class',questions:[question('1')]});
  const sid=`sess_${randomUUID()}`;const sid2=`sess_${randomUUID()}`;
  const student={uid:'r42_student',role:'student',name:'Student',email:'s@example.invalid'} as any;users.set(student.uid,student);
  const token=createSessionToken(student,600_000);
  const old=await socketClient(f.base),current=await socketClient(f.base),teacher=await socketClient(f.base,f.token);
  try {
    for(const auth of [token,createSessionToken({...student,uid:'other_teacher',role:'teacher'},600_000)]) {
      assert.ok([401,403].includes((await f.post(`/api/live/${id}/start`,{},auth)).response.status));
      assert.ok([401,403].includes((await f.post(`/api/live/${id}/terminate`,{},auth)).response.status));
    }
    const oldEnv=process.env.NODE_ENV;process.env.NODE_ENV='development';
    try {assert.equal((await f.post(`/api/live/${id}/start`,{})).response.status,401);} finally {process.env.NODE_ENV=oldEnv;}
    const a=(await f.post(`/api/live/${id}/start`,{},f.token)).data.run;
    await old.send('join_quiz',{quiz_id:id,monitor:true,run_id:a.id});assert.match(await old.read(),/FORBIDDEN/);
    await teacher.send('join_quiz',{quiz_id:id,monitor:true});await teacher.read();
    await old.send('ping',{quiz_id:id,session_id:sid});await old.read();await teacher.read();
    const b=(await f.post(`/api/live/${id}/start`,{expected_run_id:a.id,confirm_replace:true},f.token)).data.run;
    assert.match(await old.read(),/terminate/);await teacher.read();
    await current.send('ping',{quiz_id:id,session_id:sid2});assert.match(await current.read(),/"terminated":false/);await teacher.read();
    await old.send('ping',{quiz_id:id,session_id:sid,live_run_id:b.id});assert.match(await old.read(),/"terminated":true/);
    assert.deepEqual(Object.keys(reconcileLiveResults(id).sessions),[sid2]);
    await f.post(`/api/live/${id}/toggle_pause`,{expected_run_id:b.id},f.token);assert.match(await current.read(),/pause_state/);
    assert.equal(f.io.sockets.adapter.rooms.get(monitoringRoom(id))?.size,1);
    // Every member receiving the current-run control belongs to the authorized attempt room.
    assert.equal(f.io.sockets.adapter.rooms.get(`classroom_${id}_${b.id}`)?.size,1);
  }finally {await Promise.all([old.close(),current.close(),teacher.close()]);results.delete('res_'+sid);results.delete('res_'+sid2);classroomRuns.delete(id);liveSessions.delete(id);quizzes.delete(id);await f.close();}
});

test('R4.2 delayed semantic grades stay in original run and pending never becomes an outage zero',async()=>{
  const f=await fixture();const id='r42_delayed',sid=`sess_${randomUUID()}`;
  quizzes.set(id,{id,user_id:'r41_owner',title:'Explain',questions:[{id:'1',question:'Explain your claim.',type:'open_ended',answer:'A justified claim.',points:2}]});
  const provider=tutorialProvider(180);configureGeminiClientForTests(()=>provider.client);
  try {
    const a=(await f.post(`/api/live/${id}/start`,{},f.token)).data.run;
    const grade=f.post('/api/grade_individual',{quiz_id:id,session_id:sid,question_index:0,student_answer:'My claim and reason.',answer_revision:1});
    for(let i=0;i<100&&!results.get('res_'+sid)?.graded_details?.[0];i++) await new Promise(r=>setTimeout(r,5));
    assert.equal(results.get('res_'+sid)?.graded_details?.[0].grade_status,'pending');
    const b=(await f.post(`/api/live/${id}/start`,{expected_run_id:a.id,confirm_replace:true},f.token)).data.run;
    assert.notEqual(a.id,b.id);assert.equal((await grade).data.grade_status,'graded');
    assert.equal(results.get('res_'+sid)?.live_run_id,a.id);assert.equal(results.get('res_'+sid)?.total_score,1);
    assert.equal(Object.keys(reconcileLiveResults(id).sessions).length,0);
  }finally {results.delete('res_'+sid);classroomRuns.delete(id);liveSessions.delete(id);quizzes.delete(id);await f.close();}
});

test('R4.2 standalone attempts and historical records never acquire a later run',async()=>{
  const f=await fixture(),id='r42_legacy',sid=`sess_${randomUUID()}`;
  quizzes.set(id,{id,user_id:'r41_owner',title:'Published legacy quiz',questions:[question('1')]});
  const historical={id:'res_r42_history',quiz_id:id,session_id:'r42_history',total_score:2,is_in_progress:false};results.set(historical.id,historical);
  try {
    assert.equal((await f.post('/ping',{quiz_id:id,session_id:sid,student_name:'Standalone'})).response.status,200);
    assert.equal(classroomRuns.has(id),false);assert.equal(results.get('res_'+sid)?.live_run_id,undefined);
    const started=await f.post(`/api/live/${id}/start`,{},f.token);assert.equal(started.response.status,200);
    assert.equal((await f.post('/ping',{quiz_id:id,session_id:sid})).data.terminated,false);
    assert.equal(results.get('res_'+sid)?.live_run_id,undefined);
    assert.equal(Object.keys(reconcileLiveResults(id).sessions).length,0);assert.deepEqual(results.get(historical.id),historical);
    const readId=`sess_${randomUUID()}`;await f.post('/api/load_progressive_result',{quiz_id:id,session_id:readId});assert.equal(results.has('res_'+readId),false);
  }finally {results.delete(historical.id);results.delete('res_'+sid);classroomRuns.delete(id);liveSessions.delete(id);quizzes.delete(id);await f.close();}
});

test('R4.2 ended/replaced HTTP attempts reject every new answer path and reuse accepted grades',async()=>{
  const f=await fixture(),id='r42_closed';
  quizzes.set(id,{id,user_id:'r41_owner',title:'Explain',questions:[{id:'1',question:'Explain your claim.',type:'open_ended',answer:'A justified claim.',points:2}]});
  const provider=tutorialProvider(1);configureGeminiClientForTests(()=>provider.client);
  const sessions:string[]=[];
  try {
    let expected:string|undefined;
    for(const replacement of [false,true]) {
      const a=(await f.post(`/api/live/${id}/start`,{expected_run_id:expected,confirm_replace:true},f.token)).data.run;
      const sid=`sess_${randomUUID()}`;sessions.push(sid);
      const grade={quiz_id:id,session_id:sid,question_index:0,student_answer:'My claim and reason.',answer_revision:1};
      assert.equal((await f.post('/api/grade_individual',grade)).data.grade_status,'graded');
      const empty=`sess_${randomUUID()}`;sessions.push(empty);
      assert.equal((await f.post('/ping',{quiz_id:id,session_id:empty})).response.status,200);
      const saved=structuredClone(results.get('res_'+sid));const calls=provider.calls;
      if(replacement) {
        expected=(await f.post(`/api/live/${id}/start`,{expected_run_id:a.id,confirm_replace:true},f.token)).data.run.id;
      }else {
        assert.equal((await f.post(`/api/live/${id}/terminate`,{expected_run_id:a.id},f.token)).response.status,200);expected=a.id;
      }
      clearAttemptRevisionState(id,sid); // Retry must use saved identity, including after process guard loss.
      assert.equal((await f.post('/ping',{quiz_id:id,session_id:sid,live_run_id:expected})).data.terminated,true);
      const changed={quiz_id:id,session_id:sid,answers:{0:'New claim.'},answer_revisions:{0:2},session_revision:2};
      for(const path of ['/api/save_progressive_result','/submit','/api/submit_quiz']) {
        const rejected=await f.post(path,changed);assert.equal(rejected.response.status,409,path);assert.equal(rejected.data.code,'CLASSROOM_SESSION_CLOSED');
      }
      for(const edit of [{student_answer:'New claim.',answer_revision:2},{student_answer:grade.student_answer,answer_revision:2}]) {
        const rejected=await f.post('/api/grade_individual',{...grade,...edit});assert.equal(rejected.response.status,409);assert.equal(rejected.data.code,'CLASSROOM_SESSION_CLOSED');
      }
      assert.equal((await f.post('/api/grade_individual',{...grade,session_id:empty})).response.status,409);
      assert.deepEqual(results.get('res_'+empty)?.answers,{});
      assert.deepEqual(results.get('res_'+sid),saved);assert.equal(provider.calls,calls);
      const retry=await f.post('/api/grade_individual',grade);assert.equal(retry.data.grade_status,'graded');assert.equal(retry.data.earned_points,1);assert.equal(provider.calls,calls);
      const finalBody={quiz_id:id,session_id:sid,answers:{0:grade.student_answer},answer_revisions:{0:1},session_revision:3};
      assert.equal((await f.post('/api/save_progressive_result',finalBody)).response.status,200);
      const finalized=await f.post('/api/submit_quiz',finalBody);assert.equal(finalized.response.status,200);assert.equal(finalized.data.total_score,1);
      const immutable=structuredClone(results.get('res_'+sid));
      assert.equal((await f.post('/submit',finalBody)).data.result_id,finalized.data.result_id);assert.deepEqual(results.get('res_'+sid),immutable);assert.equal(provider.calls,calls);
      const restored=await f.post('/api/load_progressive_result',{quiz_id:id,session_id:sid});assert.equal(restored.response.status,200);
      assert.equal(results.get('res_'+sid)?.live_run_id,a.id);
      if(replacement) {
        assert.deepEqual(Object.keys(reconcileLiveResults(id).sessions),[]);
        const fresh=`sess_${randomUUID()}`;sessions.push(fresh);
        assert.equal((await f.post('/api/grade_individual',{...grade,session_id:fresh})).data.grade_status,'graded');
        assert.equal(results.get('res_'+fresh)?.live_run_id,expected);assert.deepEqual(Object.keys(reconcileLiveResults(id).sessions),[fresh]);
      }
    }
  } finally {sessions.forEach(sid=>results.delete('res_'+sid));quizzes.delete(id);classroomRuns.delete(id);liveSessions.delete(id);await f.close();}
});

test('R4.2 accepted pending Gemini survives end; closed retries/finalization do not start new Gemini',{timeout:10000},async()=>{
  const f=await fixture(),id='r42_pending_end',sid=`sess_${randomUUID()}`;
  quizzes.set(id,{id,user_id:'r41_owner',title:'Explain',questions:[{id:'1',question:'Explain your claim.',type:'open_ended',answer:'A justified claim.',points:2}]});
  let release!:()=>void,entered!:()=>void,calls=0;
  const barrier=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
  configureGeminiClientForTests(()=>({models:{generateContent:async()=>{calls++;entered();await barrier;return {text:JSON.stringify({score_fraction:0.5,feedback:'Your explanation partly addresses the question.'})};}}}) as any);
  try {
    const a=(await f.post(`/api/live/${id}/start`,{},f.token)).data.run;
    const grade={quiz_id:id,session_id:sid,question_index:0,student_answer:'My claim and reason.',answer_revision:1};
    const pending=f.post('/api/grade_individual',grade);await started;
    assert.equal(results.get('res_'+sid)?.graded_details?.[0].grade_status,'pending');
    assert.equal((await f.post(`/api/live/${id}/terminate`,{expected_run_id:a.id},f.token)).response.status,200);
    const retry=await f.post('/api/grade_individual',grade);assert.equal(retry.data.grade_status,'pending');assert.equal(calls,1);
    const finalBody={quiz_id:id,session_id:sid,answers:{0:grade.student_answer},answer_revisions:{0:1},session_revision:1};
    assert.equal((await f.post('/submit',finalBody)).response.status,409);assert.equal(calls,1);
    const rejected=await f.post('/api/grade_individual',{...grade,answer_revision:2});assert.equal(rejected.response.status,409);assert.equal(calls,1);
    const b=(await f.post(`/api/live/${id}/start`,{expected_run_id:a.id},f.token)).data.run;
    release();assert.equal((await pending).data.grade_status,'graded');assert.equal(calls,1);
    assert.equal(results.get('res_'+sid)?.live_run_id,a.id);assert.equal(results.get('res_'+sid)?.total_score,1);assert.deepEqual(Object.keys(reconcileLiveResults(id).sessions),[]);
    assert.equal((await f.post('/submit',finalBody)).response.status,200);assert.equal((await f.post('/api/submit_quiz',finalBody)).data.result_id,'res_'+sid);assert.equal(calls,1);assert.equal(classroomRuns.get(id)?.id,b.id);
  } finally {release();results.delete('res_'+sid);quizzes.delete(id);classroomRuns.delete(id);liveSessions.delete(id);await f.close();}
});

test('R4.2 concurrent HTTP answer, End Session and retry respect a single admission boundary',async()=>{
  const f=await fixture(),id='r42_race';quizzes.set(id,{id,user_id:'r41_owner',title:'Race',questions:[question('1')]});
  const sessions:string[]=[];let expected:string|undefined;
  try {
    for(let round=0;round<8;round++) {
      const a=(await f.post(`/api/live/${id}/start`,{expected_run_id:expected},f.token)).data.run;expected=a.id;
      const sid=`sess_${randomUUID()}`;sessions.push(sid);await f.post('/ping',{quiz_id:id,session_id:sid});
      const body={quiz_id:id,session_id:sid,question_index:0,student_answer:'Alpha',answer_revision:1};
      const requests=[()=>f.post('/api/grade_individual',body),()=>f.post(`/api/live/${id}/terminate`,{expected_run_id:a.id},f.token),()=>f.post('/api/grade_individual',body)];
      const order=round%2?[1,0,2]:[0,1,2];
      const outcomes=await Promise.all(order.map(i=>requests[i]()));
      assert.equal(outcomes[order.indexOf(1)].response.status,200);
      const accepted=outcomes.some((r,i)=>order[i]!==1 && r.response.status===200);
      const record=results.get('res_'+sid)!;assert.equal(record.answers?.['0'],accepted?'Alpha':undefined);assert.equal(record.total_score,accepted?2:0);
      const retry=await f.post('/api/grade_individual',body);assert.equal(retry.response.status,accepted?200:409);
      assert.equal((await f.post('/api/grade_individual',{...body,answer_revision:2,student_answer:'Beta'})).response.status,409);
      assert.equal(results.get('res_'+sid)?.total_score,accepted?2:0);
    }
  } finally {sessions.forEach(sid=>results.delete('res_'+sid));quizzes.delete(id);classroomRuns.delete(id);liveSessions.delete(id);await f.close();}
});

test('R4.2 final-submit admission releases lifecycle lock before delayed Gemini completion',{timeout:10000},async()=>{
  const f=await fixture(),id='r42_final_pending',sid=`sess_${randomUUID()}`;
  quizzes.set(id,{id,user_id:'r41_owner',title:'Explain',questions:[{id:'1',question:'Explain your claim.',type:'open_ended',answer:'A justified claim.',points:2}]});
  let release!:()=>void,entered!:()=>void,calls=0;
  const barrier=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
  configureGeminiClientForTests(()=>({models:{generateContent:async()=>{calls++;entered();await barrier;return {text:JSON.stringify({score_fraction:0.5,feedback:'Your explanation partly addresses the question.'})};}}}) as any);
  try {
    const a=(await f.post(`/api/live/${id}/start`,{},f.token)).data.run;
    const body={quiz_id:id,session_id:sid,answers:{0:'My claim and reason.'},answer_revisions:{0:1},session_revision:1};
    const final=f.post('/api/submit_quiz',body);await started;
    assert.equal(results.get('res_'+sid)?.graded_details?.[0].grade_status,'pending');
    assert.equal((await f.post(`/api/live/${id}/terminate`,{expected_run_id:a.id},f.token)).response.status,200);
    release();assert.equal((await final).response.status,200);assert.equal(calls,1);
    const saved=structuredClone(results.get('res_'+sid));assert.equal(saved?.live_run_id,a.id);assert.equal(saved?.total_score,1);
    assert.equal((await f.post('/submit',body)).data.result_id,'res_'+sid);assert.deepEqual(results.get('res_'+sid),saved);assert.equal(calls,1);
  } finally {release();results.delete('res_'+sid);quizzes.delete(id);classroomRuns.delete(id);liveSessions.delete(id);await f.close();}
});
