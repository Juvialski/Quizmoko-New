const fs = require('fs');
let content = fs.readFileSync('views/edit_quiz.ejs', 'utf-8');

// Replace standard emojis with Lucide icons in the header buttons
content = content.replace(/🔄 Shuffle Questions/g, '<i data-lucide="shuffle" class="icon-sm"></i> Shuffle Questions');
content = content.replace(/🔀 Shuffle Choices \(MC Only\)/g, '<i data-lucide="shuffle" class="icon-sm"></i> Shuffle Choices');
content = content.replace(/✨ Polish Math \(AI\)/g, '<i data-lucide="wand-2" class="icon-sm"></i> Polish Math');
content = content.replace(/🔍 Re-Check Answers/g, '<i data-lucide="check-circle" class="icon-sm"></i> Re-Check');
content = content.replace(/💾 Save All Changes/g, '<i data-lucide="save" class="icon-sm"></i> Save Changes');
content = content.replace(/📄 Export to Word \/ PDF/g, '<i data-lucide="file-down" class="icon-sm"></i> Export');
content = content.replace(/🗑️ DISCARD QUIZ/g, '<i data-lucide="trash-2" class="icon-sm"></i> Discard');
content = content.replace(/🛡️ VIEW REFERENCE/g, '<i data-lucide="shield" class="icon-sm"></i> Reference');
content = content.replace(/🔙 Back to Dashboard/g, '<i data-lucide="arrow-left" class="icon-sm"></i> Back');
content = content.replace(/➕ GENERATE NEW QUESTION HERE/g, '<i data-lucide="plus-circle" class="icon-sm"></i> Generate Question');

// Replace Question Block icons in renderQuestions JS
content = content.replace(/💾 SAVE QUESTION/g, '💾 Save');
content = content.replace(/💡 RE-SOLVE/g, '💡 Re-solve');
content = content.replace(/✨ POLISH MATH/g, '✨ Polish');
content = content.replace(/🔄 REGENERATE/g, '🔄 Regenerate');
content = content.replace(/🗑️ REMOVE/g, '🗑️ Remove');

// Consolidate Action Toolbar 
const oldActionRow = /<div style="display: flex; gap: 8px;">[\s\S]*?<\/div>\s*<\/div>\s*<div style="display: grid;/;
const newActionRow = `
<div style="display: flex; gap: 8px; flex-wrap: wrap;">
    <button class="btn btn-secondary" onclick="openImportModal()" style="background: var(--primary); color: white; border: none; font-size: 13px;"><i data-lucide="download" class="icon-sm"></i> Import Qs</button>
    <button class="btn btn-secondary" onclick="shuffleQuestions()" style="font-size: 13px;"><i data-lucide="shuffle" class="icon-sm"></i> Shuffle Qs</button>
    <button class="btn btn-secondary" onclick="shuffleChoices()" style="font-size: 13px;"><i data-lucide="shuffle" class="icon-sm"></i> Shuffle Choices</button>
    <button class="btn btn-secondary" onclick="manualPolish()" id="manual-polish-btn" style="font-size: 13px;"><i data-lucide="wand-2" class="icon-sm"></i> Polish Math</button>
    <button class="btn btn-secondary" onclick="recheckAllAnswers()" id="recheck-ans-btn" style="font-size: 13px; border-color: var(--warning); color: var(--warning); background: transparent;"><i data-lucide="check-circle" class="icon-sm"></i> Re-Check</button>
</div>
</div>
<div style="display: grid;
`;
content = content.replace(oldActionRow, newActionRow);

// Redesign right column (Live Preview)
// Looking at the CSS, let's inject a beautiful style for the live preview container.
const previewCss = `
        /* Live Preview Styling */
        .live-preview-box {
            background: var(--surface-card); border: 1px solid var(--hairline);
            border-radius: var(--radius-md); padding: 24px; box-shadow: var(--shadow);
            position: sticky; top: 20px; font-size: 18px; color: var(--on-dark);
        }
        .live-preview-box .option-btn {
            background: var(--surface-elevated); color: var(--on-dark);
            border: 1px solid var(--hairline); padding: 12px 16px; margin-bottom: 8px;
            border-radius: var(--radius-md); text-align: left;
            display: flex; align-items: center; pointer-events: none;
        }
        .live-preview-box .option-key {
            display: flex; align-items: center; justify-content: center;
            width: 28px; height: 28px; border-radius: 50%;
            background: var(--surface-soft); color: var(--body);
            font-weight: 700; margin-right: 12px; font-size: 13px;
        }
        .live-preview-box .option-btn.correct {
            background: rgba(52,211,153,0.1); border-color: var(--success);
        }
        .live-preview-box .option-btn.correct .option-key {
            background: var(--success); color: white;
        }
`;
content = content.replace('</style>', previewCss + '\n    </style>');

// Modify javascript right column rendering if possible.
// The JS renders it to 'rightCol'. We can replace `rightCol.innerHTML = ...`
const oldRightColHtml = /rightCol\.innerHTML = `\s*<label style="color:var\(--primary\);">LIVE PREVIEW \(Student View\)<\\/label>[\s\S]*?`;/g;

// To do a safer replace, we can replace just the header of the right col.
content = content.replace(/<label style="color:var\(--primary\);">LIVE PREVIEW \(Student View\)<\/label>[\s\S]*?<div id="preview-\$\{qIndex\}"/g, 
    `<div class="live-preview-box">
        <label style="color:var(--primary); font-size:11px; margin-bottom:16px; display:block;"><i data-lucide="eye" class="icon-sm"></i> LIVE PREVIEW (Student View)</label>
        <div id="preview-\${qIndex}"`);

// Replace the end of the div
content = content.replace(/<\/div>\s*`;/g, '</div></div>`;');


fs.writeFileSync('views/edit_quiz.ejs', content);
