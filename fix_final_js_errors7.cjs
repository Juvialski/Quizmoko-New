const fs = require('fs');

let vs = fs.readFileSync('views/view_solutions.ejs', 'utf8');
vs = vs.replace(/alert\('Failed to generate explanation. Please try again."\);/g, 'alert("Failed to generate explanation. Please try again.");');
fs.writeFileSync('views/view_solutions.ejs', vs);

let qe = fs.readFileSync('views/quiz.ejs', 'utf8');
qe = qe.replace(/getElementById\('score-text"\)/g, 'getElementById("score-text")');
fs.writeFileSync('views/quiz.ejs', qe);

let eq = fs.readFileSync('views/edit_quiz.ejs', 'utf8');
eq = eq.replace(/=== "no answer provided'\)/g, '=== "no answer provided")');
fs.writeFileSync('views/edit_quiz.ejs', eq);

