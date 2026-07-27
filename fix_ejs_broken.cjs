const fs = require('fs');
const glob = require('glob');

const files = glob.sync('views/*.ejs');

files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');

    // Fix `? sq.id : '" %>"` -> `? sq.id : '' %>"`
    // Actually the quote is messed up inside <%= ... %>
    content = content.replace(/ : '" %>/g, " : '' %>");
    
    // index.ejs 602: form action='/delete/<%= typeof sq.id !== 'undefined' ? sq.id : '' %>"
    content = content.replace(/action='(\/delete\/<%=[^%]+%>)"/g, "action=\"$1\"");
    
    content = content.replace(/onclick="([^"]+)'\)"/g, 'onclick="$1\')"');

    // And quiz.ejs 
    content = content.replace(/setTool\('([^']+)"\)"/g, "setTool('$1')\"");

    fs.writeFileSync(file, content);
});
