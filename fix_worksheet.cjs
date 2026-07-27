const fs = require('fs');
let ws = fs.readFileSync('views/worksheet.ejs', 'utf8');
ws = ws.replace(/var postHtml = .*/, "var postHtml = '    <script>lucide.createIcons();<\\/script><\\/body><\\/html>';");
fs.writeFileSync('views/worksheet.ejs', ws);
