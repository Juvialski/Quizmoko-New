const http = require('http');
const data = JSON.stringify({
  quiz_id: 'quiz_1785076129657',
  q_index: 0,
  student_answer: '3972',
  solution_snapshots: ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="]
});
const req = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/api/grade_individual',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
}, res => {
  let raw = '';
  res.on('data', c => raw += c);
  res.on('end', () => console.log('Resp:', raw));
});
req.write(data);
req.end();
