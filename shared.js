import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  getDocs,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  getDocs,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  runTransaction,
};

export async function ensureAuth() {
  await setPersistence(auth, browserLocalPersistence);
  if (auth.currentUser) return auth.currentUser;
  await signInAnonymously(auth);
  return new Promise((resolve, reject) => {
    const off = onAuthStateChanged(
      auth,
      (user) => {
        if (user) {
          off();
          resolve(user);
        }
      },
      reject
    );
  });
}

export function normalizeCode(input = "") {
  return input.replace(/\D/g, "").slice(0, 6);
}

export async function roomExists(code) {
  const snap = await getDoc(doc(db, "sessions", code));
  return snap.exists();
}

export async function joinRoom(code, uid) {
  const roomRef = doc(db, "sessions", code);
  const roomSnap = await getDoc(roomRef);
  if (!roomSnap.exists()) throw new Error("找不到這個場次代碼");

  await setDoc(
    doc(db, "sessions", code, "participants", uid),
    { uid, joinedAt: serverTimestamp() },
    { merge: true }
  );
  return roomSnap.data();
}

export async function loadCandidateMap(code) {
  const snap = await getDocs(collection(db, "sessions", code, "candidates"));
  const map = {};
  snap.forEach((d) => (map[d.id] = d.data()));
  return map;
}

export function subscribeRoom(code, callback, onError) {
  return onSnapshot(doc(db, "sessions", code), callback, onError);
}

export function subscribeRound(code, roundNumber, callback, onError) {
  return onSnapshot(doc(db, "sessions", code, "rounds", String(roundNumber)), callback, onError);
}

export async function getMyVote(code, roundNumber, uid) {
  const voteId = `${roundNumber}_${uid}`;
  const snap = await getDoc(doc(db, "sessions", code, "votes", voteId));
  return snap.exists() ? snap.data() : null;
}

export async function castVote(code, roundNumber, choice, uid) {
  const voteRef = doc(db, "sessions", code, "votes", `${roundNumber}_${uid}`);
  await setDoc(voteRef, {
    uid,
    round: roundNumber,
    choice,
    createdAt: serverTimestamp(),
  });
}

export async function getRoundVotes(code, roundNumber) {
  const q = query(
    collection(db, "sessions", code, "votes"),
    where("round", "==", roundNumber)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data());
}

export async function getParticipantCount(code) {
  const snap = await getDocs(collection(db, "sessions", code, "participants"));
  return snap.size;
}

export async function getAllMyVotes(code, uid) {
  const q = query(
    collection(db, "sessions", code, "votes"),
    where("uid", "==", uid)
  );
  const snap = await getDocs(q);
  const result = {};
  snap.forEach((d) => {
    const data = d.data();
    result[data.round] = data.choice;
  });
  return result;
}

export function pickWinnerFromTotals(options, totals) {
  const max = Math.max(...options.map((id) => totals[id] || 0));
  return options.filter((id) => (totals[id] || 0) === max);
}

export function renderCandidateCard(candidateId, candidate, { dim = false, selected = false, disabled = false } = {}) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "candidate-card";
  el.dataset.candidate = candidateId;
  if (dim) el.classList.add("is-dimmed");
  if (selected) el.classList.add("is-selected");
  if (disabled) el.disabled = true;

  const img = document.createElement("img");
  img.src = candidate?.imageData || "";
  img.alt = `候選項目 ${candidateId}`;
  img.draggable = false;
  el.appendChild(img);
  return el;
}

export function formatPercent(value, total) {
  if (!total) return "0%";
  return `${Math.round((value / total) * 100)}%`;
}

export function escapeHtml(text = "") {
  return text.replace(/[&<>'"]/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  }[ch]));
}
