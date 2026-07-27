const fs = require('fs');
const files = require('glob').sync('views/*.ejs');
files.forEach(file => {
    const text = fs.readFileSync(file, 'utf8');
    const scripts = [...text.matchAll(/<script(?! src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    scripts.forEach((s, idx) => {
        let clean = s.replace(/<%[\s\S]*?%>/g, '');
        try {
            new (require('vm').Script)(clean);
        } catch(e) {
            console.log(`\n--- ${file} script ${idx} ---`);
            console.log(e.stack.split('\n').slice(0, 5).join('\n'));
        }
    });
});
