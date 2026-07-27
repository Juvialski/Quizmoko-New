const fs = require('fs');

let vs = fs.readFileSync('views/view_solutions.ejs', 'utf8');
vs = vs.replace(/alert\('Sync completed, but some items might still be grading. Try again in a few seconds."\);/g, 'alert("Sync completed, but some items might still be grading. Try again in a few seconds.");');
fs.writeFileSync('views/view_solutions.ejs', vs);

let qe = fs.readFileSync('views/quiz.ejs', 'utf8');
qe = qe.replace(/renderMath\('review-container"\);/g, 'renderMath("review-container");');
fs.writeFileSync('views/quiz.ejs', qe);
