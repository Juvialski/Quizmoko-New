const fs = require('fs');
const glob = require('glob');

const files = glob.sync('views/*.ejs');

files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    
    // Fix class="something'> or class="something'
    // Specifically looking for any attribute that starts with " and ends with ' before a space or >
    content = content.replace(/([a-zA-Z\-]+)="([^"]*)'/g, '$1="$2"');
    
    // Just in case we also have attribute='something"
    content = content.replace(/([a-zA-Z\-]+)='([^']*)"/g, '$1="$2"');
    
    fs.writeFileSync(file, content);
});
