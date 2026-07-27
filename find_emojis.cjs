const fs = require('fs');
const glob = require('glob');

const emojiRegex = /[\u{1F300}-\u{1F5FF}\u{1F900}-\u{1F9FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;

const files = glob.sync('views/*.ejs');
files.forEach(f => {
  const content = fs.readFileSync(f, 'utf8');
  let match;
  const found = new Set();
  while ((match = emojiRegex.exec(content)) !== null) {
    found.add(match[0]);
  }
  if (found.size > 0) {
    console.log(f, Array.from(found).join(' '));
  }
});
