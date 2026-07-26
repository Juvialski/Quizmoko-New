const fs = require('fs');
const http = require('http');

async function test() {
  const qz = JSON.parse(fs.readFileSync('data/quizzes.json', 'utf-8'));
  let greeceQuizId = '';
  let qIndex = -1;
  for (const [qid, q] of Object.entries(qz)) {
    if (q.questions) {
      q.questions.forEach((qu, i) => {
        if (qu.question && qu.question.includes('Greece')) {
          greeceQuizId = qid;
          qIndex = i;
        }
      });
    }
  }
  
  if (qIndex === -1) { console.log('not found'); return; }
  
  console.log('Found:', greeceQuizId, qIndex);
  const data = JSON.stringify({
    quiz_id: greeceQuizId,
    q_index: qIndex,
    student_answer: "3/10"
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
}
test();
