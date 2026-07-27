const fs = require('fs');
const glob = require('glob');

glob.sync('views/*.ejs').forEach(file => {
    let content = fs.readFileSync(file, 'utf8');

    // Fix `quiz_id: '<%= quiz.id %>",` to `quiz_id: '<%= quiz.id %>',`
    content = content.replace(/quiz_id: '<%= quiz\.id %>",/g, "quiz_id: '<%= quiz.id %>',");

    // Fix `alert('Link copied to clipboard!");` to `alert('Link copied to clipboard!');`
    content = content.replace(/alert\('Link copied to clipboard!"\);/g, "alert('Link copied to clipboard!');");

    // Fix `document.getElementById('url-<%= ... %>").innerText` to `document.getElementById('url-<%= ... %>').innerText`
    content = content.replace(/%>"\)\.innerText/g, "%>').innerText");
    
    // Check if there are other `%>")` that should be `%>')`
    content = content.replace(/%>"\)/g, "%>')");
    
    fs.writeFileSync(file, content);
});

