const fs = require('fs');
let content = fs.readFileSync('views/view_solutions.ejs', 'utf8');
content = content.replace(/querySelector\('span\[style\*='background: var\(--surface-soft\)'\]'\)/g, "querySelector(\"span[style*='background: var(--surface-soft)']\")");
fs.writeFileSync('views/view_solutions.ejs', content);
