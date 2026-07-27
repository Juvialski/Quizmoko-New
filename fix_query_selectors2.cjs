const fs = require('fs');

let rmx = fs.readFileSync('views/rmxflash_upload.ejs', 'utf8');
rmx = rmx.replace(/'application\/json"/g, "'application/json'");
fs.writeFileSync('views/rmxflash_upload.ejs', rmx);

let idx = fs.readFileSync('views/index.ejs', 'utf8');
idx = idx.replace(/'\/api\/ollama_tags\?url="/g, "'/api/ollama_tags?url='");
fs.writeFileSync('views/index.ejs', idx);

