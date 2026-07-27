const fs = require('fs');
const glob = require('glob');

glob.sync('views/*.ejs').forEach(file => {
    let content = fs.readFileSync(file, 'utf8');

    // 'Worksheet Quiz", -> 'Worksheet Quiz',
    content = content.replace(/'Worksheet Quiz",/g, "'Worksheet Quiz',");
    
    // alert('Error generating quiz."); -> alert('Error generating quiz.');
    content = content.replace(/alert\('Error generating quiz\."\);/g, "alert('Error generating quiz.');");
    
    // 'Worksheet.doc"; -> 'Worksheet.doc';
    content = content.replace(/'Worksheet.doc";/g, "'Worksheet.doc';");
    
    // const resultId = '<%= result.id %>"; -> const resultId = '<%= result.id %>';
    content = content.replace(/const resultId = '<%= result\.id %>";/g, "const resultId = '<%= result.id %>';");
    
    // 'button[onclick='exportToExcel()']' -> "button[onclick='exportToExcel()']"
    content = content.replace(/'button\[onclick='exportToExcel\(\)'\]'/g, '"button[onclick=\'exportToExcel()\']"');
    
    // document.getElementById('active-") -> document.getElementById('active-')
    content = content.replace(/getElementById\('active-"\)/g, "getElementById('active-')");
    
    // const quizId = '<%= quiz.id %>"; -> const quizId = '<%= quiz.id %>';
    content = content.replace(/const quizId = '<%= quiz\.id %>";/g, "const quizId = '<%= quiz.id %>';");
    
    // '/quiz/"; -> '/quiz/';
    content = content.replace(/'\/quiz\/";/g, "'/quiz/';");
    
    // document.getElementById('url-") -> document.getElementById('url-')
    content = content.replace(/getElementById\('url-"\)/g, "getElementById('url-')");
    
    // 'button[onclick='useLocalOnly()']' -> "button[onclick='useLocalOnly()']"
    content = content.replace(/'button\[onclick='useLocalOnly\(\)'\]'/g, '"button[onclick=\'useLocalOnly()\']"');
    
    // ${isActive ? "status-active' : 'status-blocked"} -> ${isActive ? 'status-active' : 'status-blocked'}
    content = content.replace(/"status-active' : 'status-blocked"/g, "'status-active' : 'status-blocked'");
    
    // Just in case: const quizId = '<%= id %>";
    content = content.replace(/const quizId = '<%= id %>";/g, "const quizId = '<%= id %>';");

    fs.writeFileSync(file, content);
});

