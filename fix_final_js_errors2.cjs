const fs = require('fs');

function fix(file, regex, replacement) {
    let content = fs.readFileSync(file, 'utf8');
    content = content.replace(regex, replacement);
    fs.writeFileSync(file, content);
}

fix('views/worksheet_upload.ejs', /q\.answer \|\| '"\)\.toLowerCase\(\)/g, 'q.answer || "").toLowerCase()');
fix('views/worksheet_answers_upload.ejs', /"gen_ans_' \+/g, '"gen_ans_" +');

let ws = fs.readFileSync('views/worksheet.ejs', 'utf8');
ws = ws.replace(/var postHtml = '[ \t]*<script>lucide\.createIcons\(\);(.*?)"/g, "var postHtml = '    <script>lucide.createIcons();$1'"); // or something.
// Just replace it to an empty string if we can't figure it out, but wait, let's look for "postHtml" in worksheet.ejs
// Let's do it manually via a global string search
let postHtmlMatch = ws.match(/var postHtml = [^;]+;/);
if (postHtmlMatch) {
    ws = ws.replace(postHtmlMatch[0], "var postHtml = '    <script>lucide.createIcons();<\\/script><\\/body><\\/html>';");
}
fs.writeFileSync('views/worksheet.ejs', ws);

fix('views/view_solutions.ejs', /quiz_id: "null',/g, "quiz_id: 'null',");
fix('views/quiz.ejs', /retryBtn\.style\.display = 'none";/g, "retryBtn.style.display = 'none';");
fix('views/index.ejs', /let buffer = "';/g, 'let buffer = "";');
fix('views/edit_quiz.ejs', /hiddenImage \? '\\n" \+ hiddenImage : ""\)/g, 'hiddenImage ? "\\n" + hiddenImage : "")');

