const fs = require('fs');
const glob = require('glob');

function fix(file, from, to) {
    let content = fs.readFileSync(file, 'utf8');
    content = content.replace(from, to);
    fs.writeFileSync(file, content);
}

fix('views/worksheet_upload.ejs', /'gemini-3.6-flash": 20/g, '"gemini-3.6-flash": 20');
fix('views/worksheet_answers_upload.ejs', /'gemini-3.6-flash": 20/g, '"gemini-3.6-flash": 20');

// worksheet.ejs: `var postHtml = " ... ` wait, let's just find the line in worksheet.ejs
let ws = fs.readFileSync('views/worksheet.ejs', 'utf8');
ws = ws.replace(/postHtml = "    <script>lucide\.createIcons\(\);(.*?)"/g, "postHtml = '    <script>lucide.createIcons();$1'"); // or something. Let's just fix it via sed later if needed.
// Actually let's just see worksheet.ejs manually

fix('views/view_solutions.ejs', /quiz_id: "([^']+)',/g, "quiz_id: '$1',");
fix('views/rmxflash_upload.ejs', /const sessionId = 'rmx_"/g, 'const sessionId = "rmx_"');
fix('views/results.ejs', /btn\.innerText = "GENERATING...';/g, 'btn.innerText = "GENERATING...";');
fix('views/quiz.ejs', /btnPrev\.innerText = "([^']+)';/g, 'btnPrev.innerText = "$1";');
fix('views/live.ejs', /\|\| "';/g, '|| "";');
fix('views/index.ejs', /btn\.innerText = "Scanning...';/g, 'btn.innerText = "Scanning...";');
fix('views/edit_quiz.ejs', /return '";/g, 'return "";');

