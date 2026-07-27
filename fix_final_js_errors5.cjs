const fs = require('fs');

let vs = fs.readFileSync('views/view_solutions.ejs', 'utf8');
vs = vs.replace(/quiz_id: "<%= typeof result\.quiz_id !== 'undefined' \? result\.quiz_id : '' %>"',/g, "quiz_id: '<%= typeof result.quiz_id !== \\'undefined\\' ? result.quiz_id : \\'\\' %>',");
fs.writeFileSync('views/view_solutions.ejs', vs);

