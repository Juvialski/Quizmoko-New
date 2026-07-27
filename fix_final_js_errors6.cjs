const fs = require('fs');

let vs = fs.readFileSync('views/view_solutions.ejs', 'utf8');
vs = vs.replace(/quiz_id: "<%= typeof result\.quiz_id !== 'undefined' \? result\.quiz_id : '' %>"',/g, "quiz_id: '<%= typeof result.quiz_id !== \\'undefined\\' ? result.quiz_id : \\'\\' %>',");
// wait it might be quiz_id: "null', which in ejs is quiz_id: "<%= ... %>"', -> oh I tried that before. Let's just find and replace "null', in temp.js but wait, I can just replace `quiz_id: "<%= typeof result.quiz_id !== 'undefined' ? result.quiz_id : '' %>"',` with `quiz_id: "<%= typeof result.quiz_id !== 'undefined' ? result.quiz_id : '' %>",`. Let's just do `quiz_id: "<%= typeof result.quiz_id !== 'undefined' ? result.quiz_id : '' %>',` to `quiz_id: "<%= typeof result.quiz_id !== 'undefined' ? result.quiz_id : '' %>",`.

vs = vs.replace(/quiz_id: "<%= typeof result\.quiz_id !== 'undefined' \? result\.quiz_id : '' %>"',/g, 'quiz_id: "<%= typeof result.quiz_id !== \'undefined\' ? result.quiz_id : \'\' %>",');
vs = vs.replace(/quiz_id: "<%= typeof result\.quiz_id !== 'undefined' \? result\.quiz_id : '' %>',/g, 'quiz_id: "<%= typeof result.quiz_id !== \'undefined\' ? result.quiz_id : \'\' %>",');
fs.writeFileSync('views/view_solutions.ejs', vs);

let qe = fs.readFileSync('views/quiz.ejs', 'utf8');
qe = qe.replace(/data\.correct_answer === 'Grading Error"/g, 'data.correct_answer === "Grading Error"');
fs.writeFileSync('views/quiz.ejs', qe);

let eq = fs.readFileSync('views/edit_quiz.ejs', 'utf8');
eq = eq.replace(/header\.style\.marginTop = "0';/g, 'header.style.marginTop = "0";');
fs.writeFileSync('views/edit_quiz.ejs', eq);
