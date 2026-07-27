const fs = require('fs');
const glob = require('glob');

glob.sync('views/*.ejs').forEach(file => {
    let content = fs.readFileSync(file, 'utf8');

    // Fix %>"; to %>';
    content = content.replace(/%>";/g, "%>';");
    
    // Fix `/quiz/";` to `/quiz/';`
    content = content.replace(/\/quiz\/";/g, "/quiz/';");
    
    // Fix `getElementById('url-")`
    content = content.replace(/getElementById\('url-"\)/g, "getElementById('url-')");
    
    // Fix `getElementById('active-")`
    content = content.replace(/getElementById\('active-"\)/g, "getElementById('active-')");
    
    // Fix `<%- JSON.stringify(results) %>";` just in case
    // wait, we don't have that.

    fs.writeFileSync(file, content);
});

