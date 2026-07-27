const fs = require('fs');

let content = fs.readFileSync('views/index.ejs', 'utf-8');

// Replace quiz card html
const oldQuizCardRegex = /<div class="quiz-item".*?>[\s\S]*?<\/form>[\s\S]*?<\/div>[\s\S]*?<\/script>[\s\S]*?<\/div>/g;
const newQuizCard = `
<div class="quiz-card-horizontal" data-title="<%= typeof sq.title !== 'undefined' && sq.title ? sq.title : '' %>" data-id="<%= typeof sq.id !== 'undefined' ? sq.id : '' %>">
    <div class="quiz-info">
        <div style="font-size: 11px; font-weight: 700; color: var(--primary); margin-bottom: 4px; text-transform: uppercase;">
            <i data-lucide="book-open" class="icon-sm" style="width: 12px; margin-right: 4px;"></i> <%= typeof sq.subject !== 'undefined' ? sq.subject : 'Quiz' %>
        </div>
        <div class="quiz-title" style="margin-bottom: 4px; display:flex; align-items:center; gap:8px;">
            <%= typeof sq.title !== 'undefined' ? sq.title : '' %>
        </div>
        <div class="quiz-meta" style="margin-bottom: 0;">
            <i data-lucide="clock" style="width: 12px; margin-right:4px;"></i> <%= typeof sq.time_limit !== 'undefined' ? sq.time_limit : '' %>s / Q • 
            <span class="link-display" style="border:none; background:transparent; padding:0; margin-left:8px; cursor:pointer;" id="url-<%= typeof sq.id !== 'undefined' ? sq.id : '' %>" onclick="copyLink('<%= typeof sq.id !== 'undefined' ? sq.id : '' %>')"></span>
        </div>
    </div>
    
    <div style="display: flex; align-items: center;">
        <a href="/live/<%= typeof sq.id !== 'undefined' ? sq.id : '' %>" class="primary-action-btn"><i data-lucide="radio" class="icon-sm" style="color:white;"></i> Launch</a>
        <a href="/edit/<%= typeof sq.id !== 'undefined' ? sq.id : '' %>" class="primary-action-btn" style="background: var(--surface-soft); color: var(--on-dark);"><i data-lucide="edit-3" class="icon-sm"></i> Edit</a>
        
        <div class="quiz-actions-menu">
            <button type="button" onclick="toggleQuizDropdown('dropdown-<%= typeof sq.id !== 'undefined' ? sq.id : '' %>')" style="background:none; border:none; color:var(--body); cursor:pointer; padding: 8px;">
                <i data-lucide="more-vertical"></i>
            </button>
            <div class="quiz-actions-dropdown" id="dropdown-<%= typeof sq.id !== 'undefined' ? sq.id : '' %>">
                <button type="button" onclick="copyLink('<%= typeof sq.id !== 'undefined' ? sq.id : '' %>')"><i data-lucide="copy" class="icon-sm"></i> Copy Link</button>
                <button type="button" onclick="openMoveModal('<%= typeof sq.id !== 'undefined' ? sq.id : '' %>', '<%= typeof sq.subject !== 'undefined' ? sq.subject : '' %>')"><i data-lucide="folder-output" class="icon-sm"></i> Move</button>
                <a href="/results/<%= typeof sq.id !== 'undefined' ? sq.id : '' %>"><i data-lucide="bar-chart-2" class="icon-sm"></i> Results</a>
                <form action="/delete/<%= typeof sq.id !== 'undefined' ? sq.id : '' %>" method="POST" onsubmit="return confirm('Delete this quiz?');">
                    <button type="submit" style="color: var(--m-red);"><i data-lucide="trash-2" class="icon-sm"></i> Delete</button>
                </form>
            </div>
        </div>
    </div>
    <script>document.getElementById("url-<%= typeof sq.id !== 'undefined' ? sq.id : '' %>").innerText = window.location.origin + "/quiz/<%= typeof sq.id !== 'undefined' ? sq.id : '' %>";</script>
</div>
`;
content = content.replace(oldQuizCardRegex, newQuizCard.trim());

// Rewrite AI generator using simple regex string replacement to wrap in accordions
// Look for basic elements and replace the layout

// To be safe, I'll use index-based replacement for the AI form
let startIndex = content.indexOf('<form action="/generate_ai"');
let endIndex = content.indexOf('</form>', startIndex) + 7;

if (startIndex !== -1 && endIndex !== -1) {
    let formContent = content.substring(startIndex, endIndex);
    
    // Convert to tabbed/accordion view. 
    // We can do this safely by retaining inputs.
    
    // Instead of parsing perfectly, let's just generate a clean form with the exact same input names.
    const newForm = `
<form action="/generate_ai" method="POST" onsubmit="return handleAILoading(event, this)">
    <input type="hidden" name="api_key" id="hidden_api_key" required>
    <input type="hidden" name="ollama_url" id="hidden_ollama_url" value="http://127.0.0.1:11434">
    
    <div class="accordion-item">
        <div class="accordion-header" onclick="toggleAccordion('acc-basic')">
            <span><i data-lucide="settings" class="icon-sm"></i> Basic Setup</span>
            <i data-lucide="chevron-down" class="icon-sm"></i>
        </div>
        <div class="accordion-body open" id="acc-basic">
            <label style="margin-top:0;">Select AI Model</label>
            <div style="display: grid; grid-template-columns: 1fr 140px; gap: 10px; align-items: center; margin-bottom: 16px;">
                <select name="model_name" id="model_select" style="margin-bottom: 0;" onchange="updateCounterUI()">
                    <option value="gemini-3.6-flash">Gemini 3.6 Flash</option>
                    <option value="gemini-3.5-flash">Gemini 3.5 Flash</option>
                    <option value="gemini-3.5-flash-lite" selected>Gemini 3.5 Flash Lite</option>
                    <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash Lite</option>
                    <option value="gemini-3.0-flash">Gemini 3.0 Flash</option>
                    <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                    <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash Lite</option>
                    <optgroup label="Local Models (Ollama)">
                        <option value="ollama:llama3">Llama 3 (Local)</option>
                        <option value="ollama:mistral">Mistral (Local)</option>
                        <option value="__install_ollama__">📥 Install Local Models...</option>
                    </optgroup>
                </select>
                <div id="api-counter-badge" style="background: var(--surface-soft); color: var(--on-dark); padding: 8px 12px; border-radius: var(--radius-sm); font-weight: 700; font-size: 11px; text-align: center; text-transform: uppercase;">
                    Loading...
                </div>
            </div>
            
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px;">
                <div>
                    <label style="margin-top:0;">Quiz Topic</label>
                    <input type="text" name="topic" placeholder="e.g. Linear Equations" required id="topic-input" style="margin-bottom: 0;">
                </div>
                <div>
                    <label style="margin-top:0;">Subject / Folder</label>
                    <select name="subject" onchange="toggleCustomSubject(this)" required style="margin-bottom: 0;">
                        <% for (let s of (all_subjects || [])) { %>
                            <option value="<%= typeof s !== 'undefined' ? s : '' %>" <% if (s == 'General') { %>selected<% } %>><%= typeof s !== 'undefined' ? s : '' %></option>
                        <% } %>
                        <option value="__custom__">➕ Custom...</option>
                    </select>
                    <input type="text" name="custom_subject" class="custom-subject-input" style="display:none; margin-top:5px; box-sizing: border-box;" placeholder="Enter folder name">
                </div>
            </div>
        </div>
    </div>
    
    <div class="accordion-item">
        <div class="accordion-header" onclick="toggleAccordion('acc-types')">
            <span><i data-lucide="layers" class="icon-sm"></i> Question Types & Limits</span>
            <i data-lucide="chevron-down" class="icon-sm"></i>
        </div>
        <div class="accordion-body" id="acc-types">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px;">
                <div>
                    <label style="margin-top:0;">Question Style</label>
                    <select name="question_style" required style="margin-bottom: 0;">
                        <option value="Simple / Direct">Simple / Direct</option>
                        <option value="Word Problems">Word Problems</option>
                        <option value="Mixed" selected>Mixed</option>
                    </select>
                </div>
                <div>
                    <label style="margin-top:0;">Test Type</label>
                    <select name="test_type" id="test_type_select" required onchange="toggleTypeDistribution()" style="margin-bottom: 0;">
                        <option value="Multiple Choice">Multiple Choice</option>
                        <option value="True/False">True/False</option>
                        <option value="Identification">Identification</option>
                        <option value="Open Ended">Open Ended</option>
                        <option value="Graphing">Graphing / Drawing</option>
                        <option value="Mixed" selected>Mixed (All)</option>
                    </select>
                </div>
            </div>
            
            <div id="mixed-distribution-group" style="margin-bottom: 12px;">
                <label style="margin-top:0;">Mixed Distribution <span id="type-total" class="limit-status-green" style="font-size:10px; margin-left:5px;">(Total: 10)</span></label>
                <div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px;">
                    <div class="stepper-group">
                        <span style="font-size:9px; font-weight:bold; color:var(--primary);">MC</span>
                        <div>
                            <button type="button" class="stepper-btn" onclick="stepVal('mc_count', -1)">-</button>
                            <input type="number" name="mc_count" id="mc_count" value="2" oninput="updateTypeTotal()" required min="0" class="stepper-input">
                            <button type="button" class="stepper-btn" onclick="stepVal('mc_count', 1)">+</button>
                        </div>
                    </div>
                    <div class="stepper-group">
                        <span style="font-size:9px; font-weight:bold; color:var(--primary);">T/F</span>
                        <div>
                            <button type="button" class="stepper-btn" onclick="stepVal('tf_count', -1)">-</button>
                            <input type="number" name="tf_count" id="tf_count" value="2" oninput="updateTypeTotal()" required min="0" class="stepper-input">
                            <button type="button" class="stepper-btn" onclick="stepVal('tf_count', 1)">+</button>
                        </div>
                    </div>
                    <div class="stepper-group">
                        <span style="font-size:9px; font-weight:bold; color:var(--primary);">ID</span>
                        <div>
                            <button type="button" class="stepper-btn" onclick="stepVal('id_count', -1)">-</button>
                            <input type="number" name="id_count" id="id_count" value="2" oninput="updateTypeTotal()" required min="0" class="stepper-input">
                            <button type="button" class="stepper-btn" onclick="stepVal('id_count', 1)">+</button>
                        </div>
                    </div>
                    <div class="stepper-group">
                        <span style="font-size:9px; font-weight:bold; color:var(--primary);">OE</span>
                        <div>
                            <button type="button" class="stepper-btn" onclick="stepVal('oe_count', -1)">-</button>
                            <input type="number" name="oe_count" id="oe_count" value="2" oninput="updateTypeTotal()" required min="0" class="stepper-input">
                            <button type="button" class="stepper-btn" onclick="stepVal('oe_count', 1)">+</button>
                        </div>
                    </div>
                    <div class="stepper-group">
                        <span style="font-size:9px; font-weight:bold; color:var(--primary);">GR</span>
                        <div>
                            <button type="button" class="stepper-btn" onclick="stepVal('gr_count', -1)">-</button>
                            <input type="number" name="gr_count" id="gr_count" value="2" oninput="updateTypeTotal()" required min="0" class="stepper-input">
                            <button type="button" class="stepper-btn" onclick="stepVal('gr_count', 1)">+</button>
                        </div>
                    </div>
                </div>
            </div>
            
            <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 12px;" id="limits-group">
                <div><label>Total Qs</label><input type="number" name="num_items" value="10" required></div>
                <div><label>Time(s)</label><input type="number" name="time_limit" value="200" required></div>
                <div><label>Images</label><input type="number" name="images_count" value="0" min="0" required></div>
                <div><label>Batch</label><input type="number" name="batch_size" value="3" min="1" max="10" required></div>
            </div>
        </div>
    </div>
    
    <div class="accordion-item">
        <div class="accordion-header" onclick="toggleAccordion('acc-diff')">
            <span><i data-lucide="bar-chart" class="icon-sm"></i> Difficulty & Mode</span>
            <i data-lucide="chevron-down" class="icon-sm"></i>
        </div>
        <div class="accordion-body" id="acc-diff">
            <div style="margin-bottom: 12px;">
                <label style="margin-top:0;">Quiz Mode</label>
                <select name="quiz_mode" style="margin-bottom: 0;">
                    <option value="sequential">Sequential</option>
                    <option value="back_and_forth" selected>Back-and-Forth</option>
                </select>
            </div>
            <div style="margin-bottom: 12px;">
                <label style="margin-top:0;">Difficulty <span id="pct-total" class="limit-status-green" style="font-size:10px; margin-left:5px;">(Total: 100%)</span></label>
                <div class="difficulty-grid" style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px;">
                    <div><label style="font-size:10px; color:var(--success);">Easy</label><input type="number" name="easy_pct" value="50" oninput="updateTotal()" required></div>
                    <div><label style="font-size:10px; color:var(--warning);">Avg</label><input type="number" name="avg_pct" value="25" oninput="updateTotal()" required></div>
                    <div><label style="font-size:10px; color:var(--m-red);">Hard</label><input type="number" name="hard_pct" value="25" oninput="updateTotal()" required></div>
                </div>
            </div>
        </div>
    </div>
    
    <div style="margin-top: 16px;">
        <button type="submit" class="btn-primary" id="generate-btn" style="padding: 14px; font-size: 16px; font-weight: 700; width: 100%; display: flex; justify-content: center; align-items: center; gap: 8px;">
            <i data-lucide="zap"></i> Generate Quiz
        </button>
        <button type="button" class="btn-danger" id="cancel-generate-btn" style="display:none; padding: 14px; font-size: 16px; font-weight: 700; width: 100%; justify-content: center; align-items: center; gap: 8px;" onclick="cancelGeneration()">
            <i data-lucide="x-circle"></i> Cancel Generation
        </button>
    </div>
    <div id="loading-overlay" style="display:none; margin-top: 10px; text-align: center; color: var(--body);">
        <i data-lucide="loader-2" class="spin-icon"></i> Generating... Please wait.
    </div>
</form>
    `;
    
    content = content.substring(0, startIndex) + newForm + content.substring(endIndex);
}

fs.writeFileSync('views/index.ejs', content);

