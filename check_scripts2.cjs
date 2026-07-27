const fs = require('fs');
const acorn = require('acorn');
const content = fs.readFileSync('views/edit_quiz.ejs', 'utf-8');
const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
let match;
let count = 0;
while ((match = scriptRegex.exec(content)) !== null) {
  count++;
  const code = match[1];
  // skip module scripts which might use import
  if (match[0].includes('type="module"')) {
     continue;
  }
  // replace EJS tags with string to avoid parser errors
  const safeCode = code.replace(/<%=.+?%>/g, '"EJS_REPLACED"').replace(/<%.+?%>/g, '');
  try {
     acorn.parse(safeCode, {ecmaVersion: 2020});
  } catch(e) {
     console.error(`Error in script ${count}:`, e.message);
     const lines = safeCode.split('\n');
     console.log('Around line', e.loc.line, ':');
     for(let i=Math.max(0, e.loc.line-3); i<Math.min(lines.length, e.loc.line+3); i++) {
        console.log(`${i+1}: ${lines[i]}`);
     }
  }
}
console.log('Done checking scripts');
