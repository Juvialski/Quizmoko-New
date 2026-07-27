const fs = require('fs');
const glob = require('glob');

const files = glob.sync('views/*.ejs');

files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');

    // Fix href=...'>
    content = content.replace(/href="([^"]+)'></g, 'href="$1"><');
    content = content.replace(/href='([^"]+)'></g, 'href="$1"><');
    
    // index.ejs:601 
    content = content.replace(/href="(\/results\/[^"]+)'><i/g, 'href="$1"><i');

    // copyLink('<%= ... %>")" -> copyLink('<%= ... %>')"
    content = content.replace(/onclick="([a-zA-Z0-9_]+\('<%= [^%]+ %>'\))"\)"/g, 'onclick="$1"');

    // downloadTeacherPDF('<%= typeof r.id !== 'undefined' ? r.id : '" %>")"
    content = content.replace(/'" %>"\)"/g, '\' %>")"'); // just fix it manually below
    
    // setTool('draw")"
    content = content.replace(/setTool\('([^']+)"\)"/g, 'setTool(\'$1\')"');

    // format is messed up for downloadTeacherPDF inside views/results.ejs
    
    fs.writeFileSync(file, content);
});
