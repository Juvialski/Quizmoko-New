const fs = require('fs');
const glob = require('glob');

const files = glob.sync('views/*.ejs');

const simpleAttrs = ['class', 'id', 'href', 'style', 'name', 'type', 'placeholder', 'value', 'for', 'data-lucide', 'src', 'rel', 'title', 'method', 'action'];

files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    
    // 1. Fix mixed quotes for simple attributes: attr="val' or attr='val"
    simpleAttrs.forEach(attr => {
        const regex = new RegExp(`\\b${attr}=["']([^"'>]+)["']`, 'g');
        content = content.replace(regex, `${attr}="$1"`);
    });
    
    // 2. Fix onclick/onchange/onsubmit with nested single quotes
    // For example: onclick='func('val')' -> onclick="func('val')"
    // We'll use a regex that matches onxxxx=' ... ' and assumes everything until the next space or > is part of it.
    // Actually, a better way is to find onxxxx= followed by something.
    const eventAttrs = ['onclick', 'onchange', 'onsubmit', 'oninput', 'onload'];
    eventAttrs.forEach(attr => {
        // match attr='func('str')'
        const regex1 = new RegExp(`\\b${attr}='([a-zA-Z0-9_]+)\\(\\'([^\\']+)\\'\\)'`, 'g');
        content = content.replace(regex1, `${attr}="$1('$2')"`);
        
        // match attr='func("str")'
        const regex2 = new RegExp(`\\b${attr}='([a-zA-Z0-9_]+)\\(\\"([^\\"]+)\\"\\)'`, 'g');
        content = content.replace(regex2, `${attr}="$1('$2')"`);
        
        // match attr="func("str")"
        const regex3 = new RegExp(`\\b${attr}="([a-zA-Z0-9_]+)\\(\\"([^\\"]+)\\"\\)"`, 'g');
        content = content.replace(regex3, `${attr}="$1('$2')"`);

        // match attr="func('str')" - this is ALREADY correct, but let's make sure.
    });
    
    // 3. Fix missing closing quotes on class/id/href (e.g. class="mode-tab active>)
    // Wait, let's just make sure all class="..." are double quoted.

    fs.writeFileSync(file, content);
});

console.log("Quotes fixed!");
