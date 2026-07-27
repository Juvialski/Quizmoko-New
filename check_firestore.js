import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, query, where } from "firebase/firestore";
import fs from "fs";
const config = JSON.parse(fs.readFileSync("firebase-applet-config.json"));
const app = initializeApp(config);
const db = getFirestore(app);

async function check() {
  const usersRef = collection(db, "users");
  const q1 = query(usersRef, where("email", "==", "al.matubis17@gmail.com"));
  const usersSnap = await getDocs(q1);
  if (usersSnap.empty) {
     console.log("User not found in Firestore");
     return;
  }
  const uid = usersSnap.docs[0].id;
  const quizzesRef = collection(db, "quizzes");
  const q2 = query(quizzesRef, where("user_id", "==", uid));
  const qs = await getDocs(q2);
  console.log("Quizzes for this UID:", qs.size);
  process.exit(0);
}
check();
