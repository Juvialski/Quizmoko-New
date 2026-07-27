const fs = require('fs');
let content = fs.readFileSync('views/index.ejs', 'utf8');

const regex = /\[data-theme="light"\] \{[\s\S]*?\}\s*\[data-theme="light"\] \{[\s\S]*?\}/;
const newTheme = `[data-theme="light"] {
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

content = content.replace(regex, newTheme);
fs.writeFileSync('views/index.ejs', content);
