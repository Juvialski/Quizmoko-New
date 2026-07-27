const fs = require('fs');

let eq = fs.readFileSync('views/edit_quiz.ejs', 'utf8');
eq = eq.replace(/invalidQuestions\.join\(', "\)/g, "invalidQuestions.join(', ')");
fs.writeFileSync('views/edit_quiz.ejs', eq);
