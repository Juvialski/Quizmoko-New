const fs = require('fs');
const glob = require('glob');

const files = glob.sync('views/*.ejs');

files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    
    // Fix placeholders (remove the icon)
    content = content.replace(/placeholder="<i data-lucide="[^"]+" class="icon-sm"><\/i> ([^"]+)"/g, 'placeholder="$1"');

    // Fix innerText and innerHTML with double quotes wrapping the icon
    // Example: btn.innerText = "<i data-lucide="search" class="icon-sm"></i> Scan for Local Models";
    // We want to change it to btn.innerHTML = '<i data-lucide="search" class="icon-sm"></i> Scan for Local Models';
    
    // Replace .innerText = "<i data-lucide="something" class="icon-sm"></i> text"
    // with .innerHTML = '<i data-lucide="something" class="icon-sm"></i> text'
    content = content.replace(/\.innerText = "(<i data-lucide="[^"]+" class="icon-sm"><\/i>[^"]*)";/g, `.innerHTML = '$1';`);
    content = content.replace(/\.innerText = \`(<i data-lucide="[^"]+" class="icon-sm"><\/i>[^\`]*)\`;/g, `.innerHTML = \`$1\`;`);

    fs.writeFileSync(file, content);
});
