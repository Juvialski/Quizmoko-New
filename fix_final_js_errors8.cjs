const fs = require('fs');

let vs = fs.readFileSync('views/view_solutions.ejs', 'utf8');
vs = vs.replace(/startsWith\('<div class="resizable-image-wrapper''\)/g, 'startsWith(\'<div class="resizable-image-wrapper">\')');
fs.writeFileSync('views/view_solutions.ejs', vs);

let qe = fs.readFileSync('views/quiz.ejs', 'utf8');
qe = qe.replace(/createElement\("div'\);/g, 'createElement("div");');
fs.writeFileSync('views/quiz.ejs', qe);

let eq = fs.readFileSync('views/edit_quiz.ejs', 'utf8');
eq = eq.replace(/invalidQuestions\.join\('', "\)/g, "invalidQuestions.join(', ')");
fs.writeFileSync('views/edit_quiz.ejs', eq);

