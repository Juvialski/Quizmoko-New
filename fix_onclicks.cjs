const fs = require('fs');
const glob = require('glob');

const files = glob.sync('views/*.ejs');

files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    
    // We need to carefully replace " inside onclick/onchange attributes
    // Since the browser would see it as invalid, but in the raw string it's just a double quote.
    
    // Fix function("string")
    let changed = true;
    while(changed) {
        let old = content;
        content = content.replace(/(on[a-z]+)="([^"]*?)\"([^\"]+)\"([^"]*?)"/g, '$1="$2\'$3\'$4"');
        changed = old !== content;
    }
    
    fs.writeFileSync(file, content);
});
