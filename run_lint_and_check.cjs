const { execSync } = require('child_process');
const glob = require('glob');

const files = glob.sync('views/*.ejs');
files.forEach(file => {
  try {
    execSync(`npx ejs-lint ${file}`, { encoding: 'utf8' });
  } catch (err) {
    console.error(`Error in ${file}:`);
    console.error(err.stdout);
  }
});
