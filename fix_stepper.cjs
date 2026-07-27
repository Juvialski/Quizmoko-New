const fs = require('fs');
let content = fs.readFileSync('views/index.ejs', 'utf-8');

const oldCss = `.stepper-group { display: flex; align-items: center; justify-content: space-between; background: var(--surface-elevated); padding: 4px 8px; border-radius: var(--radius-sm); }
        .stepper-btn { background: none; border: none; color: var(--primary); font-size: 16px; cursor: pointer; padding: 0 4px; font-weight: bold; }
        .stepper-input { width: 30px; text-align: center; background: none; border: none; color: var(--on-dark); font-weight: bold; font-size: 13px; pointer-events: none; }`;

const newCss = `.stepper-group { display: flex; flex-direction: column; align-items: center; justify-content: center; background: var(--surface-elevated); padding: 8px 4px; border-radius: var(--radius-sm); gap: 4px; }
        .stepper-group > div { display: flex; align-items: center; justify-content: center; }
        .stepper-btn { background: none; border: none; color: var(--primary); font-size: 16px; cursor: pointer; padding: 0 6px; font-weight: bold; }
        .stepper-input { width: 32px; padding: 0 !important; text-align: center; background: transparent !important; border: none !important; color: var(--on-dark) !important; font-weight: bold; font-size: 14px !important; pointer-events: none; box-shadow: none !important; -moz-appearance: textfield; }
        .stepper-input::-webkit-outer-spin-button, .stepper-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }`;

content = content.replace(oldCss, newCss);

fs.writeFileSync('views/index.ejs', content);
