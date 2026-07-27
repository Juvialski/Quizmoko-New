const fs = require('fs');
const glob = require('glob');

const files = glob.sync('views/*.ejs');

files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    
    content = content.replace(/innerHTML = "(<i data-lucide=[^>]+><\/i>.*?)"/g, function(match, p1) {
        return "innerHTML = '" + p1 + "'";
    });

    fs.writeFileSync(file, content);
});
