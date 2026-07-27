const fs = require('fs');
const glob = require('glob');

const files = glob.sync('views/*.ejs');

files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    
    // Fix class="something'> to class="something">
    content = content.replace(/class="([^"]+)'></g, 'class="$1"><');
    
    // Fix style="something'> to style="something">
    content = content.replace(/style="([^"]+)'></g, 'style="$1"><');

    // Fix style='something" to style="something" (if happened)
    content = content.replace(/style='([^"]+)"/g, 'style="$1"');
    content = content.replace(/class='([^"]+)"/g, 'class="$1"');

    // Fix something onclick='...' where it should be "..."
    content = content.replace(/onclick='([^']+)"/g, 'onclick="$1"');
    content = content.replace(/onclick="([^"]+)'/g, 'onclick="$1"');

    // Fix other attributes like id='...' to id="..."
    content = content.replace(/id='([^']+)"/g, 'id="$1"');
    content = content.replace(/id="([^"]+)'/g, 'id="$1"');
    
    fs.writeFileSync(file, content);
});
