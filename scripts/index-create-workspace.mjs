import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
const root='docs/ui-final/creation-refinement';
const states=[['ai','generator','AI generation'],['manual','manual-dialog','Manual creation'],['worksheet','worksheet','Worksheet questions'],['answer-key','answer-key','Worksheet with answer key'],['rmx','rmx','RMX spreadsheet export']];
for(const [device,width,tileWidth,tileHeight] of [['desktop',1440,720,500],['mobile',390,390,1000]]){
  const margin=16,labelHeight=36,rowHeight=tileHeight+labelHeight+margin,canvasWidth=tileWidth*2+margin*3;
  const composites=[];
  for(const [i,[current,previous,title]] of states.entries())for(const [j,[phase,file]] of [['PR #16 · before refinement',`docs/ui-final/after/${previous}-${width}-light.png`],['PR #16 · refined',`${root}/after/${current}-${width}-light.png`]].entries()){
    const left=margin+j*(tileWidth+margin),top=margin+i*rowHeight;
    const label=Buffer.from(`<svg width="${tileWidth}" height="${labelHeight}"><rect width="100%" height="100%" fill="#e7eaf2"/><text x="12" y="24" fill="#20283b" font-family="Arial" font-size="${device==='desktop'?16:13}">${title} — ${phase}</text></svg>`);
    composites.push({input:label,left,top});
    composites.push({input:await sharp(file).resize(tileWidth,tileHeight,{fit:'cover',position:'top'}).png().toBuffer(),left,top:top+labelHeight});
  }
  await sharp({create:{width:canvasWidth,height:margin+states.length*rowHeight,channels:3,background:'#e7eaf2'}}).composite(composites).png().toFile(`${root}/comparison-${device}.png`);
}
const files=(await fs.readdir(`${root}/after`)).filter(x=>x.endsWith('.png')).sort();
const rows=[...new Set(files.map(x=>x.replace(/-(1440|390)-(light|dark)\.png$/,'')))];
await fs.writeFile(`${root}/SCREENSHOTS.md`,'# Creation workflow screenshots\n\n64 rendered screenshots at 1440 × 1000 and 390 × 1000, light/dark. Expanded options and review states use full-page captures. All records are synthetic; providers are mocked.\n\n| State | Desktop light | Desktop dark | Mobile light | Mobile dark |\n| --- | --- | --- | --- | --- |\n'+rows.map(name=>`| ${name} | `+[1440,390].flatMap(width=>['light','dark'].map(theme=>`[View](after/${name}-${width}-${theme}.png)`)).join(' | ')+' |').join('\n')+'\n');
const sources=['views/index.ejs','views/partials/create-heading.ejs','views/partials/create-navigation.ejs','views/worksheet_upload.ejs','views/worksheet_answers_upload.ejs','views/rmxflash_upload.ejs','public/js/workspace-ui.js','public/js/worksheet-studio.js','public/css/ui-redesign.css','scripts/test-create-workspace-browser.mjs'];
await fs.writeFile(`${root}/source-fingerprints.json`,JSON.stringify({baseline:'209fcdbc18a8d8d834c55d6b48d77e8474b6d6bf',files:await Promise.all(sources.map(async path=>({path,sha256:createHash('sha256').update(await fs.readFile(path)).digest('hex')})))},null,2));
console.log(`Indexed ${files.length} screenshots and built desktop/mobile comparisons.`);
