const fs = require('fs');
const glob = require('glob');

const files = glob.sync('views/*.ejs');

files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    
    // Replace <i ...> inside alert(`...`)
    content = content.replace(/alert\(`(<i data-lucide=[^>]+><\/i>[^`]*)(.*?)`\)/g, function(match, p1) {
        // Strip out the <i> tag
        const clean = match.replace(/<i data-lucide=[^>]+><\/i>️?\s*/g, '');
        return clean;
    });

    fs.writeFileSync(file, content);
});
