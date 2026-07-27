const fs = require('fs');
let content = fs.readFileSync('views/index.ejs', 'utf-8');

// Fix stepVal
content = content.replace(/onclick="stepVal\("/g, `onclick="stepVal('`);
// Fix copyLink
content = content.replace(/onclick="copyLink\("<%([^>]+)>'\)'>/g, `onclick="copyLink('<%$1>')">`);
// Fix toggleQuizDropdown
content = content.replace(/onclick="toggleQuizDropdown\("dropdown-<%([^>]+)>'\)' style=/g, `onclick="toggleQuizDropdown('dropdown-<%$1>')" style=`);
// Fix openMoveModal
content = content.replace(/onclick="openMoveModal\("<%([^>]+)>", '<%([^>]+)>'\)'>/g, `onclick="openMoveModal('<%$1>', '<%$2>')">`);
// Fix autoInstallModel
content = content.replace(/onclick="autoInstallModel\(document.getElementById\("install_model_select'\)\.value\)"/g, `onclick="autoInstallModel(document.getElementById('install_model_select').value)"`);

fs.writeFileSync('views/index.ejs', content);
