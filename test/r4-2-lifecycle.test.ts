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
