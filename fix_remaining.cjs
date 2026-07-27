const fs = require('fs');

let eq = fs.readFileSync('views/edit_quiz.ejs', 'utf8');
eq = eq.replace(/quiz\.id : '"/g, "quiz.id : ''");
eq = eq.replace(/permanently\.'\);' style/g, "permanently.');\" style");
fs.writeFileSync('views/edit_quiz.ejs', eq);

let vs = fs.readFileSync('views/view_solutions.ejs', 'utf8');
vs = vs.replace(/id='feedback-<%= itemIdx %>"/g, 'id="feedback-<%= itemIdx %>"');
vs = vs.replace(/qType === "open_ended'/g, "qType === 'open_ended'");
vs = vs.replace(/%>;'>/g, '%>;">');
fs.writeFileSync('views/view_solutions.ejs', vs);
