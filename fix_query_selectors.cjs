const fs = require('fs');

let rmx = fs.readFileSync('views/rmxflash_upload.ejs', 'utf8');
rmx = rmx.replace(/"button\[onclick="exportToExcel\(\)"\]"/g, "'button[onclick=\"exportToExcel()\"]'");
fs.writeFileSync('views/rmxflash_upload.ejs', rmx);

let idx = fs.readFileSync('views/index.ejs', 'utf8');
idx = idx.replace(/"button\[onclick="useLocalOnly\(\)"\]"/g, "'button[onclick=\"useLocalOnly()\"]'");
fs.writeFileSync('views/index.ejs', idx);

