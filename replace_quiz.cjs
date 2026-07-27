const fs = require('fs');
let content = fs.readFileSync('views/quiz.ejs', 'utf-8');

// Replace quiz top bar
const oldTopBar = /<div class="top-bar">[\s\S]*?<\/div>\s*<\/div>/;
const newTopBar = `
<div class="top-bar" style="display:flex; justify-content:space-between; align-items:center; padding: 12px 24px; background: var(--surface-card); border-bottom: 1px solid var(--hairline);">
    <div class="header-left" style="display:flex; align-items:center; gap: 16px;">
        <span style="font-weight: 800; display:flex; align-items:center; gap:8px;">
            <i data-lucide="rocket" class="icon-sm"></i> QUIZMOKO
        </span>
        <div id="connection-dot" style="width:8px; height:8px; border-radius:50%; background:var(--success);" title="Online"></div>
        <span id="q-tracker" style="display:none; background:var(--surface-elevated); padding: 6px 12px; border-radius: var(--radius-sm); font-size:13px; font-weight:600;">
            Question <span id="q-num">1</span> of <%= (quiz.questions || []).length %>
        </span>
    </div>
    
    <div class="header-center" style="display:flex; align-items:center;">
        <span id="score-tracker" style="display:none; background:rgba(52, 211, 153, 0.1); color:var(--success); padding: 6px 12px; border-radius: var(--radius-sm); margin-right: 16px; font-weight:800; font-size:13px;">
            Score: <span id="live-score">0.00</span>
        </span>
        <button id="math-retry-btn" onclick="renderMath()" style="display:none; background:var(--surface-soft); border:none; border-radius:var(--radius-sm); padding:6px 12px; font-size:12px; color:var(--body); cursor:pointer; margin-right:16px;">
            <i data-lucide="refresh-cw" class="icon-sm"></i> Retry Math
        </button>
        <button id="btn-end-early" onclick="submitQuiz('early')" style="display:none; background: rgba(251, 113, 133, 0.1); color: var(--m-red); border: none; padding: 6px 12px; border-radius: var(--radius-sm); font-size: 12px; cursor: pointer; font-weight: bold; transition:0.2s;">
            <i data-lucide="log-out" class="icon-sm"></i> End Quiz
        </button>
    </div>

    <div class="header-right font-controls" style="display:flex; gap:8px; align-items:center;">
        <button onclick="toggleTheme()" style="background:transparent; border:none; cursor:pointer; color:var(--body); padding:8px;">
            <i data-lucide="moon"></i>
        </button>
        <button id="center-toggle" onclick="toggleQuestionCentering()" style="background:transparent; border:none; cursor:pointer; color:var(--body); padding:8px;" title="Toggle Alignment">
            <i data-lucide="align-center"></i>
        </button>
        <button class="font-btn" onclick="adjustFontSize(-0.1)" style="background:var(--surface-soft); border:none; color:var(--on-dark); padding:6px 12px; border-radius:var(--radius-sm); font-weight:600;">A-</button>
        <button class="font-btn" onclick="adjustFontSize(0.1)" style="background:var(--surface-soft); border:none; color:var(--on-dark); padding:6px 12px; border-radius:var(--radius-sm); font-weight:600;">A+</button>
        <button id="btn-toggle-whiteboard" onclick="toggleWhiteboardVisibility()" style="display:none; background:var(--primary); color:#fff; border:none; border-radius:var(--radius-sm); padding:6px 12px; font-size:12px; cursor:pointer; font-weight:700; transition:0.2s;">
            <i data-lucide="pen-tool" class="icon-sm"></i> Whiteboard
        </button>
    </div>
</div>
`;
content = content.replace(oldTopBar, newTopBar);

// Option buttons CSS - inject styles for redesign
const optionStyles = `
        /* --- Redesigned Option Cards --- */
        .option-btn {
            display: flex; align-items: center; width: 100%; text-align: left;
            background: var(--surface-card); color: var(--on-dark);
            border: 1px solid var(--hairline); padding: 16px 20px;
            margin-bottom: 12px; border-radius: var(--radius-md);
            font-size: 18px; cursor: pointer; font-weight: 500;
            transition: all 0.2s ease; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);
            position: relative;
        }
        .option-btn::before { /* Remove old hover translation */ content: none; }
        .option-btn:hover {
            transform: scale(1.02); border-color: var(--primary);
            box-shadow: var(--shadow);
        }
        .option-btn.selected {
            background: rgba(99, 102, 241, 0.1); border-color: var(--primary);
            box-shadow: 0 0 0 2px var(--primary);
        }
        .option-key-badge {
            display: flex; align-items: center; justify-content: center;
            width: 32px; height: 32px; border-radius: 50%;
            background: var(--surface-elevated); color: var(--body);
            font-weight: 700; margin-right: 16px; font-size: 14px;
            transition: all 0.2s ease; flex-shrink: 0;
        }
        .option-btn.selected .option-key-badge {
            background: var(--primary); color: #fff;
        }
        
        /* Floating Whiteboard Dock */
        .wb-toolbar {
            position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%);
            display: flex; gap: 8px; background: var(--surface-elevated);
            padding: 8px; border-radius: 30px; box-shadow: var(--shadow);
            border: 1px solid var(--hairline); z-index: 1000;
        }
        .wb-btn {
            background: transparent; color: var(--on-dark); border: none;
            padding: 8px 12px; border-radius: 20px; font-size: 13px; font-weight: 600;
            cursor: pointer; transition: 0.2s; display: flex; align-items: center; gap: 6px;
        }
        .wb-btn:hover, .wb-btn.active {
            background: var(--primary); color: #fff;
        }
        
        /* Timer Pill styling */
        #timer {
            font-size: 14px; font-weight: 700; text-align: center; margin: 0 auto 20px auto;
            width: fit-content; padding: 6px 16px; border-radius: 20px;
            background: var(--surface-elevated); color: var(--on-dark);
            border: 1px solid var(--hairline);
        }
        #timer.urgent { background: rgba(251, 113, 133, 0.1); color: var(--m-red); border-color: var(--m-red); }
`;
content = content.replace('</style>', optionStyles + '\n    </style>');

// Modify whiteboard HTML
const oldWbToolbar = /<div class="wb-toolbar">[\s\S]*?<\/div>\s*<div id="wb-container">/;
const newWbToolbar = `
<div id="wb-container" style="position:relative; width:100%; height:100%;">
<div class="wb-toolbar">
    <button class="wb-btn active" data-tool="draw" onclick="setTool('draw')" title="Draw"><i data-lucide="pen-tool"></i></button>
    <button class="wb-btn" data-tool="erase" onclick="setTool('erase')" title="Eraser"><i data-lucide="eraser"></i></button>
    <button class="wb-btn" data-tool="line" onclick="setTool('line')" title="Line"><i data-lucide="minus"></i></button>
    <button class="wb-btn" data-tool="rect" onclick="setTool('rect')" title="Rectangle"><i data-lucide="square"></i></button>
    <button class="wb-btn" data-tool="circle" onclick="setTool('circle')" title="Circle"><i data-lucide="circle"></i></button>
    <button class="wb-btn" onclick="addText()" title="Text"><i data-lucide="type"></i></button>
    <button class="wb-btn" id="wb-grid-toggle" onclick="toggleWBGrid()" title="Grid"><i data-lucide="grid"></i></button>
    <button class="wb-btn" onclick="clearCanvas()" title="Clear"><i data-lucide="trash-2"></i></button>
    <div style="width:1px; background:var(--hairline); margin: 0 4px;"></div>
    <input type="color" id="wb-color" value="#ffffff" style="margin-left: 4px; border: none; background: transparent; width: 32px; height: 32px; cursor: pointer; border-radius:50%;">
    <input type="range" id="wb-size" min="1" max="10" value="2" style="width:60px; margin-left:8px;">
</div>
`;
content = content.replace(oldWbToolbar, newWbToolbar);
// Ensure we remove the old color pickers that were trailing
content = content.replace(/<input type="color" id="wb-color"[\s\S]*?id="wb-size"[\s\S]*?>/, '');

// Fix javascript that renders options to use badges
// Search for option rendering loop.
const oldOptionRender = /btn\.className = 'option-btn';\s*btn\.innerHTML = `\$\{opt\}`;/g;
const newOptionRender = `
btn.className = 'option-btn';
const optionKey = String.fromCharCode(65 + i); // A, B, C, D
btn.innerHTML = \`<div class="option-key-badge">\${optionKey}</div> <div style="flex-grow:1;">\${opt}</div>\`;
`;
content = content.replace(oldOptionRender, newOptionRender);

fs.writeFileSync('views/quiz.ejs', content);

