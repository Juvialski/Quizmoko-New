const fs = require('fs');
function fix(file, from, to) {
    let content = fs.readFileSync(file, 'utf8');
    content = content.replace(from, to);
    fs.writeFileSync(file, content);
}

fix('views/worksheet_upload.ejs', /"Failed to fetch usage stats:',/g, '"Failed to fetch usage stats:",');
fix('views/worksheet_answers_upload.ejs', /"ws_ans_'/g, '"ws_ans_"');
fix('views/view_solutions.ejs', /quiz_id: "null',/g, "quiz_id: 'null',");
fix('views/quiz.ejs', /'NEXT \/ CONFIRM <i data-lucide="arrow-right" class="icon-sm"><\/i>️";/g, "'NEXT / CONFIRM <i data-lucide=\"arrow-right\" class=\"icon-sm\"></i>️';");
fix('views/index.ejs', /'optgroup\[label="Local Models \(Ollama\)'\]'\)/g, "'optgroup[label=\"Local Models (Ollama)\"]')");
fix('views/edit_quiz.ejs', /btn\.innerHTML = "⌛...';/g, 'btn.innerHTML = "⌛...";');

let ws = fs.readFileSync('views/worksheet.ejs', 'utf8');
ws = ws.replace(/var postHtml = '    <script>lucide\.createIcons\(\);\s*<\/script>\s*<\/body>\s*<\/html>"/, "var postHtml = '    <script>lucide.createIcons();</script></body></html>';");
fs.writeFileSync('views/worksheet.ejs', ws);
