const glob = require('glob');
const fs = require('fs');

glob.sync('views/*.ejs').forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    content = content.replace(/!== "undefined'/g, "!== 'undefined'");
    content = content.replace(/!== 'undefined"/g, "!== 'undefined'");
    content = content.replace(/== "undefined'/g, "== 'undefined'");
    
    content = content.replace(/%>'/g, '%>"');
    content = content.replace(/%>\+'/g, '%>+"'); // in case
    
    fs.writeFileSync(file, content);
});
