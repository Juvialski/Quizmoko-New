const fs = require('fs');

let content = fs.readFileSync('views/index.ejs', 'utf8');

content = content.replace(/onclick="copyLink\('([^']+)'\)"\)"/g, 'onclick="copyLink(\'$1\')"');
content = content.replace(/onclick="openMoveModal\('([^']+)', '([^']+)'\)"\)"/g, 'onclick="openMoveModal(\'$1\', \'$2\')"');

content = content.replace(/onclick="copyLink\('<%= typeof sq\.id !== 'undefined' \? sq\.id : '' %>'\)"\)"/g, 'onclick="copyLink(\'<%= typeof sq.id !== \\\'undefined\\\' ? sq.id : \\\'\\\' %>\')"');

fs.writeFileSync('views/index.ejs', content);

let contentQuiz = fs.readFileSync('views/quiz.ejs', 'utf8');
contentQuiz = contentQuiz.replace(/setTool\('([^']+)"\)"/g, "setTool('$1')\"");
fs.writeFileSync('views/quiz.ejs', contentQuiz);
