const fs = require('fs');
const glob = require('glob');

const files = glob.sync('views/*.ejs');

files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    
    // Fix class="...'> and style="...'> and value="...'>
    content = content.replace(/(class|style|value|href)="([^"]+)'></g, '$1="$2"><');
    
    // Fix href='/...'
    content = content.replace(/href='([^"]+)"/g, 'href="$1"');

    // Fix onclick="...')" 
    content = content.replace(/onclick="([^"]+)'\)"/g, 'onclick="$1\')"');
    // Fix onclick="something')' (if exists)
    content = content.replace(/onclick="([^"]+)'\)'/g, 'onclick="$1\')"');

    // specifically fix results.ejs issues:
    // onclick="downloadTeacherPDF('<%= ... %>')" style=
    content = content.replace(/onclick="([^"]+)'\)"/g, 'onclick="$1\')"'); 
    
    content = content.replace(/onclick='([^"]+)"/g, 'onclick="$1"');
    content = content.replace(/onclick="([^"]+)'/g, 'onclick="$1"');

    content = content.replace(/type='([^"]+)"/g, 'type="$1"');
    
    // id='total-...'
    content = content.replace(/id='([^"]+)"/g, 'id="$1"');

    // <i data-lucide='x" 
    content = content.replace(/data-lucide='([^"]+)"/g, 'data-lucide="$1"');
    
    // style="...'><i 
    content = content.replace(/style="([^"]+)'><i/g, 'style="$1"><i');

    // class="btn" onclick="...'
    content = content.replace(/onclick="([^"]+)'><i/g, 'onclick="$1"><i');

    fs.writeFileSync(file, content);
});
