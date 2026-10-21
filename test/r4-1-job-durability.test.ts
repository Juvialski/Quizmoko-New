import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

test('R4.1 acknowledged job metadata rehydrates, interrupted drafts recover and failed acceptance releases capacity',async()=>{
  const previous={...process.env};const directory=fs.mkdtempSync(path.join(os.tmpdir(),'quizmoko-r41-'));
  process.env.QUIZMOKO_DATA_DIR=directory;process.env.AI_STUDIO_SANDBOX='false';process.env.REQUIRE_FIRESTORE='true';process.env.FIREBASE_ADMIN_ENABLED='false';
  const db=await import('../src/store/db.ts');const jobs=await import('../src/services/ownedJobs.ts');
  const remote=new Map<string,any>();let failJobWrites=false;
  function collection(prefix:string):any{return {
    get:async()=>({docs:[...remote].filter(([key])=>key.startsWith(prefix+'/')&&!key.slice(prefix.length+1).includes('/')).map(([key,value])=>({id:key.slice(prefix.length+1),data:()=>structuredClone(value)}))}),
    doc:(id:string)=>({set:async(value:any)=>{if(failJobWrites&&prefix==='ai_jobs')throw new Error('Synthetic job persistence failure');remote.set(prefix+'/'+id,structuredClone(value));},delete:async()=>{remote.delete(prefix+'/'+id);},collection:(name:string)=>collection(prefix+'/'+id+'/'+name)})
  };}
  db.configurePersistenceBackendForTests({collection});
  let released=0;let accepted:any;
  const response:any={status(){return this;},json(value:any){accepted=value;return this;}};
  try {
    const request:any={user:{uid:'durable_job_teacher',role:'teacher'},body:{idempotency_key:randomUUID(),num_items:1,api_key:'synthetic-secret-never-persist'}};
    await jobs.startOwnedJob(request,response,'generation',{release(){released++;}},async job=>{
      const quiz:any={id:'durable_job_quiz',user_id:request.user.uid,title:'Synthetic',is_draft:true,questions:[],background_job_id:job.id,background_job_complete:true};
      await db.persistQuizCreation(quiz);return quiz.id;
    });
    assert.ok(accepted.job_id);const id=accepted.job_id;
    for(let i=0;i<50 && remote.get('ai_jobs/'+id)?.status==='running';i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(remote.get('ai_jobs/'+id).status,'completed');assert.equal(released,1);
    assert.doesNotMatch(JSON.stringify(remote.get('ai_jobs/'+id)),/synthetic-secret|api_key/);
    // Crash window after a private batch checkpoint but before final job status.
    remote.set('ai_jobs/'+id,{...remote.get('ai_jobs/'+id),status:'running',quiz_id:undefined});
    remote.set('quizzes/durable_job_quiz',{...remote.get('quizzes/durable_job_quiz'),background_job_complete:false});
    db.aiJobs.clear();db.quizzes.clear();assert.equal(await db.loadFromFirestore(),true);
    const recovered=(await jobs.ownedJobs(request.user.uid)).find(j=>j.id===id)!;
    assert.equal(recovered.status,'interrupted');assert.equal(recovered.quiz_id,'durable_job_quiz');assert.equal(db.quizzes.get(recovered.quiz_id)?.is_draft,true);
    assert.equal(remote.get('ai_jobs/'+id).status,'interrupted');
    failJobWrites=true;let ran=false;const before=db.aiJobs.size;
    await assert.rejects(jobs.startOwnedJob({...request,body:{idempotency_key:randomUUID()}},response,'generation',{release(){released++;}},async()=>{ran=true;return 'never';}));
    assert.equal(ran,false);assert.equal(db.aiJobs.size,before);assert.equal(released,2);
  } finally {
    failJobWrites=false;await db.flushPendingPersistence(2000);db.configurePersistenceBackendForTests(null);process.env=previous;
    const resolved=path.resolve(directory);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('quizmoko-r41-'));fs.rmSync(resolved,{recursive:true,force:true});
  }
});
