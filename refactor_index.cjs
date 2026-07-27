const fs = require('fs');

let content = fs.readFileSync('views/index.ejs', 'utf-8');

// Replace standard emojis in buttons with Lucide icons (already mostly done in global, but ensuring)
content = content.replace(/📋 Copy/g, '<i data-lucide="copy" class="icon-sm"></i> Copy');
content = content.replace(/📁 Move/g, '<i data-lucide="folder-output" class="icon-sm"></i> Move');
content = content.replace(/📡 Live/g, '<i data-lucide="radio" class="icon-sm"></i> Live');
content = content.replace(/📊 Results/g, '<i data-lucide="bar-chart-2" class="icon-sm"></i> Results');
content = content.replace(/✏️ Edit/g, '<i data-lucide="edit-3" class="icon-sm"></i> Edit');
content = content.replace(/🗑️ Delete/g, '<i data-lucide="trash-2" class="icon-sm"></i> Delete');

// AI Generator Accordion Structure
// I'll inject CSS for accordions and replace the form contents.
const accordionCss = `
        /* --- Refined AI Generator & Accodions --- */
        .accordion-item { border-bottom: 1px solid var(--hairline); margin-bottom: 8px; }
        .accordion-header { 
            display: flex; justify-content: space-between; align-items: center; 
            padding: 12px 16px; background: var(--surface-elevated); 
            border-radius: var(--radius-sm); cursor: pointer; font-weight: 600; font-size: 14px;
            color: var(--on-dark); transition: background 0.2s;
        }
        .accordion-header:hover { background: var(--surface-soft); }
        .accordion-body { padding: 12px 4px; display: none; }
        .accordion-body.open { display: block; }
        .icon-sm { width: 16px; height: 16px; display: inline-block; vertical-align: middle; margin-right: 6px; }
        
        .quiz-card-horizontal {
            display: flex; justify-content: space-between; align-items: center;
            background: var(--surface-card); padding: 16px 20px;
            border-radius: var(--radius-md); margin-bottom: 12px;
            box-shadow: var(--shadow); transition: transform 0.2s;
        }
        .quiz-card-horizontal:hover { transform: translateY(-2px); }
        .quiz-info { flex-grow: 1; }
        .quiz-actions-menu { position: relative; }
        .quiz-actions-dropdown {
            position: absolute; right: 0; top: 32px; background: var(--surface-elevated);
            border-radius: var(--radius-sm); box-shadow: var(--shadow); display: none;
            z-index: 100; min-width: 150px; overflow: hidden;
        }
        .quiz-actions-dropdown.show { display: block; }
        .quiz-actions-dropdown form, .quiz-actions-dropdown a { display: block; }
        .quiz-actions-dropdown button, .quiz-actions-dropdown a {
            width: 100%; text-align: left; background: none; border: none;
            padding: 10px 16px; color: var(--body-strong); font-size: 13px;
            cursor: pointer; transition: background 0.2s; text-decoration: none;
        }
        .quiz-actions-dropdown button:hover, .quiz-actions-dropdown a:hover {
            background: var(--primary); color: #fff;
        }
        .primary-action-btn {
            background: var(--primary); color: #fff; border: none; padding: 8px 16px;
            border-radius: var(--radius-sm); font-weight: 600; cursor: pointer;
            margin-right: 12px; font-size: 13px; text-decoration: none; display: inline-flex; align-items: center;
        }
        
        /* Stepper for Distribution */
        .stepper-group { display: flex; align-items: center; justify-content: space-between; background: var(--surface-elevated); padding: 4px 8px; border-radius: var(--radius-sm); }
        .stepper-btn { background: none; border: none; color: var(--primary); font-size: 16px; cursor: pointer; padding: 0 4px; font-weight: bold; }
        .stepper-input { width: 30px; text-align: center; background: none; border: none; color: var(--on-dark); font-weight: bold; font-size: 13px; pointer-events: none; }
`;

content = content.replace('</style>', accordionCss + '\n    </style>');

// AI Generator JS for accordions and steppers
const accordionJs = `
    function toggleAccordion(id) {
        document.querySelectorAll('.accordion-body').forEach(el => {
            if(el.id !== id) el.classList.remove('open');
        });
        document.getElementById(id).classList.toggle('open');
    }
    
    function toggleQuizDropdown(id) {
        document.querySelectorAll('.quiz-actions-dropdown').forEach(el => {
            if(el.id !== id) el.classList.remove('show');
        });
        document.getElementById(id).classList.toggle('show');
    }
    
    document.addEventListener('click', function(e) {
        if (!e.target.closest('.quiz-actions-menu')) {
            document.querySelectorAll('.quiz-actions-dropdown').forEach(el => el.classList.remove('show'));
        }
    });

    function stepVal(inputId, delta) {
        const el = document.getElementById(inputId);
        let val = parseInt(el.value) + delta;
        if(val < 0) val = 0;
        el.value = val;
        updateTypeTotal();
    }
`;
content = content.replace('</script>\n</body>', accordionJs + '\n</script>\n</body>');

fs.writeFileSync('views/index.ejs', content);
