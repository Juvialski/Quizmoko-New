const admin = require('firebase-admin');
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(config) });
const db = admin.firestore();
async function run() {
  const users = await db.collection('users').where('email', '==', 'al.matubis17@gmail.com').get();
  if (users.empty) { console.log('User not found'); return; }
  const doc = users.docs[0];
  console.log('User Role:', doc.data().role);
}
run().catch(console.error).finally(() => process.exit(0));
