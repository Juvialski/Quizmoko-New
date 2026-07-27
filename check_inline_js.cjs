const fs = require('fs');
const glob = require('glob');
const cp = require('child_process');

let ok = true;
glob.sync('views/*.ejs').forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    // Extract everything between <script> and </script>
    let scripts = content.match(/<script(?! src)[^>]*>([\s\S]*?)<\/script>/g);
    if (!scripts) return;
    
    scripts.forEach((s, idx) => {
        let code = s.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
        // Replace EJS tags with valid JS placeholders
        code = code.replace(/<%=.*?%>/g, '"EJS_VAL"');
        code = code.replace(/<%-.*?%>/g, '"EJS_RAW"');
        // If there's an if statement, just remove it or comment it out for basic syntax check
        // Actually, replacing <% ... %> is hard. Let's just strip them and see if it compiles roughly.
        // Even better, just run it through node syntax check (if no complex EJS flow control).
        fs.writeFileSync('temp.js', code);
        try {
            cp.execSync('node -c temp.js', {stdio: 'ignore'});
        } catch (e) {
            // EJS flow control might cause valid JS to fail, but let's see.
            console.log(`Potential syntax error in inline script of ${file} (script #${idx + 1})`);
        }
    });
});
console.log("Inline check done!");
