import { createHash } from 'node:crypto';
import {verifyMathExpression,verifyNumericAnswer} from './mathVerification.ts';

export interface DiagramEvidence {
  version: 'diagram-v1'; source_digest: string;
  source_validated: boolean; render_validated: boolean; semantic_validated: boolean;
  issues: string[]; svg?: string;
  structured?: { points: Record<string,[number,number]>; segments: [string,string][] };
}
const allowedCommands = new Set(['begin','end','draw','path','node','coordinate','fill','filldraw','foreach','pgfmathsetmacro','pgfmathsetseed','pgfmathparse','pgfmathresult','sin','cos','tan','sqrt','frac','dfrac','text','mathrm','pi','theta','alpha','beta','gamma','delta','angle','times','cdot','le','ge','leq','geq','infty','left','right','x','y']);
export function isSafeTikzSource(code: string): boolean {
  if (!code.trim() || code.length > 20000 || /\^\^|[\u0000-\u0008\u000b\u000c\u000e-\u001f]|(?:https?|file):/i.test(code)) return false;
  // Closed command vocabulary: obfuscated control sequence construction and file operations cannot pass.
  const commands = [...code.matchAll(/\\([a-z]+|.)/gi)];
  return commands.every(m=>allowedCommands.has(m[1]) || ['{','}',',',';','!','%',' ','$','_'].includes(m[1]))
    && [...code.matchAll(/\\(?:begin|end)\s*\{([^}]+)\}/g)].every(m=>m[1]==='tikzpicture');
}
const escapeXml = (text: string) => text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
type Point = [number,number];
const pair = '(-?(?:\\d+(?:\\.\\d+)?|\\.\\d+))\\s*,\\s*(-?(?:\\d+(?:\\.\\d+)?|\\.\\d+))';

/** Closed, fully consumed subset. Unsupported source retains the original preview/teacher path. */
export function analyzeDiagram(question: string): DiagramEvidence {
  const blocks = [...question.matchAll(/\[TIKZ\]([\s\S]*?)\[\/TIKZ\]/gi)];
  const code = blocks.map(m=>m[1]).join('\n');
  const result: DiagramEvidence = {version:'diagram-v1',source_digest:createHash('sha256').update(code).digest('hex'),source_validated:false,render_validated:false,semantic_validated:false,issues:[]};
  if ((question.match(/\[\/?TIKZ\]/gi)||[]).length !== blocks.length*2) {result.issues.push('Incomplete TikZ block delimiters.');return result;}
  if (!code) return result;
  if (blocks.length !== 1) {result.issues.push('Structured renderer does not cover multiple diagram blocks.');return result;}
  const source=code.replace(/(?<!\\)%[^\r\n]*/g,'').trim();
  if (!isSafeTikzSource(source)) {result.issues.push('Unsafe or unsupported TikZ commands.'); return result;}
  let depth=0;
  for (const c of source.replace(/\\[{}]/g,'')) {if(c==='{')depth++;if(c==='}'&&--depth<0)break;}
  if(depth!==0){result.issues.push('Unbalanced TikZ source.');return result;}
  const environments:string[]=[];
  for(const m of source.matchAll(/\\(begin|end)\s*\{([^}]+)\}/g)){
    if(m[1]==='begin')environments.push(m[2]);
    else if(environments.pop()!==m[2]){result.issues.push('Unbalanced TikZ environments.');return result;}
  }
  if(environments.length){result.issues.push('Unbalanced TikZ environments.');return result;}
  result.source_validated=true;
  const clean = source.replace(/^\\begin\{tikzpicture\}\s*/, '').replace(/\s*\\end\{tikzpicture\}$/, '');
  const points: Record<string,Point>={}, labels=new Map<string,Point>(), segments:[string,string][]=[];
  const lines:[Point,Point][]=[], circles:{at:Point;r:number}[]=[], rects:[Point,Point][]=[], grids:[Point,Point][]=[];
  const xy=(a:string,b:string):Point=>[Number(a),Number(b)];
  const locate=(s:string):Point|undefined=>points[s] || (()=>{const m=s.match(new RegExp(`^${pair}$`));return m?xy(m[1],m[2]):undefined;})();
  let supported=true;
  const statements=clean.split(';').map(s=>s.trim()).filter(Boolean);
  if(!clean.trim().endsWith(';') || statements.length>200) supported=false;
  for(const statement of statements){
    let m:RegExpMatchArray|null;
    if((m=statement.match(new RegExp(`^\\\\coordinate\\s*\\(([A-Za-z]\\w*)\\)\\s*at\\s*\\(${pair}\\)$`)))) {
      if(points[m[1]]){result.issues.push('Duplicate named coordinate.');supported=false;}
      points[m[1]]=xy(m[2],m[3]);
    } else if((m=statement.match(/^\\node(?:\[(?:above|below|left|right)\])?\s*at\s*\(([^()]+)\)\s*\{\$?([A-Za-z0-9 .,+-]{1,50})\$?\}$/))) {
      const p=locate(m[1]);if(!p){supported=false;continue;} labels.set(m[2],p);
    } else if((m=statement.match(/^\\draw\s*\(([^()]+)\)\s*(--|rectangle|grid)\s*\(([^()]+)\)$/))) {
      const a=locate(m[1]),b=locate(m[3]);if(!a||!b){supported=false;continue;}
      (m[2]==='--'?lines:m[2]==='grid'?grids:rects).push([a,b]);
      if(points[m[1]]&&points[m[3]])segments.push([m[1],m[3]]);
    } else if((m=statement.match(/^\\draw\s*\(([^()]+)\)\s*circle\s*\((\d+(?:\.\d+)?)\)$/))){
      const at=locate(m[1]);if(!at||Number(m[2])<=0){supported=false;continue;}circles.push({at,r:Number(m[2])});
    } else supported=false;
  }
  result.structured={points,segments};
  const prose=question.replace(/\[TIKZ\][\s\S]*?\[\/TIKZ\]/gi,'');
  const expected=[...prose.matchAll(new RegExp(`\\b([A-Za-z]\\w*)\\s*(?:=|is at)?\\s*\\$?\\(${pair}\\)`, 'g'))];
  for(const m of expected){
    const p=points[m[1]] || labels.get(m[1]);
    if(!p)result.issues.push(`Missing visible point ${m[1]}.`);
    else if(p[0]!==Number(m[2])||p[1]!==Number(m[3]))result.issues.push(`Point ${m[1]} contradicts its declared coordinates.`);
    if(!labels.has(m[1]))result.issues.push(`Missing visible label ${m[1]}.`);
  }
  for(const m of prose.matchAll(/\b(slope|distance) (?:of|between)\s+([A-Za-z]\w*)\s*(?:and|to)\s*([A-Za-z]\w*)\s+is\s+\$?(-?\d+(?:\.\d+)?(?:\/\d+)?)\$?/gi)){
    const a=points[m[2]],b=points[m[3]];
    if(!a||!b){result.issues.push('Missing endpoint needed for the declared coordinate calculation.');continue;}
    const dx=`(${b[0]}-${a[0]})`,dy=`(${b[1]}-${a[1]})`;
    const check=m[1].toLowerCase()==='slope'?verifyMathExpression(`${dy}/${dx}`,m[4]):verifyMathExpression(`${dx}^2+${dy}^2`,`(${m[4]})^2`);
    if(check.outcome==='fail'||(m[1].toLowerCase()==='distance'&&Number(m[4])<0))result.issues.push(`Declared ${m[1]} contradicts the endpoints.`);
  }
  for(const m of prose.matchAll(new RegExp(`\\bmidpoint of\\s+([A-Za-z]\\w*)\\s+and\\s+([A-Za-z]\\w*)\\s+is\\s+\\$?\\(${pair}\\)`, 'gi'))){
    const a=points[m[1]],b=points[m[2]];if(!a||!b){result.issues.push('Missing midpoint endpoint.');continue;}
    if(verifyNumericAnswer(`(${a[0]}+${b[0]})/2`,m[3]).outcome==='fail'||verifyNumericAnswer(`(${a[1]}+${b[1]})/2`,m[4]).outcome==='fail')result.issues.push('Declared midpoint contradicts the endpoints.');
  }
  const radius=prose.match(/\bcircle (?:has|with) radius\s+\$?(\d+(?:\.\d+)?)\$?/i);
  if(radius&&circles.length===1&&verifyNumericAnswer(radius[1],String(circles[0].r)).outcome==='fail')result.issues.push('Declared circle radius contradicts the source.');
  for(const m of prose.matchAll(/\bright angle at\s+([A-Za-z]\w*)\s+in\s+(?:triangle\s+)?([A-Za-z])([A-Za-z])([A-Za-z])\b/gi)){
    const at=points[m[1]], others=[m[2],m[3],m[4]].filter(n=>n!==m[1]).map(n=>points[n]);
    if(!at||others.length!==2||others.some(p=>!p))result.issues.push('Insufficient coordinates to validate the right angle.');
    else {const [a,b]=others;const dot=verifyMathExpression(`(${a[0]}-${at[0]})*(${b[0]}-${at[0]})+(${a[1]}-${at[1]})*(${b[1]}-${at[1]})`,'0');
      if(dot.outcome==='fail' || a.every((v,i)=>v===at[i]) || b.every((v,i)=>v===at[i]))result.issues.push('Declared right angle contradicts the vertices.');}
  }
  if(/xscale|yscale|xshift|yshift|rotate|transform|x\s*=|y\s*=/.test(source))supported=false;
  if(!supported){result.issues.push('Structured renderer does not cover this complete source; preview and visual review required.');return result;}
  if(!lines.length&&!rects.length&&!grids.length&&!circles.length&&!labels.size){result.issues.push('Diagram output is empty.');return result;}
  const all:Point[]=[...Object.values(points),...labels.values(),...lines.flat(),...rects.flat(),...grids.flat(),...circles.flatMap(c=>[[c.at[0]-c.r,c.at[1]-c.r],[c.at[0]+c.r,c.at[1]+c.r]] as Point[])];
  if(all.some(p=>p.some(n=>!Number.isFinite(n)||Math.abs(n)>1000))){result.issues.push('Diagram dimensions exceed the bounded renderer.');return result;}
  const minX=Math.min(...all.map(p=>p[0])),maxX=Math.max(...all.map(p=>p[0])),minY=Math.min(...all.map(p=>p[1])),maxY=Math.max(...all.map(p=>p[1]));
  if(maxX-minX>100||maxY-minY>100){result.issues.push('Diagram extent exceeds the bounded renderer.');return result;}
  // Uniform scale preserves geometry. Labels are escaped text, never raw TeX/HTML.
  const scale=40,margin=40,w=Math.max(80,(maxX-minX)*scale+2*margin),h=Math.max(80,(maxY-minY)*scale+2*margin);
  const x=(p:Point)=>(p[0]-minX)*scale+margin,y=(p:Point)=>(maxY-p[1])*scale+margin;
  const line=(a:Point,b:Point)=>`<line x1="${x(a)}" y1="${y(a)}" x2="${x(b)}" y2="${y(b)}" stroke="black"/>`;
  let body=lines.map(([a,b])=>line(a,b)).join('');
  for(const [a,b] of rects)body+=`<rect x="${Math.min(x(a),x(b))}" y="${Math.min(y(a),y(b))}" width="${Math.abs(x(a)-x(b))}" height="${Math.abs(y(a)-y(b))}" fill="none" stroke="black"/>`;
  for(const [a,b] of grids){for(let i=Math.ceil(Math.min(a[0],b[0]));i<=Math.floor(Math.max(a[0],b[0]));i++)body+=line([i,a[1]],[i,b[1]]);for(let j=Math.ceil(Math.min(a[1],b[1]));j<=Math.floor(Math.max(a[1],b[1]));j++)body+=line([a[0],j],[b[0],j]);}
  for(const c of circles)body+=`<circle cx="${x(c.at)}" cy="${y(c.at)}" r="${c.r*scale}" fill="none" stroke="black"/>`;
  for(const [label,p] of labels)body+=`<circle cx="${x(p)}" cy="${y(p)}" r="2"/><text x="${x(p)+5}" y="${y(p)-5}" font-size="14">${escapeXml(label)}</text>`;
  result.svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="white"/>${body}</svg>`;
  // Generated SVG is structural evidence; semantic status remains conservative even when all declared points agree.
  // The route/evaluator must decode this output before recording render_validated.
  result.render_validated=false;
  result.semantic_validated=false;
  return result;
}
