const ejs = require('ejs');
const fs = require('fs');
const glob = require('glob'); // Need to check if glob is installed, if not just readdir sync

const files = fs.readdirSync('views').filter(f => f.endsWith('.ejs'));
let hasError = false;
for (const file of files) {
  try {
    const template = fs.readFileSync(`views/${file}`, 'utf-8');
    ejs.compile(template);
    console.log(`${file} compiled successfully`);
  } catch (err) {
    console.error(`Error compiling ${file}:`, err.message);
    hasError = true;
  }
}
if(hasError) process.exit(1);
