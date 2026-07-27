const fs = require('fs');

let content = fs.readFileSync('views/index.ejs', 'utf8');

// Fix `? sq.id : ' %>")"` -> `? sq.id : '' %>')"`
content = content.replace(/ : ' %>"\)"/g, " : '' %>')\"");
content = content.replace(/ : ' %>"\)/g, " : '' %>'\)");

// `toggleQuizDropdown('dropdown-<%= typeof sq.id !== 'undefined' ? sq.id : ' %>")"` -> `toggleQuizDropdown('dropdown-<%= ... ? sq.id : '' %>')"`
content = content.replace(/' %>"\)"/g, "'' %>')\"");

// `copyLink('<%= typeof sq.id !== 'undefined' ? sq.id : '' %>")"` -> `copyLink('<%= ... : '' %>')"`
content = content.replace(/ %>"\)"/g, "%>')\"");

// `document.getElementById('url-<%= typeof sq.id !== 'undefined' ? sq.id : '' %>").innerText`
content = content.replace(/%>"\)\.innerText/g, "%>').innerText");
content = content.replace(/%>"\)\.innerHTML/g, "%>').innerHTML");

fs.writeFileSync('views/index.ejs', content);
