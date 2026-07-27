const admin = require('firebase-admin');
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(config) });
const db = admin.firestore();
async function run() {
  const users = await db.collection('users').where('email', '==', 'al.matubis17@gmail.com').get();
  if (users.empty) { console.log('User not found'); return; }
  const uid = users.docs[0].id;
  const quizzes = await db.collection('quizzes').where('user_id', '==', uid).get();
  console.log('Quizzes for', uid, ':', quizzes.size);
  const allQuizzes = await db.collection('quizzes').get();
  console.log('Total quizzes:', allQuizzes.size);
}
run().catch(console.error).finally(() => process.exit(0));
