const fs = require('fs');
const glob = require('glob');

const buttonCss = `
        /* Unified Buttons */
        .btn-primary { background: var(--primary); color: #ffffff; border: none; cursor: pointer; width: 100%; padding: 14px; font-size: 15px; border-radius: var(--radius-sm); font-weight: 600; margin-top: 12px; transition: 0.2s; box-shadow: 0 2px 4px rgba(0,0,0,0.1); display: flex; align-items: center; justify-content: center; gap: 8px;}
        .btn-primary:hover { opacity: 0.9; transform: translateY(-1px); }
        .btn-primary:disabled { background: var(--hairline); color: var(--body); cursor: not-allowed; transform: none; box-shadow: none;}
        
        .btn-secondary { background: var(--surface-elevated); color: var(--on-dark); border: 1px solid var(--hairline); border-radius: var(--radius-sm); padding: 8px 16px; font-size: 13px; font-weight: 600; cursor: pointer; transition: 0.2s; display: inline-flex; align-items: center; justify-content: center; gap: 6px;}
        .btn-secondary:hover { border-color: var(--primary); color: var(--primary);}
        
        .btn { padding: 10px 20px; border: 1px solid var(--hairline); border-radius: var(--radius-sm); cursor: pointer; font-weight: 600; transition: 0.2s; background: var(--surface-elevated); color: var(--on-dark); display: inline-flex; align-items: center; justify-content: center; gap: 6px;}
        .btn:hover { border-color: var(--primary); color: var(--primary); }
`;

const inputCss = `
        /* Unified Inputs */
        input[type="text"], input[type="number"], input[type="password"], input[type="email"], textarea, select { 
            width: 100%; padding: 12px; border: 1px solid var(--hairline); border-radius: var(--radius-sm); box-sizing: border-box; font-family: inherit; font-size: 14px; background: var(--surface-soft); color: var(--on-dark); transition: all 0.2s ease;
        }
        input:focus, textarea:focus, select:focus { border-color: var(--primary); background: var(--canvas); outline: none; box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.2);}
        textarea { height: 60px; resize: vertical; } 
        label { font-weight: 600; display: block; margin-top: 15px; margin-bottom: 6px; font-size: 13px; color: var(--body-strong); }
`;

const files = glob.sync('views/*.ejs');

files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    
    // Attempt to inject or replace
    // This is hard to do cleanly via regex across random files, but we can try to just append it to the end of the <style> block so it overrides previous definitions.
    if (content.includes('</style>')) {
        content = content.replace('</style>', `
        ${buttonCss}
        ${inputCss}
    </style>`);
    }

    fs.writeFileSync(file, content);
});
