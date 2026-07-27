const fs = require('fs');
const glob = require('glob');

glob.sync('views/*.ejs').forEach(file => {
    let content = fs.readFileSync(file, 'utf8');

    // Fix string terminators that were mismatched
    content = content.replace(/='";/g, "='';"); // if const id ='";
    content = content.replace(/="';/g, '="";');
    
    // specifically target const resultId = '<%= result.id %>";
    content = content.replace(/const resultId = '<%= result\.id %>";/g, "const resultId = '<%= result.id %>';");
    content = content.replace(/const resultId = "<%= result\.id %>';/g, 'const resultId = "<%= result.id %>";');

    content = content.replace(/const quizId = '<%= quiz\.id %>";/g, "const quizId = '<%= quiz.id %>';");
    content = content.replace(/const quizId = "<%= quiz\.id %>';/g, 'const quizId = "<%= quiz.id %>";');

    content = content.replace(/const quizId = '<%= id %>";/g, "const quizId = '<%= id %>';");
    content = content.replace(/const quizId = "<%= id %>';/g, 'const quizId = "<%= id %>";');
    
    // '/quiz/"; -> '/quiz/';
    content = content.replace(/'\/quiz\/";/g, "'/quiz/';");
    
    // document.getElementById('url-") -> document.getElementById('url-')
    content = content.replace(/getElementById\('url-"\)/g, "getElementById('url-')");
    content = content.replace(/getElementById\("url-'\)/g, 'getElementById("url-")');
    
    // document.getElementById('active-") -> document.getElementById('active-')
    content = content.replace(/getElementById\('active-"\)/g, "getElementById('active-')");
    content = content.replace(/getElementById\("active-'\)/g, 'getElementById("active-")');
    
    // 'optgroup[label='Local Models (Ollama)']' -> "optgroup[label='Local Models (Ollama)']"
    content = content.replace(/'optgroup\[label='Local Models \(Ollama\)'\]'/g, '"optgroup[label=\'Local Models (Ollama)\']"');
    
    // alert('Error: " + data.error); -> alert('Error: ' + data.error);
    content = content.replace(/alert\('Error: " \+ data\.error\);/g, "alert('Error: ' + data.error);");
    
    // any remaining \'; inside "" ? We don't want to break it.

    fs.writeFileSync(file, content);
});

