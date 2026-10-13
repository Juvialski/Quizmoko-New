import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyMathematicalAnswer, verifyMathExpression, verifyNumericAnswer, verifySolutionForQuestion } from '../src/services/mathVerification.ts';
import { checkDiagram, evaluateQuestionQuality, extractionQualityIssues, detectPrintedSourceIds } from '../src/services/questionQuality.ts';
import { verifyQuestionBatch } from '../src/services/aiQuestionVerifier.ts';
import { adjudicateWorksheetSolverCandidates, reconcileWorksheetPages } from '../src/services/worksheetPipeline.ts';
import { r2Fixtures } from './fixtures/r2-quality.ts';
import { solveWorksheetBatchWithConsensus } from '../src/services/worksheetSolver.ts';
import { renderPdfPageRange } from '../src/services/pdf.ts';

test('R2 curated corpus blocks wrong consensus and preserves known correct questions', async () => {
  for (const fixture of r2Fixtures) {
    const q = {...fixture, id:fixture.id, solution:fixture.solution};
    const result = await verifyQuestionBatch({questions:[q],
      ...('golden' in fixture ? {authoritativeAnswers:{[q.id]:fixture.golden}}:{}),
      ai:{models:{async generateContent(request: any) {
        assert.ok(!String(request.contents[0]).includes('"expected":'));
        assert.ok(!String(request.contents[0]).includes('"golden":'));
        if ('solverAnswers' in fixture) {
          if (String(request.contents[0]).includes('blind adjudicator')) return {text:JSON.stringify([{id:q.id,decision:'corrected',corrected_answer:fixture.adjudicatedAnswer,corrected_solution:q.solution,confidence:'high'}])};
          return {text:JSON.stringify([{id:q.id,answer:fixture.solverAnswers[request.model==='gemini-3.5-flash-lite'?0:1],solution:q.solution,confidence:'high'}])};
        }
        return {text:JSON.stringify([{id:q.id,answer:'solverAnswer' in fixture ? fixture.solverAnswer : q.answer,solution:q.solution,confidence:'high'}])};
      }}}});
    if ('extraction' in fixture) assert.ok(extractionQualityIssues(q).length);
    assert.equal(result.questions[0].verification.verification_status,q.expected,q.id);
  }
});

test('safe exact parser handles precedence, rational decimals and bounded polynomial equivalence', () => {
  for (const [a,b] of [['0.1+0.2','0.3'],['-2^2','-4'],['(-2)^2','4'],['2^3^2','512'],['1/3+1/6','1/2'],['2(x+1)','2x+2'],['(x+y)^2','x^2+2x*y+y^2'],['\\sqrt{16}','4']]) assert.equal(verifyMathExpression(a,b).outcome,'pass',a);
  for (const [a,b] of [['1/0','0'],['0^-1','0'],['sqrt(-1)','1'],['(x+1)^2','x^2+1']]) assert.equal(verifyMathExpression(a,b).outcome,'fail',a);
  for (const a of ['x/x','sqrt(x^2)','sin(x)','globalThis.process.exit()','1;throw 0','x^10000','1e100000','__proto__','2**3']) assert.equal(verifyMathExpression(a,'1').outcome,'inconclusive',a);
  assert.equal(verifyNumericAnswer('1/3','0.333','0.001').outcome,'pass');
  assert.equal(verifyNumericAnswer('1/3','0.333').outcome,'fail');
  assert.equal(verifyNumericAnswer('1','2','-1').outcome,'inconclusive');
});

test('substitution retains domains and complete roots; unsupported wording is inconclusive', () => {
  assert.equal(verifyMathematicalAnswer('Solve $3(2x-1)=21$.','3').outcome,'fail');
  assert.equal(verifyMathematicalAnswer('Solve $sqrt(x)=x-2$.','1').outcome,'fail');
  assert.equal(verifyMathematicalAnswer('Solve $1/x=1$.','0').outcome,'fail');
  assert.equal(verifyMathematicalAnswer('Solve $1/x=1$.','1').outcome,'inconclusive');
  assert.equal(verifyMathematicalAnswer('Solve $x^2=4$.','2').outcome,'fail');
  assert.equal(verifyMathematicalAnswer('Solve $x^2=4$ for positive x.','2').outcome,'inconclusive');
  assert.equal(verifyMathematicalAnswer('What is $2+3$ if the operation is redefined?','5').outcome,'inconclusive');
  assert.equal(verifyMathematicalAnswer('Convert $2$ m to kg.','2').outcome,'fail');
  assert.equal(verifyMathematicalAnswer('Convert $2$ m to cm.','200 m').outcome,'fail');
  assert.equal(verifySolutionForQuestion('Solve $3x=12$.','$3x=9$, then $x=4$.').outcome,'fail');
  assert.equal(verifyMathematicalAnswer('Find the equation of the line through $(1,2)$ and $(3,6)$.','y=2x').outcome,'pass');
  assert.equal(verifyMathematicalAnswer('Find the equation of the line through $(1,2)$ and $(1,6)$.','x=1').outcome,'pass');
  assert.equal(verifyMathematicalAnswer('Find the equation of the line through $(1,2)$ and $(3,6)$.','y=x').outcome,'fail');
  assert.equal(verifyMathematicalAnswer('A triangle has base $8$ cm and height $5$ cm. What is its area?','20').outcome,'pass');
  assert.notEqual(verifySolutionForQuestion('Solve $x^2=4$.','$x=2$ or $x=-2$.').outcome,'fail');
  assert.equal(verifyMathematicalAnswer('Factor $x^2-1$.','x^2-1').outcome,'inconclusive');
  assert.equal(verifyMathematicalAnswer('Solve $x=4$. <img src="data:image/png;base64,eA==">','4').outcome,'inconclusive');
});

test('choice contract checks all choices and multi-select completeness', () => {
  const q={question:'Solve $x^2=4$.',options:['-2','2','3','4'],answer:['A','B'],type:'multiple_choice_multi'};
  assert.deepEqual(evaluateQuestionQuality(q).issues,[]);
  assert.ok(evaluateQuestionQuality({...q,answer:['A','C']}).issues.some(i=>i.code==='incorrect_choice_mapping'));
  assert.ok(evaluateQuestionQuality({...q,type:'multiple_choice',answer:'A'}).issues.some(i=>i.code==='multiple_correct_choices'));
  assert.deepEqual(evaluateQuestionQuality({question:'Select all correct answers.',type:'multiple_choice_multi',options:['a','b','c','d'],answer:['A','B']}).issues,[]);
});

test('diagram safety never mistakes source syntax for visual proof', () => {
  assert.equal(checkDiagram(String.raw`[TIKZ]\draw (0,0)--(1,1);[/TIKZ]`).rendered,false);
  for (const code of [String.raw`\input{secret}`,String.raw`\write18{cmd}`,String.raw`\begin{axis}\end{axis}`,String.raw`\draw (0,0)--(1,1)`,String.raw`\node {A;`,String.raw`\begin{tikzpicture}\end{scope}`]) assert.ok(checkDiagram(`[TIKZ]${code}[/TIKZ]`).issues.some(i=>i.code==='invalid_diagram'),code);
  assert.ok(checkDiagram('Use the diagram shown below.').issues.some(i=>i.code==='missing_diagram'));
});

test('worksheet consensus uses same gate and preserves immutable source identity', () => {
  const base={question:'Solve $3(2x-1)=21$.',original_index:'10(ii)',source_id:'10(ii)',source:{original_index:'10(ii)',page_number:2,source_file:'worksheet.pdf'},type:'identification',options:[]};
  const result=adjudicateWorksheetSolverCandidates(base,['a','b'].map(model=>({model,status:'fulfilled' as const,output:{answer:'3',solution:'Check the equation.',type:'identification',options:[]}})));
  assert.equal(result.publishable,false); assert.equal(result.question.original_index,'10(ii)');
  const corrected=adjudicateWorksheetSolverCandidates(base,['a','b'].map(model=>({model,status:'fulfilled' as const,output:{answer:'4',solution:'$x=4$.',type:'identification',options:[]}})));
  assert.equal(corrected.publishable,true);
  const reconciled=reconcileWorksheetPages([{page_number:2,source_file:'worksheet.pdf',questions:[{...base,raw_text:'Evaluate $3+$'}]}]);
  assert.ok(reconciled.diagnostics.some(d=>d.code==='review_required'));
  assert.equal(reconciled.questions[0].source.original_index,'10(ii)');
});

test('solver repair retries missing items only and retains successful items', async () => {
  const qs=[{id:'first',question:'What is $2+3$?',answer:'5',type:'identification',options:[],solution:'$2+3=5$.'},{id:'second',question:'What is $3+4$?',answer:'7',type:'identification',options:[],solution:'$3+4=7$.'}];
  const calls=new Map<string,number>();
  const out=await verifyQuestionBatch({questions:qs,ai:{models:{async generateContent(r:any) {
    const call=(calls.get(r.model)||0)+1; calls.set(r.model,call);
    const prompt=String(r.contents[0]);
    if(call===2) {assert.ok(!prompt.includes('"id":"first"')); assert.ok(prompt.includes('"id":"second"'));}
    const q=qs[call===1?0:1]; return {text:JSON.stringify([{id:q.id,answer:q.answer,solution:q.solution,confidence:'high'}])};
  }}}});
  assert.equal(out.questions.filter(q=>q.verification.verification_status==='verified').length,2);
  assert.deepEqual([...calls.values()],[2,2]);
});

test('embedded image vision survives blind solver and adjudicator payloads', async () => {
  const q={id:'vision',question:'Identify the shape. <img src="data:image/png;base64,aGVsbG8=">',options:[],type:'identification',answer:'triangle',solution:'The shape has three sides.'};
  let count=0;
  const out=await verifyQuestionBatch({questions:[q],ai:{models:{async generateContent(r:any) {
    count++; assert.ok(!String(r.contents[0]).includes('aGVsbG8=')); assert.ok(r.contents.some((c:any)=>c.inlineData?.data==='aGVsbG8='));
    if(count<=2) return {text:JSON.stringify([{id:q.id,answer:count===1?'triangle':'square',solution:'Inspect shape.',confidence:'high'}])};
    return {text:JSON.stringify([{id:q.id,decision:'candidate_a',confidence:'high',reason:'Three sides.'}])};
  }}}});
  assert.equal(out.questions[0].question,q.question);
});

test('printed numbering coverage checks actual page evidence including gaps and Roman IDs', () => {
  assert.deepEqual(detectPrintedSourceIds('21. Evaluate\n23. Solve\n7a. Compute\nIII. Explain\nA) distractor\nA-3. Identify'),['21','23','7a','III','A-3']);
  const out=reconcileWorksheetPages([{page_number:1,source_file:'one.pdf',detected_source_ids:['21','23','7a','III'],questions:[{original_index:'21',raw_text:'What is $2+3$?'},{original_index:'23',raw_text:'What is $3+4$?'},{original_index:'III',raw_text:'Describe the topic.'}]}]);
  assert.ok(out.diagnostics.some(d=>d.source_id==='7a' && d.code==='review_required'));
  assert.ok(!out.diagnostics.some(d=>d.source_id==='22'));
  assert.deepEqual(out.questions.map(q=>q.original_index),['21','23','III']);
});

test('one invalid worksheet item retries only that item and preserves successful batch items',async () => {
  const qs=[{original_index:'7a',source_id:'7a',question:'What is $2+3$?',type:'identification',options:[]},{original_index:'7b',source_id:'7b',question:'What is $3+4$?',type:'identification',options:[]}];
  let calls=0;
  const out=await solveWorksheetBatchWithConsensus({questions:qs,subject:'Math',topic:'Arithmetic',requestedModel:'gemini-3.5-flash-lite',deadlineAt:Date.now()+1000,
    ai:{models:{async generateContent(r:any) {calls++; const prompt=String(r.contents[0]); const selected=prompt.includes('Retry only these pending items')?qs.slice(1):qs;
      if(selected.length===1) assert.ok(!prompt.includes('"source_id":"7a"'));
      return {text:JSON.stringify(selected.map((q,i)=>({source_index:i,source_id:q.source_id,options:[],type:'identification',answer:q.source_id==='7a'?'5':'7',solution:q.source_id==='7a'?'$2+3=5$.':'$3+4=7'})))};}}} as any});
  assert.equal(calls,4); assert.equal(out[0].publishable,true); assert.equal(out[1].publishable,false);
});

test('teacher correction can revalidate without fabricated approval bypass',async () => {
  const fixture=r2Fixtures[0];
  const ai={models:{async generateContent() {return {text:JSON.stringify([{id:fixture.id,answer:'4',solution:'$x=4$.',confidence:'high'}])};}}};
  const bad=await verifyQuestionBatch({questions:[{...fixture,teacher_approved:true}],ai});
  assert.equal(bad.questions[0].verification.verification_status,'review_required');
  const corrected=await verifyQuestionBatch({questions:[{...fixture,answer:'4',solution:'$x=4$.'}],ai});
  assert.equal(corrected.questions[0].verification.verification_status,'verified');
});

test('PDF text-layer coverage is collected locally alongside the existing rasterization',async () => {
  const content='BT /F1 12 Tf 30 150 Td (21. Evaluate 2+3) Tj 0 -25 Td (23. Solve x=4) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let pdf='%PDF-1.4\n'; const offsets=[0];
  objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${object}\nendobj\n`;});
  const xref=Buffer.byteLength(pdf);
  pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  let count=0;
  await renderPdfPageRange(Buffer.from(pdf),{includeSourceText:true,maxPages:1},page=>{
    count++; assert.equal(page.pageNumber,1); assert.ok(page.image.length>0);
    assert.deepEqual(detectPrintedSourceIds(page.sourceText||''),['21','23']);
  });
  assert.equal(count,1);
});
