sed -i 's/var postHtml = .*/var postHtml = "    <script>lucide.createIcons();<\\/script><\\/body><\\/html>";/g' views/worksheet.ejs
sed -i 's/quiz_id: "null'\'',/quiz_id: "null",/g' views/view_solutions.ejs
sed -i 's/renderMath('\''instant-feedback");/renderMath("instant-feedback");/g' views/quiz.ejs
sed -i 's/alert('\''Please enter at least a Primary Gemini API Key.");/alert("Please enter at least a Primary Gemini API Key.");/g' views/index.ejs
sed -i 's/btn.innerHTML = '\''REFORMATTING...";/btn.innerHTML = "REFORMATTING...";/g' views/edit_quiz.ejs
