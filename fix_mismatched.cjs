const fs = require('fs');
const glob = require('glob');

glob.sync('views/*.ejs').forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    
    // Replace attr="val' with attr="val"
    // We can do this generally for any attribute:
    const attrs = ['onclick', 'onchange', 'onsubmit', 'oninput', 'class', 'id', 'href', 'title', 'style', 'name', 'type', 'value', 'placeholder'];
    attrs.forEach(attr => {
        content = content.replace(new RegExp(`${attr}="([^"']*?)'`, 'g'), `${attr}="$1"`);
        content = content.replace(new RegExp(`${attr}='([^"']*?)"`, 'g'), `${attr}="$1"`);
    });

    fs.writeFileSync(file, content);
});
console.log('Fixed mismatched quotes');
