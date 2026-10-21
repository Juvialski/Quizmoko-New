import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('R4.2 durable run/attempt admission, restart, no heartbeat writes and failed transition rollback',async()=>{
  const previous={...process.env},directory=fs.mkdtempSync(path.join(os.tmpdir(),'quizmoko-r42-'));
  process.env.QUIZMOKO_DATA_DIR=directory;process.env.AI_STUDIO_SANDBOX='false';process.env.REQUIRE_FIRESTORE='true';process.env.FIREBASE_ADMIN_ENABLED='false';
  const db=await import('../src/store/db.ts');const runs=await import('../src/services/classroomRuns.ts');const live=await import('../src/services/socket.ts');
  const remote=new Map<string,any>();let fail=false,writes=0;
  function collection(prefix:string):any {return {
    get:async()=>({docs:[...remote].filter(([key])=>key.startsWith(prefix+'/')&&!key.slice(prefix.length+1).includes('/')).map(([key,value])=>({id:key.slice(prefix.length+1),data:()=>structuredClone(value)}))}),
    doc:(id:string)=>({set:async(value:any)=>{if(fail)throw Error('Synthetic persistence failure');writes++;remote.set(prefix+'/'+id,structuredClone(value));},delete:async()=>remote.delete(prefix+'/'+id),collection:(name:string)=>collection(prefix+'/'+id+'/'+name)})
  };}
  db.configurePersistenceBackendForTests({collection});
  try {
    const quiz={id:'durable-class',user_id:'owner',title:'Class',questions:[]};db.quizzes.set(quiz.id,quiz);
    fail=true;await assert.rejects(runs.changeClassroomRun(quiz.id,'owner','start'));assert.equal(db.classroomRuns.has(quiz.id),false);
    fail=false;const a=(await runs.changeClassroomRun(quiz.id,'owner','start')).run;
    await runs.bindClassroomAttempt(quiz.id,'sess_old',null,'Morning');
    const b=(await runs.changeClassroomRun(quiz.id,'owner','start',a.id,true)).run;
    fail=true;await assert.rejects(runs.bindClassroomAttempt(quiz.id,'sess_failed',null));assert.equal(db.results.has('res_sess_failed'),false);
    await assert.rejects(runs.changeClassroomRun(quiz.id,'owner','end',b.id));assert.equal(db.classroomRuns.get(quiz.id)?.status,'active');
    fail=false;await runs.bindClassroomAttempt(quiz.id,'sess_current',null,'Afternoon');
    // Admit once; neither reconnect nor repeated HTTP/socket telemetry writes a new record.
    const before=writes;for(let i=0;i<10;i++){await runs.bindClassroomAttempt(quiz.id,'sess_current',null);live.updateLiveSession(quiz.id,{session_id:'sess_current'});}assert.equal(writes,before);
    await runs.changeClassroomRun(quiz.id,'owner','pause',b.id);
    db.results.clear();db.classroomRuns.clear();db.liveSessions.clear();assert.equal(await db.loadFromFirestore(),true);
    const recovered=live.reconcileLiveResults(quiz.id);assert.equal(recovered.run?.id,b.id);assert.equal(recovered.paused,true);
    assert.deepEqual(Object.keys(recovered.sessions),['sess_current']);assert.equal(recovered.sessions.sess_current.last_active,0);assert.equal(recovered.sessions.sess_current.whiteboard_state_known,false);
    assert.equal(db.results.get('res_sess_old')?.live_run_id,a.id);
    await runs.changeClassroomRun(quiz.id,'owner','end',b.id);db.classroomRuns.clear();db.liveSessions.clear();await db.loadFromFirestore();
    assert.equal(live.reconcileLiveResults(quiz.id).terminated,true);
    assert.equal(runs.attemptControls(quiz.id,'sess_old')?.terminated,true);
    assert.equal(remote.has('results/res_sess_old'),true);
  }finally {
    fail=false;await db.flushPendingPersistence(2000);process.env=previous;
    const resolved=path.resolve(directory);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('quizmoko-r42-'));fs.rmSync(resolved,{recursive:true,force:true});
  }
});
