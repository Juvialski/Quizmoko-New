// Opt-in local workflow fixture. Never hydrates production or writes local data.
import fs from 'node:fs/promises';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createServer } from 'node:http';
import dotenv from 'dotenv';
import { registerRoutes } from '../src/routes/index.ts';
import { initSocketServer } from '../src/services/socket.ts';
import { users, quizzes, results, aiJobs } from '../src/store/db.ts';
import { createSessionToken, SESSION_COOKIE_NAME } from '../src/middleware/auth.ts';
import { getGeminiClient, configureGeminiClientForTests } from '../src/services/gemini.ts';
import { boundedEvaluationClient } from '../scripts/evaluationSupport.ts';
import { getGeminiReliabilitySnapshot } from '../src/services/geminiRateLimiter.ts';

if (process.env.NODE_ENV !== 'test' || process.env.AI_STUDIO_SANDBOX !== 'true' || process.env.FIREBASE_ADMIN_ENABLED !== 'false') throw Error('Use the hermetic test bootstrap.');
const live = process.argv.includes('--live');
if (live) {
  const config = dotenv.parse(await fs.readFile('.env.gemini-smoke.local'));
  if (!config.GEMINI_API_KEY) throw Error('Existing local Gemini credential required.');
  process.env.GEMINI_API_KEY = config.GEMINI_API_KEY;
}
await fs.mkdir('.local/r5', {recursive:true});
const prior:any = await fs.readFile('.local/r5/budget.json','utf8').then(JSON.parse).catch(()=>({actual_requests:0,failures:0,requests_by_model:{}}));
const budget = live ? boundedEvaluationClient(getGeminiClient(), 24-prior.actual_requests, 45*60_000) : null;
let calls = prior.actual_requests;
if (budget) configureGeminiClientForTests(() => ({models:{generateContent:async (request:any) => {
  const ordinal = ++calls;
  try {
    const response:any = await budget.client.models.generateContent(request);
    await fs.writeFile(`.local/r5/provider-${ordinal}.json`, JSON.stringify({model:request.model,maxOutputTokens:request.config?.maxOutputTokens,text:response.text,usage:response.usageMetadata,finish:response.candidates?.map((c:any)=>c.finishReason)},null,2));
    return response;
  } finally {
    const stats=budget.stats();
    const models={...prior.requests_by_model};for(const [model,n] of Object.entries(stats.requests_by_model))models[model]=(models[model]||0)+n;
    await fs.writeFile('.local/r5/budget.json', JSON.stringify({...stats,actual_requests:prior.actual_requests+stats.actual_requests,failures:prior.failures+stats.failures,requests_by_model:models,request_cap:24},null,2));
  }
}}}));
users.clear(); quizzes.clear(); results.clear(); aiJobs.clear();
const teacher:any = {uid:'r5_teacher',role:'teacher',name:'R5 Synthetic Teacher',email:'r5@example.invalid'};
users.set(teacher.uid,teacher);
for(let i=1;i<=3;i++)users.set(`r5_student_${i}`,{uid:`r5_student_${i}`,role:'student',name:`R5 Student ${i}`,email:`r5student${i}@example.invalid`});
if (process.argv.includes('--restore')) {
  const snapshot=JSON.parse(await fs.readFile('.local/r5/final-state.json','utf8'));
  for(const quiz of snapshot.quizzes || []) {
    if(quiz.user_id !== teacher.uid)throw Error('Only synthetic R5 records may be restored.');
    quizzes.set(quiz.id,quiz);
  }
  for(const result of snapshot.results || []) {
    if(!quizzes.has(result.quiz_id))throw Error('Unknown synthetic quiz.');
    results.set(result.id,result);
  }
}
const app=express();app.set('view engine','ejs');app.use(cookieParser());app.use(express.json({limit:'30mb'}));app.use(express.urlencoded({extended:true}));app.use(express.static('public'));
app.get('/__r5/login/:identity',(req,res)=>{
  const user=users.get(req.params.identity==='teacher'?'r5_teacher':`r5_student_${req.params.identity}`);
  if(!user)return res.sendStatus(404);
  res.cookie(SESSION_COOKIE_NAME,createSessionToken(user,3_600_000),{httpOnly:true,sameSite:'lax'}).redirect('/');
});
app.get('/__r5/state',(_req,res)=>res.json({budget:budget?.stats(),metrics:getGeminiReliabilitySnapshot(),jobs:[...aiJobs.values()],quizzes:[...quizzes.values()],results:[...results.values()]}));
// Fail before the provider boundary, for a repeatable UI error/retry check.
app.post('/api/generate_ai',(req,res,next)=>req.body.topic==='R5 synthetic failure'?res.status(429).set('Retry-After','2').json({error:'Synthetic provider busy; retry in 2 seconds.'}):next());
registerRoutes(app);
app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status||500).json({error:'R5 fixture request failed safely'}));
const server=createServer(app);const io=initSocketServer(server);app.set('io',io);
server.listen(3000,'127.0.0.1',()=>console.log(`R5 isolated server ready; live Gemini=${live}; SDK cap=24`));
process.on('SIGTERM',()=>{io.close();server.close();});
