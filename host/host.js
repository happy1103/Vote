import {
  auth,
  db,
  ensureAuth,
  makeParticipantId,
  roomExists,
  loadCandidateMap,
  subscribeRoom,
  subscribeRound,
  getMyVote,
  getAllMyVotes,
  castVote,
  getRoundVotes,
  getParticipantCount,
  pickWinnerFromTotals,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp,
  renderCandidateCard,
  formatPercent,
} from "../shared.js";

const CANDIDATE_IDS = ["A", "B", "C", "D", "E", "F", "G"];
const INITIAL_ROUNDS = {
  1: ["A", "B"],
  2: ["C", "D"],
  3: ["E", "F"],
};

const setupPanel = document.querySelector("#setupPanel");
const hostPanel = document.querySelector("#hostPanel");
const imagePickerGrid = document.querySelector("#imagePickerGrid");
const createRoomBtn = document.querySelector("#createRoomBtn");
const createDefaultRoomBtn = document.querySelector("#createDefaultRoomBtn");
const setupMessage = document.querySelector("#setupMessage");
const hostRoomCode = document.querySelector("#hostRoomCode");
const roundStat = document.querySelector("#roundStat");
const voteStat = document.querySelector("#voteStat");
const hostStatusText = document.querySelector("#hostStatusText");
const hostActions = document.querySelector("#hostActions");
const hostVotePanel = document.querySelector("#hostVotePanel");
const tiePanel = document.querySelector("#tiePanel");
const copyLinkBtn = document.querySelector("#copyLinkBtn");
const newRoomBtn = document.querySelector("#newRoomBtn");
const toast = document.querySelector("#toast");

let uid = null;
let participantId = null;
let code = null;
let roomData = null;
let roundData = null;
let candidates = {};
let myVote = null;
let selectedImages = {};
let unsubRoom = null;
let unsubRound = null;
let statTimer = null;
let voteInFlight = false;

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 1800);
}

function createPickers() {
  imagePickerGrid.innerHTML = "";
  CANDIDATE_IDS.forEach((id) => {
    const box = document.createElement("div");
    box.className = "image-picker";
    box.innerHTML = `
      <label>${id}${id === "G" ? "（種子）" : ""}</label>
      <input type="file" accept="image/*" data-id="${id}" />
      <img class="image-preview hidden" alt="${id} 預覽" />`;
    const input = box.querySelector("input");
    const preview = box.querySelector("img");
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      setupMessage.textContent = `正在處理 ${id} 圖片……`;
      try {
        const imageData = await compressImage(file);
        selectedImages[id] = imageData;
        preview.src = imageData;
        preview.classList.remove("hidden");
        setupMessage.textContent = "";
      } catch (err) {
        delete selectedImages[id];
        preview.classList.add("hidden");
        setupMessage.textContent = `圖片處理失敗：${err.message}`;
      }
    });
    imagePickerGrid.appendChild(box);
  });
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("無法讀取圖片"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("圖片格式無法讀取"));
      img.onload = () => {
        const max = 900;
        let { width, height } = img;
        if (width > max || height > max) {
          const scale = Math.min(max / width, max / height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { alpha: false });
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        let data = canvas.toDataURL("image/webp", 0.78);
        if (!data.startsWith("data:image/webp")) data = canvas.toDataURL("image/jpeg", 0.78);
        if (data.length > 780000) {
          data = canvas.toDataURL("image/jpeg", 0.62);
        }
        if (data.length > 900000) {
          reject(new Error("壓縮後圖片仍太大，請換一張尺寸較小的圖片"));
          return;
        }
        resolve(data);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function generateRoomCode() {
  for (let i = 0; i < 20; i++) {
    const candidate = String(Math.floor(100000 + Math.random() * 900000));
    if (!(await roomExists(candidate))) return candidate;
  }
  throw new Error("暫時無法產生場次代碼，請再試一次");
}

async function createRoomFromImages(imageMap, { defaultRoom = false } = {}) {
  const missing = CANDIDATE_IDS.filter((id) => !imageMap[id]);
  if (missing.length) {
    setupMessage.textContent = `還缺少：${missing.join("、")} 的圖片`;
    return;
  }

  createRoomBtn.disabled = true;
  createDefaultRoomBtn.disabled = true;
  setupMessage.textContent = defaultRoom ? "正在建立 default 房間……" : "正在建立場次……";
  try {
    const newCode = await generateRoomCode();
    await setDoc(doc(db, "sessions", newCode), {
      hostUid: uid,
      status: "setup",
      currentRound: 1,
      createdAt: serverTimestamp(),
      defaultRoom,
    });

    await Promise.all(
      CANDIDATE_IDS.map((id) =>
        setDoc(doc(db, "sessions", newCode, "candidates", id), {
          id,
          imageData: imageMap[id],
          createdAt: serverTimestamp(),
        })
      )
    );

    for (let round = 1; round <= 3; round++) {
      await setDoc(doc(db, "sessions", newCode, "rounds", String(round)), {
        round,
        options: INITIAL_ROUNDS[round],
        status: "pending",
        winner: null,
        totals: {},
      });
    }

    await setDoc(doc(db, "sessions", newCode, "participants", participantId), {
      uid: participantId,
      role: "host",
      joinedAt: serverTimestamp(),
    });

    localStorage.setItem("vote_host_room", newCode);
    await openHostRoom(newCode);
  } catch (err) {
    setupMessage.textContent = err?.message || "建立失敗";
  } finally {
    createRoomBtn.disabled = false;
    createDefaultRoomBtn.disabled = false;
  }
}

async function createRoom() {
  await createRoomFromImages(selectedImages);
}

async function createDefaultRoom() {
  const imageMap = Object.fromEntries(
    CANDIDATE_IDS.map((id) => [id, new URL(`../images/${id}.jpg`, location.href).href])
  );

  setupMessage.textContent = "正在確認 default 圖片……";
  try {
    const checks = await Promise.all(
      CANDIDATE_IDS.map(async (id) => {
        const response = await fetch(imageMap[id], { method: "HEAD", cache: "no-store" });
        return response.ok ? null : id;
      })
    );
    const missing = checks.filter(Boolean);
    if (missing.length) {
      setupMessage.textContent = `找不到 default 圖片：${missing.map((id) => `${id}.jpg`).join("、")}。請確認都放在 images 資料夾。`;
      return;
    }
  } catch (_) {
    setupMessage.textContent = "無法確認 default 圖片，請確認 images/A.jpg～images/G.jpg 已上傳後再試一次。";
    return;
  }

  await createRoomFromImages(imageMap, { defaultRoom: true });
}

async function openHostRoom(roomCode) {
  const snap = await getDoc(doc(db, "sessions", roomCode));
  if (!snap.exists() || snap.data().hostUid !== uid) {
    localStorage.removeItem("vote_host_room");
    return false;
  }

  code = roomCode;
  candidates = await loadCandidateMap(code);
  setupPanel.classList.add("hidden");
  hostPanel.classList.remove("hidden");
  hostRoomCode.textContent = code;
  subscribeHostRoom();
  return true;
}

function subscribeHostRoom() {
  unsubRoom?.();
  unsubRoom = subscribeRoom(code, async (snap) => {
    if (!snap.exists()) return;
    roomData = snap.data();
    if (roomData.currentRound) subscribeHostRound(roomData.currentRound);
    await refreshStats();
    renderHostControls();
    renderHostVote();
  });

  clearInterval(statTimer);
  statTimer = setInterval(refreshStats, 2500);
}

function subscribeHostRound(roundNumber) {
  if (unsubRound) unsubRound();
  unsubRound = subscribeRound(code, roundNumber, async (snap) => {
    roundData = snap.exists() ? snap.data() : null;
    myVote = await getMyVote(code, roundNumber, participantId);
    renderHostControls();
    renderHostVote();
    refreshStats();
  });
}

async function refreshStats() {
  if (!code || !roomData) return;
  try {
    const participantCount = await getParticipantCount(code);
    const votes = roomData.status === "setup" || roomData.status === "finished"
      ? []
      : await getRoundVotes(code, roomData.currentRound);
    roundStat.textContent = roomData.status === "finished" ? "完成" : `${roomData.currentRound} / 5`;
    voteStat.textContent = `${votes.length} / ${participantCount}`;
  } catch (_) {}
}

function renderHostControls() {
  if (!roomData) return;
  hostActions.innerHTML = "";
  tiePanel.classList.add("hidden");

  if (roomData.status === "setup") {
    hostStatusText.textContent = "場次已建立，準備好後開放第 1 階段。";
    hostActions.innerHTML = `<button id="startBtn" class="btn success">開放第 1 階段投票</button>`;
    hostActions.querySelector("#startBtn").onclick = () => openRound(1);
    return;
  }

  if (roomData.status === "voting") {
    hostStatusText.textContent = `第 ${roomData.currentRound} 階段投票中。你可以等大家投得差不多後公布結果。`;
    hostActions.innerHTML = `<button id="revealBtn" class="btn">顯示結果</button>`;
    hostActions.querySelector("#revealBtn").onclick = revealCurrentRound;
    return;
  }

  if (roomData.status === "results") {
    hostStatusText.textContent = `第 ${roomData.currentRound} 階段結果已公布。`;
    if (roomData.currentRound < 5) {
      hostActions.innerHTML = `<button id="nextBtn" class="btn success">開放第 ${roomData.currentRound + 1} 階段</button>`;
      hostActions.querySelector("#nextBtn").onclick = () => advanceToNextRound();
    } else {
      hostActions.innerHTML = `<button id="finishBtn" class="btn success">結束場次並顯示最終比較</button>`;
      hostActions.querySelector("#finishBtn").onclick = finishRoom;
    }
    return;
  }

  if (roomData.status === "finished") {
    hostStatusText.textContent = "這個場次已全部完成。";
  }
}

async function openRound(roundNumber) {
  const roundRef = doc(db, "sessions", code, "rounds", String(roundNumber));
  await updateDoc(roundRef, { status: "voting" });
  await updateDoc(doc(db, "sessions", code), {
    currentRound: roundNumber,
    status: "voting",
  });
}

async function revealCurrentRound() {
  const round = roomData.currentRound;
  const options = roundData?.options || [];
  const votes = await getRoundVotes(code, round);
  if (!votes.length) {
    showToast("目前還沒有人投票");
    return;
  }

  const totals = Object.fromEntries(options.map((id) => [id, 0]));
  votes.forEach((vote) => {
    if (vote.choice in totals) totals[vote.choice]++;
  });

  const winners = pickWinnerFromTotals(options, totals);
  let winner = winners[0];
  const wasTie = winners.length > 1;

  // 同票時，在主持人按下「顯示結果」的當下才隨機抽出晉級者。
  // 使用瀏覽器的加密隨機來源，抽籤前主持人不會知道結果。
  if (wasTie) {
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    winner = winners[random[0] % winners.length];
  }

  await saveRoundResult(winner, totals, { wasTie, tied: winners });
  if (wasTie) showToast("同票，已隨機抽出晉級者");
}

async function saveRoundResult(winner, totals, { wasTie = false, tied = [] } = {}) {
  const round = roomData.currentRound;
  await updateDoc(doc(db, "sessions", code, "rounds", String(round)), {
    status: "results",
    winner,
    totals,
    tieBreak: wasTie,
    tiedCandidates: wasTie ? tied : [],
    revealedAt: serverTimestamp(),
  });
  await updateDoc(doc(db, "sessions", code), { status: "results" });
  tiePanel.classList.add("hidden");
}

async function advanceToNextRound() {
  const next = roomData.currentRound + 1;
  let options;

  if (next === 4) {
    const winners = [];
    for (let r = 1; r <= 3; r++) {
      const snap = await getDoc(doc(db, "sessions", code, "rounds", String(r)));
      const winner = snap.data()?.winner;
      if (!winner) throw new Error(`第 ${r} 階段尚未有勝者`);
      winners.push(winner);
    }
    options = winners;
  } else if (next === 5) {
    const r4 = await getDoc(doc(db, "sessions", code, "rounds", "4"));
    const winner4 = r4.data()?.winner;
    if (!winner4) throw new Error("第 4 階段尚未有勝者");
    options = [winner4, "G"];
  } else {
    options = INITIAL_ROUNDS[next];
  }

  await setDoc(doc(db, "sessions", code, "rounds", String(next)), {
    round: next,
    options,
    status: "voting",
    winner: null,
    totals: {},
  });
  await updateDoc(doc(db, "sessions", code), {
    currentRound: next,
    status: "voting",
  });
}

async function finishRoom() {
  await updateDoc(doc(db, "sessions", code), {
    status: "finished",
    finishedAt: serverTimestamp(),
  });
  showToast("場次已完成");
}

function renderHostVote() {
  if (!roomData || !roundData) {
    hostVotePanel.innerHTML = `<p class="center muted">主持人也可以在這裡投票。</p>`;
    return;
  }

  if (roomData.status === "setup") {
    hostVotePanel.innerHTML = `<p class="center muted">開放投票後，主持人也可以直接在這裡投票。</p>`;
    return;
  }

  if (roomData.status === "finished") {
    renderHostFinal();
    return;
  }

  const roundNumber = roomData.currentRound;
  const options = roundData.options || [];

  if (roomData.status === "voting") {
    hostVotePanel.innerHTML = `
      <h2 class="vote-title">主持人投票｜第 ${roundNumber} 階段</h2>
      <p class="vote-subtitle">${myVote ? "你已投票" : "點圖片立即送出，不能更改"}</p>
      <div id="hostCandidates" class="candidates"></div>`;
    const list = hostVotePanel.querySelector("#hostCandidates");
    options.forEach((id) => {
      const selected = myVote?.choice === id;
      const card = renderCandidateCard(id, candidates[id], {
        selected,
        dim: !!myVote && !selected,
        disabled: !!myVote || voteInFlight,
      });
      card.onclick = async () => {
        if (myVote || voteInFlight) return;
        voteInFlight = true;
        [...list.querySelectorAll(".candidate-card")].forEach((c) => {
          c.disabled = true;
          if (c.dataset.candidate !== id) c.classList.add("is-dimmed");
          else c.classList.add("is-selected");
        });
        try {
          await castVote(code, roundNumber, id, participantId, "host");
          myVote = { uid: participantId, round: roundNumber, choice: id };
          showToast("主持人投票成功");
          refreshStats();
        } catch (err) {
          myVote = await getMyVote(code, roundNumber, participantId);
          if (!myVote) showToast("投票失敗，請再試一次");
        }
        voteInFlight = false;
        renderHostVote();
      };
      list.appendChild(card);
    });
    return;
  }

  if (roomData.status === "results") {
    const totals = roundData.totals || {};
    const total = options.reduce((n, id) => n + (totals[id] || 0), 0);
    hostVotePanel.innerHTML = `<h2 class="vote-title">第 ${roundNumber} 階段公開結果</h2><div id="hostResultList"></div>`;
    const list = hostVotePanel.querySelector("#hostResultList");
    options.forEach((id) => {
      const wrap = document.createElement("div");
      wrap.className = "candidate-result";
      wrap.appendChild(renderCandidateCard(id, candidates[id], {
        dim: roundData.winner !== id,
        selected: roundData.winner === id,
        disabled: true,
      }));
      const line = document.createElement("div");
      line.className = "result-line";
      line.innerHTML = `<span>${totals[id] || 0} 票</span><strong>${formatPercent(totals[id] || 0, total)}</strong>`;
      wrap.appendChild(line);
      list.appendChild(wrap);
    });
  }
}

let hostFinalRenderKey = "";

async function renderHostFinal() {
  if (!code || !participantId) return;
  const renderKey = `${code}:${roomData?.finishedAt?.seconds || "finished"}`;
  if (hostFinalRenderKey === renderKey && hostVotePanel.querySelector("#hostFinalRoundList")) return;
  hostFinalRenderKey = renderKey;

  hostVotePanel.innerHTML = `<p class="center muted">正在整理最終投票結果……</p>`;

  try {
    const myVotes = await getAllMyVotes(code, participantId);
    const rows = [];
    let same = 0;
    let counted = 0;

    for (let round = 1; round <= 5; round++) {
      const snap = await getDoc(doc(db, "sessions", code, "rounds", String(round)));
      if (!snap.exists()) continue;
      const data = snap.data();
      const mine = myVotes[round];
      if (mine) {
        counted++;
        if (mine === data.winner) same++;
      }
      rows.push({
        round,
        mine,
        winner: data.winner,
        options: data.options || [],
        totals: data.totals || {},
        tieBreak: !!data.tieBreak,
      });
    }

    hostVotePanel.innerHTML = `
      <div class="center final-heading">
        <h2>最終全體結果</h2>
        <p class="muted">主持人的選擇命中全體結果 <strong>${counted ? Math.round((same / counted) * 100) : 0}%（${same}/${counted}）</strong></p>
      </div>
      <div id="hostFinalRoundList" class="final-round-list"></div>`;

    const list = hostVotePanel.querySelector("#hostFinalRoundList");
    rows.forEach((row) => list.appendChild(buildHostFinalRoundCard(row)));
  } catch (err) {
    hostFinalRenderKey = "";
    hostVotePanel.innerHTML = `<p class="center muted">最終結果讀取失敗，請重新整理頁面。</p>`;
  }
}

function buildHostFinalRoundCard({ round, mine, winner, options, totals, tieBreak }) {
  const card = document.createElement("section");
  card.className = "final-round-card";
  const totalVotes = options.reduce((sum, id) => sum + (totals[id] || 0), 0);

  const mineVisual = mine && candidates[mine]
    ? `<span class="choice-visual"><span class="choice-color candidate-${mine}"></span><img class="choice-thumb" src="${candidates[mine].imageData}" alt="你的選擇"></span>`
    : `<span class="choice-empty">未投票</span>`;
  const winnerVisual = winner && candidates[winner]
    ? `<span class="choice-visual"><span class="choice-color candidate-${winner}"></span><img class="choice-thumb" src="${candidates[winner].imageData}" alt="全體結果"></span>`
    : `<span class="choice-empty">—</span>`;

  card.innerHTML = `
    <h3>第 ${round} 階段</h3>
    <div class="final-choice-line"><span>你的選擇</span><strong>${mineVisual}</strong></div>
    <div class="final-choice-line"><span>全體結果</span><strong>${winnerVisual}${tieBreak ? '<small class="tie-note">同票抽選</small>' : ''}</strong></div>
    <div class="final-bar" aria-label="第 ${round} 階段投票比例"></div>
    <div class="final-legend"></div>`;

  const bar = card.querySelector(".final-bar");
  const legend = card.querySelector(".final-legend");
  options.forEach((id) => {
    const votes = totals[id] || 0;
    const percent = totalVotes ? (votes / totalVotes) * 100 : 0;

    const segment = document.createElement("div");
    segment.className = `final-bar-segment candidate-${id}`;
    segment.style.width = `${percent}%`;
    segment.title = `${votes} 票（${formatPercent(votes, totalVotes)}）`;
    bar.appendChild(segment);

    const item = document.createElement("div");
    item.className = "final-legend-item";
    item.innerHTML = `
      <span class="legend-swatch candidate-${id}"></span>
      <img class="legend-thumb" src="${candidates[id]?.imageData || ""}" alt="候選圖片">
      <span>${votes} 票</span>
      <span>${formatPercent(votes, totalVotes)}</span>`;
    legend.appendChild(item);
  });
  return card;
}

copyLinkBtn.addEventListener("click", async () => {
  const voterUrl = new URL("../", location.href);
  voterUrl.searchParams.set("room", code);
  await navigator.clipboard.writeText(voterUrl.href);
  showToast("已複製投票連結");
});

newRoomBtn.addEventListener("click", () => {
  if (!confirm("要離開目前主持場次並建立另一場嗎？目前場次不會被刪除。")) return;
  localStorage.removeItem("vote_host_room");
  location.reload();
});

createRoomBtn.addEventListener("click", createRoom);
createDefaultRoomBtn.addEventListener("click", createDefaultRoom);

(async () => {
  createPickers();
  const user = await ensureAuth();
  uid = user.uid;
  participantId = makeParticipantId(uid, "host");

  const saved = localStorage.getItem("vote_host_room");
  if (saved) {
    const opened = await openHostRoom(saved);
    if (!opened) setupMessage.textContent = "找不到之前的主持場次，可以建立新場次。";
  }
})();
