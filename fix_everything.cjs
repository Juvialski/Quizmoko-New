const fs = require('fs');
function fix(file, from, to) {
    let content = fs.readFileSync(file, 'utf8');
    content = content.replace(from, to);
    fs.writeFileSync(file, content);
}

fix('views/worksheet_upload.ejs', /alert\('Solving timed out. Please check your internet connection and dashboard to see if the quiz was created."\);/g, 'alert("Solving timed out. Please check your internet connection and dashboard to see if the quiz was created.");');

fix('views/view_solutions.ejs', /quiz_id: "null',/g, "quiz_id: 'null',");

fix('views/quiz.ejs', /result\.correct_answer === 'Grading Error"/g, 'result.correct_answer === "Grading Error"');

fix('views/index.ejs', /btn\.style\.color = "#fff';/g, 'btn.style.color = "#fff";');

fix('views/edit_quiz.ejs', /alert\("No API keys with remaining quota found today.'\);/g, 'alert("No API keys with remaining quota found today.");');

let ws = fs.readFileSync('views/worksheet.ejs', 'utf8');
ws = ws.replace(/var postHtml = '[^;]+;;/, "var postHtml = '    <script>lucide.createIcons();<\\/script><\\/body><\\/html>';");
fs.writeFileSync('views/worksheet.ejs', ws);

