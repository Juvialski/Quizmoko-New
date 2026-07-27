const fs = require('fs');
const glob = require('glob');

const files = glob.sync('views/*.ejs');

files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    
    // Fix innerText with double quotes around HTML
    content = content.replace(/innerText = "(<i data-lucide=[^>]+><\/i>.*?)"/g, function(match, p1) {
        // p1 contains the HTML string which might have " inside it.
        // We replace the outer " with ' and change innerText to innerHTML
        return "innerHTML = '" + p1 + "'";
    });
    
    content = content.replace(/innerText = \`(<i data-lucide=[^>]+><\/i>.*?)\`/g, "innerHTML = `$1`");

    // Fix placeholders
    content = content.replace(/placeholder="<i data-lucide=[^>]+><\/i> /g, 'placeholder="');

    fs.writeFileSync(file, content);
});
