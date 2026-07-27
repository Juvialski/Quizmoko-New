const fs = require('fs');

let content = fs.readFileSync('views/results.ejs', 'utf-8');

// The block to replace: <div class="card"> ... <table>
const heroRegex = /<div class="card">\s*<div style="display: flex; justify-content: space-between; align-items: flex-start;">\s*<div>\s*<h1>📊 Results: <%= typeof title !== 'undefined' \? title : '' %><\/h1>\s*<\/div>\s*<div id="bulk-actions-bar" class="bulk-actions">\s*<span id="selection-count" style="font-size: 13px; color: var\(--body\); font-weight: 600;">0 selected<\/span>\s*<button class="btn-delete-bulk" onclick="deleteSelectedResults\(\)">🗑️ DELETE SELECTED<\/button>\s*<\/div>\s*<\/div>\s*<table>/;

const newHero = `
<div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px;">
    <div>
        <h1 style="margin: 0; font-size: 28px;"><i data-lucide="bar-chart-2" style="display:inline-block; vertical-align:middle; width:28px;"></i> Results: <%= typeof title !== 'undefined' ? title : '' %></h1>
    </div>
    <div id="bulk-actions-bar" class="bulk-actions">
        <span id="selection-count" style="font-size: 13px; color: var(--body); font-weight: 600;">0 selected</span>
        <button class="btn-delete-bulk" onclick="deleteSelectedResults()"><i data-lucide="trash-2" class="icon-sm"></i> DELETE</button>
    </div>
</div>

<% 
// Compute Analytics
let classAvg = 0, completionRate = 0, avgTime = 0, hardestQ = "N/A";
if (results && results.length > 0) {
    let totalScore = 0, totalQuestions = 0;
    let completedCount = 0;
    let totalActiveTime = 0;
    let qMisses = {};
    
    results.forEach(r => {
        totalScore += r.score || 0;
        totalQuestions += r.total || 0;
        if (r.completion_note !== "Left without finishing") completedCount++;
        totalActiveTime += r.time_active_seconds || 0;
        
        if (r.details) {
            r.details.forEach((item, idx) => {
                if (!item.is_correct) {
                    qMisses[idx] = (qMisses[idx] || 0) + 1;
                }
            });
        }
    });
    
    if (totalQuestions > 0) classAvg = Math.round((totalScore / totalQuestions) * 100);
    completionRate = Math.round((completedCount / results.length) * 100);
    avgTime = Math.round(totalActiveTime / results.length);
    
    let maxMisses = -1;
    let maxMissIdx = -1;
    for (let idx in qMisses) {
        if (qMisses[idx] > maxMisses) {
            maxMisses = qMisses[idx];
            maxMissIdx = parseInt(idx);
        }
    }
    if (maxMissIdx !== -1) hardestQ = "Q" + (maxMissIdx + 1);
}
%>

<div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px;">
    <div class="card" style="padding: 20px; box-shadow: var(--shadow); border: 1px solid var(--hairline); text-align:center;">
        <div style="font-size: 12px; font-weight: 700; color: var(--body); text-transform: uppercase;">Class Avg</div>
        <div style="font-size: 32px; font-weight: 800; color: var(--primary);"><%= classAvg %>%</div>
    </div>
    <div class="card" style="padding: 20px; box-shadow: var(--shadow); border: 1px solid var(--hairline); text-align:center;">
        <div style="font-size: 12px; font-weight: 700; color: var(--body); text-transform: uppercase;">Completion</div>
        <div style="font-size: 32px; font-weight: 800; color: var(--success);"><%= completionRate %>%</div>
    </div>
    <div class="card" style="padding: 20px; box-shadow: var(--shadow); border: 1px solid var(--hairline); text-align:center;">
        <div style="font-size: 12px; font-weight: 700; color: var(--body); text-transform: uppercase;">Avg Time</div>
        <div style="font-size: 32px; font-weight: 800; color: var(--on-dark);"><%= Math.floor(avgTime/60) %>m <%= avgTime%60 %>s</div>
    </div>
    <div class="card" style="padding: 20px; box-shadow: var(--shadow); border: 1px solid var(--hairline); text-align:center;">
        <div style="font-size: 12px; font-weight: 700; color: var(--body); text-transform: uppercase;">Hardest</div>
        <div style="font-size: 32px; font-weight: 800; color: var(--warning);"><%= hardestQ %></div>
    </div>
</div>

<div class="card">
<table>`;
content = content.replace(heroRegex, newHero);

// Enhanced AI Tutor Feedback Card style injection
const tutorCss = `
        /* Enhanced AI Tutor Feedback */
        .review-block { padding: 16px; border: 1px solid var(--hairline); border-radius: var(--radius-md); margin-bottom: 12px; background: var(--surface-soft); }
        .review-correct { border-left: 4px solid var(--success); }
        .review-wrong { border-left: 4px solid var(--m-red); }
        .ai-feedback-box {
            margin-top: 12px; padding: 16px; background: var(--surface-elevated);
            border-radius: var(--radius-sm); border: 1px solid rgba(99,102,241,0.2);
            font-size: 14px; line-height: 1.5; color: var(--body-strong);
        }
        .ai-feedback-box strong { color: var(--primary); }
`;
content = content.replace('</style>', tutorCss + '\n    </style>');

// Fix the HTML for the feedback box
content = content.replace(/<div style="margin-top: 10px; padding-top: 10px; border-top: 1px dashed var\(--hairline\);">🤖 <%= typeof item\.ai_feedback !== 'undefined' \? item\.ai_feedback : '' %><\/div>/g, 
    '<div class="ai-feedback-box"><i data-lucide="sparkles" class="icon-sm" style="color:var(--primary);"></i> <strong>AI Tutor:</strong><br> <%= typeof item.ai_feedback !== \'undefined\' ? item.ai_feedback : \'\' %></div>');

// Icons in table actions
content = content.replace(/🔍 Mistakes ▼/g, '<i data-lucide="search" class="icon-sm"></i> Mistakes');
content = content.replace(/📥 Solutions PDF/g, '<i data-lucide="download" class="icon-sm"></i> Solutions');
content = content.replace(/🔗 Share Link/g, '<i data-lucide="link" class="icon-sm"></i> Share');

fs.writeFileSync('views/results.ejs', content);
