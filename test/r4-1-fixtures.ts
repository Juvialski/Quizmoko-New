import { createHash } from 'node:crypto';
export function syntheticPdf(): Buffer {
  const objects:string[]=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>'];
  for(let i=0;i<3;i++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 9 0 R >> >> /Contents ${4+i*2} 0 R >>`);
    const text=`BT /F1 16 Tf 20 250 Td (${['7a','7b','8'][i]}. Choose Alpha.) Tj ET`;
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let pdf='%PDF-1.4\n';const offsets=[0];
  objects.forEach((obj,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;});
  const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  for(const offset of offsets.slice(1))pdf+=String(offset).padStart(10,'0')+' 00000 n \n';
  pdf+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
export const mockQuestion=(id:string)=>({id,question:`Choose Alpha for item ${id}.`,type:'multiple_choice',options:['Alpha','Beta','Gamma','Delta'],answer:'A',solution:'Alpha is requested.',points:1});
export function tutorialProvider(delay=150) {
  const pageCalls=new Map<string,number>();let calls=0;let pageCount=0;
  return {get calls(){return calls;},get pageCalls(){return [...pageCalls.values()];},client:{models:{generateContent:async(request:any)=>{
    calls++;await new Promise(resolve=>setTimeout(resolve,delay));
    const schema=request.config.responseSchema;const properties=schema?.items?.properties || schema?.properties || {};
    const prompt=typeof request.contents==='string'?request.contents:String(request.contents[0]?.parts?.[0]?.text || request.contents[0]);
    if(properties.score_fraction) {
      if(prompt.includes('TEMPORARY'))throw Object.assign(new Error('Synthetic provider outage'),{status:503});
      return {text:JSON.stringify({score_fraction:0.5,feedback:'Your explanation partly addresses the question.'})};
    }
    if(properties.raw_text && properties.bounding_box) {
      const image=request.contents.find((c:any)=>c.inlineData)?.inlineData.data;
      const key=createHash('sha256').update(image).digest('hex');
      if(!pageCalls.has(key))pageCount++;
      const ordinal=pageCalls.has(key)?[...pageCalls.keys()].indexOf(key)+1:pageCount;
      pageCalls.set(key,(pageCalls.get(key)||0)+1);
      if(ordinal===2 && pageCalls.get(key)===1)throw Object.assign(new Error('Synthetic page outage'),{status:503});
      const id=['7a','7b','8'][ordinal-1] || String(ordinal);
      return {text:JSON.stringify([{raw_text:'Choose the word Alpha.',verbatim_text:'Choose the word Alpha.',context_prefix:'',options:['Alpha','Beta','Gamma','Delta'],type:'multiple_choice',original_index:ordinal===2?'*'+id:id,bounding_box:[]}])};
    }
    if(properties.confidence){const payload=JSON.parse(prompt.split('QUESTIONS:')[1].trim().split('\n\nRETRY')[0]);return {text:JSON.stringify(payload.map((q:any)=>({id:q.id,answer:'A',solution:'Alpha is requested.',confidence:'high'})))};}
    if(properties.source_index && !properties.question){const payload=JSON.parse(prompt.split('QUESTIONS TO PROCESS (JSON):')[1].trim().split('\n')[0]);return {text:JSON.stringify(payload.map((q:any)=>({source_id:q.source_id,source_index:q.source_index,type:'multiple_choice',options:['Alpha','Beta','Gamma','Delta'],answer:'A',solution:'Alpha is requested.'})))};}
    return {text:JSON.stringify([mockQuestion('one'),mockQuestion('two')])};
  }}}};
}
