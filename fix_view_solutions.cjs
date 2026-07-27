const fs = require('fs');
let text = fs.readFileSync('views/view_solutions.ejs', 'utf8');
text = text.replace(/quiz_id: "null',/, "quiz_id: 'null',");
fs.writeFileSync('views/view_solutions.ejs', text);
