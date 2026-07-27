const fs = require('fs');
function fix(file, regex, replacement) {
    let content = fs.readFileSync(file, 'utf8');
    content = content.replace(regex, replacement);
    fs.writeFileSync(file, content);
}

fix('views/worksheet_upload.ejs', /"solve_' \+/g, '"solve_" +');
fix('views/worksheet_answers_upload.ejs', /\|\| 'Matched Quiz",/g, '|| "Matched Quiz",');
fix('views/view_solutions.ejs', /quiz_id: "null',/g, "quiz_id: 'null',");
fix('views/quiz.ejs', /classList\.add\("feedback-wrong'\);/g, "classList.add('feedback-wrong');");
fix('views/index.ejs', /'var\(--success\)";/g, '"var(--success)";');
fix('views/edit_quiz.ejs', /'100";/g, '"100";');

// for worksheet.ejs let's fix it by fixing the outer structure
let ws = fs.readFileSync('views/worksheet.ejs', 'utf8');
// "Unexpected end of input" means maybe missing } or closing quote
// I will just use `git checkout views/worksheet.ejs` NO I don't have git!
// Let me just manually edit worksheet.ejs if needed.

