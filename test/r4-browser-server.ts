// Hermetic UI fixture server: production data and providers are never loaded.
import express from 'express';
import { createServer } from 'node:http';
import { initSocketServer } from '../src/services/socket.ts';
import ejs from 'ejs';
import { execFileSync } from 'node:child_process';
import { registerRoutes } from '../src/routes/index.ts';
import { quizzes, results, users, aiJobs } from '../src/store/db.ts';
const app = express(); app.set('view engine','ejs'); app.use(express.json()); app.use(express.urlencoded({extended:true})); app.use(express.static('public'));
quizzes.clear();results.clear();users.clear();
users.set('teacher_test',{uid:'teacher_test',name:'Synthetic Teacher',email:'teacher@example.invalid',role:'admin'});
export function fixtureQuestion(id='7b', review=false) {
  return {id,question:'Choose the word Alpha. $1 + 1 = 2$.',type:'multiple_choice',options:['Alpha','Beta','Gamma','Delta'],answer:'A',points:1,solution:'Alpha is the requested word.',source:{original_index:id,page_number:1,source_file:'synthetic.pdf'},verification:{answer_source:'manual',verification_status:review?'review_required':'verified'}};
}
function fixture(id: string, title: string, review=false) {
  const quiz = {id,user_id:'teacher_test',title,subject:'English',folder:'Unit 1',time_limit:200,quiz_mode:'back_and_forth',is_draft:review,created_at:'2026-10-13T00:00:00Z',questions:[fixtureQuestion('7b',review),fixtureQuestion('8')]}; quizzes.set(id,quiz); return quiz;
}
fixture('r4_published','Published language quiz'); fixture('r4_draft','Draft needing attention',true);
if (process.env.FINAL_UI_FIXTURES === '1') {
  const {default:sharp}=await import('sharp');
  const png=await sharp(Buffer.from('<svg width="48" height="48"><rect width="48" height="48" fill="white"/><path d="M0 48L48 0" stroke="black"/></svg>')).png().toBuffer();
  const diagram=`<div class="resizable-image-wrapper"><div class="image-content-box"><img src="data:image/png;base64,${png.toString('base64')}" alt="Source Diagram"></div></div>`;
  const long=fixture('reliable_diagrams','Thirty published worksheet questions');
  long.questions=Array.from({length:30},(_,i)=>({...fixtureQuestion(String(i+1)+'b'),question:'Choose Alpha. '+diagram,worksheet_qa:{local_evidence:{version:1}}})) as any;
  for(const [id,source] of [['broken','https://kroki.io/tikz/svg/broken'],['corrupt','data:image/png;base64,aW52YWxpZA=='],['slow','https://kroki.io/tikz/svg/slow']]) {
    const q=fixture('image_'+id,id+' image');q.questions=[{...fixtureQuestion('7b'),question:`Choose Alpha. <img src="${source}" alt="Source Diagram">`,worksheet_qa:{local_evidence:{version:1}}}] as any;
  }
  const now=Date.now();
  const job={owner_uid:'teacher_test',task:'generation',label:'Generating Quiz',status:'needs_attention',started_at:now,updated_at:now,completed:30,total:30,idempotency_key:'synthetic-historical-key',quiz_id:long.id};
  aiJobs.set('historical',{...job,id:'historical'} as any);
  aiJobs.set('historical-duplicate',{...job,id:'historical-duplicate',started_at:now-1} as any);
  aiJobs.set('failed',{...job,id:'failed',quiz_id:undefined,status:'failed',error:'Synthetic provider unavailable',started_at:now-2} as any);
}
results.set('r4_result',{id:'r4_result',quiz_id:'r4_published',student_name:'Synthetic Student',score:1,total:2,created_at:'2026-10-13T00:01:00Z',finalized:true,details:[{...fixtureQuestion(),question:'Choose the word Alpha. $1 + 1 = 2$.',user_answer:'Beta',correct_answer:'Alpha',score_fraction:0,is_correct:false,grade_status:'graded',ai_feedback:'Choose Alpha next time.'}]});
app.get('/__baseline',(_req,res)=>res.send(ejs.render(execFileSync('git',['show','045765a:views/index.ejs'],{encoding:'utf8'}),{grouped_quizzes:{English:[quizzes.get('r4_published')]},all_subjects:['General','English'],all_folders:['Unit 1'],is_admin:false,is_rmx_authorized:true,user:users.get('teacher_test')})));
app.get('/api/ai/config',(_req,res)=>res.json({gemini_configured:true,ollama_configured:false}));
app.post('/api/generate_ai',async (req,res)=>{
  if (req.body.topic === 'Rate limit fixture') return res.status(429).set('Retry-After','60').json({error:'Busy'});
  await new Promise(resolve=>setTimeout(resolve,200));
  const quiz=fixture('r4_ai','AI draft needing review',true); res.status(201).json({success:true,quiz_id:quiz.id,redirect:'/edit/'+quiz.id});
});
app.post('/api/extract_worksheet',(_req,res)=>res.json({success:true,questions:[{...fixtureQuestion('7b',true),raw_text:'Choose the word Alpha.',page_number:1,original_index:'7b'}],missing_indices:[]}));
app.post('/api/solve_worksheet',(req,res)=>{
  const quiz=fixture('r4_worksheet','Worksheet draft',true); quiz.questions=req.body.questions.map((q: any)=>({...q,question:q.raw_text || q.question}));
  app.locals.worksheetId=quiz.id; res.json({success:true});
});
app.get('/api/progress/:id',(_req,res)=>res.json({status:'completed',percentage:100,quiz_id:app.locals.worksheetId,message:'Draft ready for review'}));
registerRoutes(app);
app.use((error: any,_req: any,res: any,_next: any)=>res.status(500).json({error:error.message}));
const server=createServer(app);const io=initSocketServer(server);server.listen(3000,'127.0.0.1',()=>console.log('R4 synthetic server ready'));
process.on('SIGTERM',()=>{io.close();server.close();});
