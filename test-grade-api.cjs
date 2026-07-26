const http = require('http');

const data = JSON.stringify({
  quiz_id: 'dummy',
  q_index: 0,
  student_answer: 'hello'
});

const req = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/api/grade_individual',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
}, res => {
  let raw = '';
  res.on('data', c => raw += c);
  res.on('end', () => console.log('Resp:', raw));
});
req.write(data);
req.end();
