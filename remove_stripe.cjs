const fs = require('fs');
const glob = require('glob');

const files = glob.sync('views/*.ejs');
files.forEach(file => {
    let content = fs.readFileSync(file, 'utf-8');
    content = content.replace(/<div class="m-stripe-divider".*?><\/div>/g, '');
    fs.writeFileSync(file, content);
});
