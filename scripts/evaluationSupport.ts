import fs from 'node:fs';
import { GeminiRateLimitError } from '../src/services/geminiRateLimiter.ts';

export const EVALUATION_VERSION = 'r3-evaluation-v1';
/** Wraps the SDK at its actual call boundary. Queue attempts do not masquerade as hosted requests. */
export function boundedEvaluationClient(client: any, maximumRequests = 60, deadlineMs = 8*60*1000) {
  if (!Number.isInteger(maximumRequests) || maximumRequests<1 || maximumRequests>60) throw new Error('Request budget must be within 1..60.');
  let requests=0, failures=0, adjudications=0;
  const controller=new AbortController();
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(deadlineMs)]);
  const models:Record<string,number>={};
  const wrapped={models:{async generateContent(request:any){
    if(signal.aborted) throw signal.reason;
    if(requests>=maximumRequests){controller.abort();throw new GeminiRateLimitError('Evaluation request budget exhausted.',60);}
    requests++;models[request.model]=(models[request.model]||0)+1;
    if(String(JSON.stringify(request.contents)||'').includes('blind adjudicator'))adjudications++;
    const transportSignal=request.config?.abortSignal ? AbortSignal.any([signal,request.config.abortSignal]) : signal;
    try{return await client.models.generateContent({...request,config:{...request.config,abortSignal:transportSignal,
      httpOptions:{...request.config?.httpOptions,retryOptions:{attempts:1}}}});}
    catch(error){failures++;if(Number((error as any)?.status)===429)controller.abort();throw error;}
  }}};
  return {client:wrapped,signal,stats:()=>({actual_requests:requests,failures,adjudication_requests:adjudications,requests_by_model:models,request_cap:maximumRequests})};
}
export function writeEvaluationReport(path: string, report:any, summary:string) {
  fs.writeFileSync(path,JSON.stringify(report,null,2)+'\n');
  fs.writeFileSync(path.replace(/\.json$/i,'')+'.md',summary+'\n');
}
export function representativeSubset<T extends {category:string}>(corpus:T[],limit:number):T[]{
  const selected:T[]=[],seen=new Set<string>();
  for(const item of corpus)if(!seen.has(item.category)){selected.push(item);seen.add(item.category);if(selected.length===limit)return selected;}
  for(const item of corpus)if(!selected.includes(item)){selected.push(item);if(selected.length===limit)return selected;}
  return selected;
}
