import fs from 'node:fs/promises';
import sharp from 'sharp';
const folder='docs/ui-redesign-2026-10-25';
const all=(await fs.readdir(folder)).filter(n=>/^(before|after)-.*\.png$/.test(n)&&!n.includes('contact-sheet')).sort();
for(const stage of ['before','after']){
 const files=all.filter(n=>n.startsWith(stage));const width=1280,tileW=640,tileH=494;
 const composites=[];
 for(const [i,file] of files.entries()){
  const left=(i%2)*tileW,top=Math.floor(i/2)*tileH;
  const label=file.replace('.png','').replaceAll('-',' ');
  composites.push({input:Buffer.from(`<svg width="640" height="40"><rect width="640" height="40" fill="#eef2f8"/><text x="16" y="26" font-size="17" font-family="Arial" fill="#152440">${label}</text></svg>`),left,top});
  composites.push({input:await sharp(folder+'/'+file).resize(624,440,{fit:'contain',background:'#eef2f8'}).png().toBuffer(),left:left+8,top:top+42});
 }
 await sharp({create:{width,height:Math.ceil(files.length/2)*tileH,channels:3,background:'#eef2f8'}}).composite(composites).png({compressionLevel:9}).toFile(`${folder}/${stage}-contact-sheet.png`);
}
const intro=`# QuizMoKo UI redesign — visual review\n\nReview branch: codex/unified-ui-redesign-2026-10-25. Leave the PR open until owner visual approval.\n\nAll images contain isolated synthetic data. Before uses the exact pre-redesign templates and task script at main commit 494b656; after uses this branch. The same fixture data, 1366 × 960 desktop and 390 × 960 mobile viewports, plus additional 1920px wide and dark-mode views. External fonts/icons/MathJax are used. Screenshots show real rendered EJS/client scripts, with mocked extraction and solving; they do not demonstrate live Gemini accuracy or production Firestore durability. Student screenshots show an initiated synthetic practice attempt. No private production screenshots or records are committed.\n\nProduction inspection used Chrome profile Al with Hubstaff stopped, and remained read-only: dashboard, generator, three worksheet tools, editor, student start screen, monitoring and results. Responsive and mutation acceptance used the isolated local browser.\n\n## Contact sheets\n\n![Before contact sheet](before-contact-sheet.png)\n\n![After contact sheet](after-contact-sheet.png)\n\n## Screenshots\n\n`;
await fs.writeFile(folder+'/SCREENSHOT_INDEX.md',intro+all.map(n=>`### ${n.replace('.png','')}\n\n![${n.replace('.png','')}](${n})\n`).join('\n')+`\n## Evidence and limits\n\nSee [browser evidence](browser-evidence.json) and [implementation report](IMPLEMENTATION.md). Files and unsaved edits are retained separately per mode for the lifetime of the open Studio. Browser refresh cannot restore native File inputs; existing owned-job recovery remains available. Specialized crop tools and provider processing retain their existing implementation; crop dragging and live model accuracy are not certified by these screenshots.\n`);
