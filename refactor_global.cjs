const fs = require('fs');
const glob = require('glob');

const themeReplacement = `
        /* --- EDUCATIONAL UI THEME --- */
        :root {
            --canvas: #090d16; /* Obsidian Canvas */
            --surface-card: #131927; /* Deep Zinc Cards */
            --surface-elevated: #1c2436;
            --surface-soft: #1e293b;
            --on-dark: #f8fafc;
            --body: #94a3b8;
            --body-strong: #e2e8f0;
            --hairline: rgba(255, 255, 255, 0.05); /* Very subtle borders */
            --primary: #818cf8; /* Refined Indigo */
            --m-blue-light: #6366f1; 
            --m-blue-dark: #4f46e5;
            --m-red: #fb7185; 
            --success: #34d399; 
            --warning: #fbbf24;
            --radius-md: 16px;
            --radius-sm: 8px;
            --shadow: 0 10px 30px -10px rgba(0, 0, 0, 0.5); /* Ambient shadow */
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
    let content = fs.readFileSync(file, 'utf-8');
    
    // Replace theme
    content = content.replace(/\/\* --- EDUCATIONAL UI THEME --- \*\/\s*:root \{[\s\S]*?--shadow:[^;]+;\s*\}/, themeReplacement);
    
    // Add lucide script
    if (!content.includes('lucide@0.263.1')) {
        content = content.replace('</head>', '    <!-- Lucide Icons -->\n    <script src="https://unpkg.com/lucide@0.263.1"></script>\n</head>');
    }
    
    // Add lucide initialization
    if (!content.includes('lucide.createIcons()')) {
        content = content.replace('</body>', '    <script>lucide.createIcons();</script>\n</body>');
    }

    // Replace basic borders in CSS
    content = content.replace(/border: 1px solid var\(--hairline\);/g, 'border: 1px solid var(--hairline);'); // Keep it, but rely on updated var
    content = content.replace(/box-shadow: var\(--shadow\);/g, 'box-shadow: var(--shadow); border: 1px solid var(--hairline);');
    
    // Emojis to Icons (Basic Mapping for Dashboard)
    content = content.replace(/🤖 AI Generator/g, '<i data-lucide="sparkles" style="display:inline-block; vertical-align:middle; margin-right:8px; width:20px;"></i> AI Generator');
    content = content.replace(/🔑 API Key/g, '<i data-lucide="key" style="display:inline-block; vertical-align:middle; margin-right:6px; width:16px;"></i> API Key');
    content = content.replace(/📁 Library/g, '<i data-lucide="library" style="display:inline-block; vertical-align:middle; margin-right:8px; width:20px;"></i> Library');
    content = content.replace(/⚙️ Configure Limits/g, '<i data-lucide="settings" style="display:inline-block; vertical-align:middle; margin-right:6px; width:16px;"></i> Configure Limits');
    content = content.replace(/🚀/g, '<i data-lucide="rocket" style="display:inline-block; vertical-align:middle; margin-right:6px; width:20px;"></i>');
    
    fs.writeFileSync(file, content);
});
