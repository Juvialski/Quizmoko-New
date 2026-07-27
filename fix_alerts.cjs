const fs = require('fs');
const glob = require('glob');

const files = glob.sync('views/*.ejs');

files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    
    content = content.replace(/alert\("(<i data-lucide=[^>]+><\/i>\s*)(.*?)"\)/g, 'alert("$2")');

    fs.writeFileSync(file, content);
});
