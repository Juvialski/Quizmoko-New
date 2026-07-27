const fs = require('fs');
let content = fs.readFileSync('views/view_solutions.ejs', 'utf8');
content = content.replace(/ quiz_id: '<%= typeof result\.quiz_id !== 'undefined' \? result\.quiz_id : '' %>",/g, " quiz_id: '<%= typeof result.quiz_id !== 'undefined' ? result.quiz_id : '' %>',");
fs.writeFileSync('views/view_solutions.ejs', content);
