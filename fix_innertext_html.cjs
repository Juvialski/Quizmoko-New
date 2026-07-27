const fs = require('fs');
const glob = require('glob');

const files = glob.sync('views/*.ejs');

files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    
    content = content.replace(/\.innerText = ('<i data-lucide=[^>]+><\/i>.*?')/g, '.innerHTML = $1');

    fs.writeFileSync(file, content);
});
