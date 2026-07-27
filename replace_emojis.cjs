const fs = require('fs');
const glob = require('glob');

const emojiMap = {
    '🌙': 'moon', '🌓': 'moon',
    '🤖': 'bot',
    '📄': 'file-text',
    '🔑': 'key',
    '⚡': 'zap',
    '📤': 'upload', '📥': 'download',
    '📸': 'camera',
    '🔍': 'search',
    '📝': 'edit-3', '✏': 'edit-2',
    '⚠': 'alert-triangle',
    '✨': 'sparkles',
    '✂': 'scissors',
    '✅': 'check-circle', '✓': 'check',
    '❌': 'x-circle', '✗': 'x', '🚫': 'slash',
    '📋': 'clipboard',
    '🗑': 'trash-2',
    '🛡': 'shield',
    '👀': 'eye',
    '🖨': 'printer',
    '📐': 'ruler', '📏': 'ruler',
    '🔄': 'refresh-cw',
    '🎯': 'target',
    '🏁': 'flag',
    '➡': 'arrow-right', '🔙': 'arrow-left',
    '🎉': 'party-popper',
    '🧽': 'eraser',
    '🔌': 'plug',
    '🛑': 'stop-circle',
    '📡': 'radio',
    '🚪': 'log-out',
    '➕': 'plus-circle',
    '📊': 'bar-chart-2', '📉': 'trending-down', '📈': 'trending-up',
    '📚': 'book-open',
    '🔗': 'link',
    '📁': 'folder',
    '💾': 'save',
    '🦙': 'box', // box for llama
    '🌐': 'globe',
    '📦': 'package',
    '🖼': 'image',
    '💡': 'lightbulb'
};

const files = glob.sync('views/*.ejs');

files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    
    // Replace emojis
    for (const [emoji, icon] of Object.entries(emojiMap)) {
        // Special case for toggleTheme button which might use moon
        if (content.includes(`>${emoji}</button>`) && icon === 'moon') {
             content = content.replace(new RegExp(`>${emoji}</button>`, 'g'), `><i data-lucide="moon"></i></button>`);
        } else {
             // General replacement, adding icon-sm class if possible
             content = content.replace(new RegExp(emoji, 'g'), `<i data-lucide="${icon}" class="icon-sm"></i>`);
        }
    }

    fs.writeFileSync(file, content);
});
