const fs = require('fs');
const glob = require('glob');

const newTheme = `:root {
            --canvas: #090d16;
            --surface-card: #131927;
            --surface-elevated: #1c2436;
            --surface-soft: #1e293b;
            --on-dark: #f8fafc;
            --body: #94a3b8;
            --body-strong: #e2e8f0;
            --hairline: rgba(255, 255, 255, 0.05);
            --primary: #818cf8;
            --m-blue-light: #6366f1;
            --m-blue-dark: #4f46e5;
            --m-red: #fb7185;
            --success: #34d399;
            --warning: #fbbf24;
            --radius-md: 16px;
            --radius-sm: 8px;
            --shadow: 0 10px 30px -10px rgba(0, 0, 0, 0.5);
        }
        
        [data-theme="light"] {
            --canvas: #fafafa;
            --surface-card: #ffffff;
            --surface-elevated: #f4f4f5;
            --surface-soft: #f4f4f5;
            --on-dark: #0f172a;
            --body: #52525b;
            --body-strong: #18181b;
            --hairline: rgba(0, 0, 0, 0.05);
            --primary: #6366f1;
            --m-blue-light: #4f46e5;
            --m-blue-dark: #4338ca;
            --m-red: #e11d48;
            --success: #10b981;
            --shadow: 0 10px 30px -10px rgba(0, 0, 0, 0.05);
        }`;

const files = glob.sync('views/*.ejs');

files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    // Replace old :root and data-theme=light
    const regex = /:root\s*\{[\s\S]*?\}(?:\s*\[data-theme="light"\]\s*\{[\s\S]*?\})*(?:\s*\[data-theme="light"\]\s*\{[\s\S]*?\})*/;
    
    // Some files might not have [data-theme="light"], just :root
    content = content.replace(regex, newTheme);
    fs.writeFileSync(file, content);
});
