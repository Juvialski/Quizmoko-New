const fs = require('fs');
const glob = require('glob');
const { execSync } = require('child_process');

// results.ejs fix
let results = fs.readFileSync('views/results.ejs', 'utf8');
results = results.replace(/r\.id : ' %>"\)"/g, "r.id : '' %>')\"");
fs.writeFileSync('views/results.ejs', results);

// worksheet.ejs
let ws = fs.readFileSync('views/worksheet.ejs', 'utf8');
ws = ws.replace(/postHtml = "/g, "postHtml = '"); // Let's just fix it by printing it out to see
fs.writeFileSync('views/worksheet.ejs', ws);

const files = glob.sync('views/*.ejs');

files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    let scripts = [];
    let regex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = regex.exec(content)) !== null) {
        if (match[1].trim()) scripts.push(match[1]);
    }
    
    scripts.forEach((script, idx) => {
        let cleanScript = script.replace(/<%[\s\S]*?%>/g, 'null');
        fs.writeFileSync('temp.js', cleanScript);
        try {
            execSync('node -c temp.js', { stdio: 'pipe' });
        } catch (err) {
            console.error(`Syntax error in inline script of ${file} (script #${idx + 1}):`);
            console.error(err.stderr.toString());
        }
    });
});
