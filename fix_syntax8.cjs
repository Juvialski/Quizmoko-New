const fs = require('fs');
let content = fs.readFileSync('views/view_solutions.ejs', 'utf8');
content = content.replace(/let jsonStr = val.replace\(\/'\/g, '''\);/g, "let jsonStr = val.replace(/'/g, '\"');");
fs.writeFileSync('views/view_solutions.ejs', content);
