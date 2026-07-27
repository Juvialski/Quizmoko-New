import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, query, where } from "firebase/firestore";
import fs from "fs";
const config = JSON.parse(fs.readFileSync("firebase-applet-config.json"));
const app = initializeApp(config);
const db = getFirestore(app);

async function check() {
  const usersSnap = await getDocs(collection(db, "users"));
  usersSnap.forEach(d => console.log(d.id, d.data()));
  process.exit(0);
}
check();
