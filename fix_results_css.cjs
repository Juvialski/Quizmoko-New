const fs = require('fs');

let content = fs.readFileSync('views/results.ejs', 'utf8');

// Update toggle-btn
content = content.replace(/\.toggle-btn\s*\{[^}]+\}/, `.toggle-btn { background: var(--surface-elevated); border: 1px solid var(--hairline); color: var(--on-dark); padding: 8px 16px; border-radius: var(--radius-sm); cursor: pointer; font-weight: 600; font-size: 13px; transition: 0.2s; display: inline-flex; align-items: center; justify-content: center; gap: 6px;}`);
content = content.replace(/\.toggle-btn:hover\s*\{[^}]+\}/, `.toggle-btn:hover { border-color: var(--primary); color: var(--primary); }`);

// Update btn-delete-bulk
content = content.replace(/\.btn-delete-bulk\s*\{[^}]+\}/, `.btn-delete-bulk { background: var(--surface-elevated); color: var(--m-red); border: 1px solid var(--m-red); padding: 8px 16px; border-radius: var(--radius-sm); font-weight: 700; cursor: pointer; transition: 0.2s; font-size: 13px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; }`);
content = content.replace(/\.btn-delete-bulk:hover\s*\{[^}]+\}/, `.btn-delete-bulk:hover { background: var(--m-red); color: white; opacity: 0.9; transform: translateY(-1px); }`);

fs.writeFileSync('views/results.ejs', content);
