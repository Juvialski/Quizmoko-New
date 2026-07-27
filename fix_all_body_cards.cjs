const fs = require('fs');
const glob = require('glob');

const files = glob.sync('views/*.ejs');

files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    
    // Replace old body CSS
    content = content.replace(/body\s*\{[\s\S]*?\}(?=(?:\s*\.|\s*#|\s*<\/style>|\s*\w+\s*\{))/i, `body { 
            font-family: 'Inter', sans-serif; 
            margin: 0; 
            padding: 40px 20px; 
            color: var(--body-strong); 
            background-color: var(--canvas);
            font-weight: 400;
            transition: background-color 0.3s ease, color 0.3s ease;
        }`);

    // If it has .container, standardize it to the main page container max-width or just keep it
    content = content.replace(/\.container\s*\{[^}]+\}/, `.container { max-width: 1440px; margin: auto; }`);
    
    fs.writeFileSync(file, content);
});
