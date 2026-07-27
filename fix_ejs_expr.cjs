const fs = require('fs');
const glob = require('glob');

glob.sync('views/*.ejs').forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    
    // We want to fix quotes inside <% %> and <%= %>
    // Replace "undefined' with 'undefined'
    // Replace 'undefined" with 'undefined'
    content = content.replace(/"undefined'/g, "'undefined'");
    content = content.replace(/'undefined"/g, "'undefined'");
    content = content.replace(/"undefined"/g, "'undefined'");

    fs.writeFileSync(file, content);
});
console.log('Fixed undefined quotes');
