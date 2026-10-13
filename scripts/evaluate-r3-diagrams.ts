import sharp from 'sharp';
import {performance} from 'node:perf_hooks';
import {analyzeDiagram} from '../src/services/diagramEvidence.ts';
import {diagramFixtures} from '../test/fixtures/r3-diagrams.ts';
import {writeEvaluationReport,EVALUATION_VERSION} from './evaluationSupport.ts';
const items=[];const at=performance.now();
for(const fixture of diagramFixtures){
  const evidence=analyzeDiagram(fixture.question);let decoded=false,width:number|undefined,height:number|undefined;
  if(evidence.svg){const png=await sharp(Buffer.from(evidence.svg),{limitInputPixels:12_000_000}).timeout({seconds:5}).png().toBuffer();const meta=await sharp(png).metadata();width=meta.width;height=meta.height;decoded=Boolean(width&&height&&png.length);}
  const expected=decoded===fixture.render&&(!fixture.issue||evidence.issues.some(i=>i.includes(fixture.issue)));
  if(!expected)process.exitCode=1;
  items.push({id:fixture.id,source_validated:evidence.source_validated,render_validated:decoded,semantic_validated:evidence.semantic_validated,width:width??null,height:height??null,issues:evidence.issues,expectation_met:expected});
}
const report={version:EVALUATION_VERSION,mode:'actual local structured SVG to PNG decoding; not Kroki or semantic visual acceptance',total:items.length,rendered:items.filter(i=>i.render_validated).length,semantic_validated:0,expectations_met:items.filter(i=>i.expectation_met).length,requests:0,elapsed_ms:performance.now()-at,rss_bytes:process.memoryUsage().rss,items};
const output=process.argv.find(a=>a.startsWith('--output='));
if(output)writeEvaluationReport(output.slice(9),report,`# R3 diagram evaluation\n\n${report.mode}.\n\n${report.rendered}/${report.total} images rendered; ${report.expectations_met}/${report.total} expectations passed. Semantic validation remains inconclusive; teacher visual review is required.`);
console.log(JSON.stringify(report,null,2));
