const fs = require('fs');
const glob = require('glob');

const eventAttrs = ['onclick', 'onchange', 'onsubmit', 'oninput'];

glob.sync('views/*.ejs').forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    
    // We want to find pattern like onclick='...something...'
    // Since it's currently broken, it looks exactly like: onclick='stepVal('mc_count', -1)'
    // Let's replace any onclick='...' with onclick="..."
    // The challenge is finding the correct closing '. It's usually followed by > or space.
    
    eventAttrs.forEach(attr => {
        // match: attr='func('str', num)'
        // we can look for attr=' followed by anything that isn't > and ends with ' (before > or space)
        content = content.replace(new RegExp(`${attr}='([^>]+?)'(?=>|\\s)`, 'g'), (match, p1) => {
            return `${attr}="${p1}"`;
        });
    });

    fs.writeFileSync(file, content);
});
console.log('Fixed event quotes');
