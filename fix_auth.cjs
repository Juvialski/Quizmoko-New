const fs = require('fs');

function updateAuthPage(file) {
    let content = fs.readFileSync(file, 'utf8');
    
    // Add btn-primary class to submit button
    content = content.replace(/<button type="submit" id="submit-btn">/g, '<button type="submit" class="btn-primary" id="submit-btn">');
    content = content.replace(/<button type="button" id="google-btn" [^>]+>/g, '<button type="button" id="google-btn" class="btn-secondary" style="width: 100%; margin-top: 10px; background: white; color: black; border-color: #ddd;">');
    
    fs.writeFileSync(file, content);
}

updateAuthPage('views/login.ejs');
updateAuthPage('views/register.ejs');
