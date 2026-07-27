const fs = require('fs');
const glob = require('glob');

const files = glob.sync('views/*.ejs');
files.forEach(f => {
  const content = fs.readFileSync(f, 'utf8');
  if (!content.includes('family=Inter')) {
      console.log(f, 'missing Inter font');
  }
});
