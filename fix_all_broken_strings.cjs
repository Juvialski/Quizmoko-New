const fs = require('fs');
const glob = require('glob');

const files = glob.sync('views/*.ejs');

files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    
    // We want to replace "<i data-lucide="something" class="icon-sm"></i> ..." with '<i data-lucide="something" class="icon-sm"></i> ...'
    // This happens when there is a string in JS:  "<i data-lucide="
    
    content = content.replace(/"(<i data-lucide="[^"]+" class="icon-sm"><\/i>[^"]*)"/g, function(match, p1) {
        return "'" + p1 + "'";
    });

    content = content.replace(/"([^"]*<i data-lucide="[^"]+" class="icon-sm"><\/i>[^"]*)"/g, function(match, p1) {
        return "'" + p1 + "'";
    });
    
    fs.writeFileSync(file, content);
});
