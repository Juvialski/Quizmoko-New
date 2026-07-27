const fs = require('fs');
const users = JSON.parse(fs.readFileSync('data/users.json'));
let u = null;
for(let k in users) { if(users[k].email === 'al.matubis17@gmail.com') u = users[k]; }
console.log('Local role:', u ? u.role : 'not found');
