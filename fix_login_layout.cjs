const fs = require('fs');

function updateAuthPage(file) {
    let content = fs.readFileSync(file, 'utf8');
    
    // Add centering to login page body or container
    content = content.replace(/body\s*\{[\s\S]*?\}(?=(?:\s*\.|\s*#|\s*<\/style>|\s*\w+\s*\{))/i, `body { 
            font-family: 'Inter', sans-serif; 
            margin: 0; 
            padding: 40px 20px; 
            color: var(--body-strong); 
            background-color: var(--canvas);
            font-weight: 400;
            display: flex; justify-content: center; align-items: center; min-height: 100vh;
            transition: background-color 0.3s ease, color 0.3s ease;
        }`);
    
    fs.writeFileSync(file, content);
}

updateAuthPage('views/login.ejs');
updateAuthPage('views/register.ejs');
