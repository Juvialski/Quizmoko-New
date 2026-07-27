const fs = require('fs');
let content = fs.readFileSync('views/quiz.ejs', 'utf-8');

// Replace innerHTML setting for options
const oldRender = /q\.options\.forEach\(o => \{[\s\S]*?b\.className = "option-btn";[\s\S]*?b\.innerHTML = formatText\(o\);/g;

content = content.replace(/q\.options\.forEach\(o => \{/g, 'q.options.forEach((o, optIdx) => {');
content = content.replace(/b\.innerHTML = formatText\(o\);/g, 'const optionKey = String.fromCharCode(65 + optIdx);\n                        b.innerHTML = `<div class="option-key-badge">${optionKey}</div> <div style="flex-grow:1;">${formatText(o)}</div>`;');

fs.writeFileSync('views/quiz.ejs', content);
