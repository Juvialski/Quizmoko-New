const fs = require('fs');
function fix(file, regex, replacement) {
    let content = fs.readFileSync(file, 'utf8');
    content = content.replace(regex, replacement);
    fs.writeFileSync(file, content);
}

fix('views/view_solutions.ejs', /quiz_id: "null',/g, "quiz_id: 'null',");
fix('views/quiz.ejs', /getElementById\("instant-feedback'\)/g, 'getElementById("instant-feedback")');
fix('views/edit_quiz.ejs', /alert\("Error during polishing: ' \+ e\.message\);/g, 'alert("Error during polishing: " + e.message);');

let ws = fs.readFileSync('views/worksheet.ejs', 'utf8');
ws = ws.replace(/var postHtml = '[^;]+;/, "var postHtml = '    <script>lucide.createIcons();<\\/script><\\/body><\\/html>';");
fs.writeFileSync('views/worksheet.ejs', ws);

