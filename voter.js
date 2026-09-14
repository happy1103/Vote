import {
  auth,
  db,
  ensureAuth,
  normalizeCode,
  joinRoom,
  loadCandidateMap,
  subscribeRoom,
  subscribeRound,
  getMyVote,
  castVote,
  getAllMyVotes,
  doc,
  getDoc,
  renderCandidateCard,
  formatPercent,
} from "./shared.js";

const joinPanel = document.querySelector("#joinPanel");
const roomPanel = document.querySelector("#roomPanel");
const roomCodeInput = document.querySelector("#roomCodeInput");
const joinBtn = document.querySelector("#joinBtn");
const joinError = document.querySelector("#joinError");
const roomCodeText = document.querySelector("#roomCodeText");
const roomStatus = document.querySelector("#roomStatus");
const mainPanel = document.querySelector("#mainPanel");
const finalPanel = document.querySelector("#finalPanel");
const toast = document.querySelector("#toast");

let uid = null;
let code = null;
let roomData = null;
let roundData = null;
let candidates = {};
let myVote = null;
let unsubRoom = null;
let unsubRound = null;
let currentRoundSubscribed = null;
let voteInFlight = false;

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 1800);
}

function setStatus(text) {
  roomStatus.textContent = text;
}

function statusText(room) {
  if (!room) return "載入中";
  if (room.status === "finished") return "投票已結束";
  if (room.status === "setup") return "等待主持人開始";
  if (room.status === "voting") return `第 ${room.currentRound} 階段投票中`;
  if (room.status === "results") return `第 ${room.currentRound} 階段結果`;
  return "等待中";
}

async function join(codeToJoin) {
  joinBtn.disabled = true;
  joinError.textContent = "";
  try {
    await joinRoom(codeToJoin, uid);
    code = codeToJoin;
    candidates = await loadCandidateMap(code);
    roomCodeText.textContent = code;
    joinPanel.classList.add("hidden");
    roomPanel.classList.remove("hidden");
    history.replaceState(null, "", `?room=${code}`);
    subscribeToRoom();
  } catch (err) {
    joinError.textContent = err?.message || "加入失敗，請稍後再試";
  } finally {
    joinBtn.disabled = false;
  }
}

function subscribeToRoom() {
  unsubRoom?.();
  unsubRoom = subscribeRoom(
    code,
    async (snap) => {
      if (!snap.exists()) {
        mainPanel.innerHTML = `<p class="center">這個場次已不存在。</p>`;
        return;
      }
      roomData = snap.data();
      setStatus(statusText(roomData));

      if (roomData.status === "finished") {
        unsubRound?.();
        await renderFinal();
        return;
      }

      finalPanel.classList.add("hidden");
      mainPanel.classList.remove("hidden");

      if (roomData.status === "setup") {
        unsubRound?.();
        currentRoundSubscribed = null;
        mainPanel.innerHTML = `
          <div class="center stack">
            <h2>已加入場次</h2>
            <p class="muted">等待主持人開放第 1 階段投票……</p>
          </div>`;
        return;
      }

      if (currentRoundSubscribed !== roomData.currentRound) {
        subscribeToRound(roomData.currentRound);
      }
    },
    (err) => {
      mainPanel.innerHTML = `<p class="center">連線發生問題：${err.message}</p>`;
    }
  );
}

function subscribeToRound(roundNumber) {
  unsubRound?.();
  currentRoundSubscribed = roundNumber;
  myVote = null;
  unsubRound = subscribeRound(
    code,
    roundNumber,
    async (snap) => {
      roundData = snap.exists() ? snap.data() : null;
      myVote = await getMyVote(code, roundNumber, uid);
      renderRound();
    },
    (err) => {
      mainPanel.innerHTML = `<p class="center">無法讀取投票階段：${err.message}</p>`;
    }
  );
}

function renderRound() {
  if (!roundData || !roomData) {
    mainPanel.innerHTML = `<p class="center muted">準備中……</p>`;
    return;
  }

  const roundNumber = roomData.currentRound;
  if (roomData.status === "voting") {
    renderVoting(roundNumber);
  } else if (roomData.status === "results") {
    renderResults(roundNumber);
  }
}

function renderVoting(roundNumber) {
  const options = roundData.options || [];
  mainPanel.innerHTML = `
    <h2 class="vote-title">第 ${roundNumber} 階段</h2>
    <p class="vote-subtitle">${myVote ? "你已完成投票，等待主持人公布結果" : "點選圖片即完成投票，送出後不能更改"}</p>
    <div id="candidateList" class="candidates"></div>`;

  const list = mainPanel.querySelector("#candidateList");
  options.forEach((id) => {
    const selected = myVote?.choice === id;
    const dim = !!myVote && !selected;
    const card = renderCandidateCard(id, candidates[id], {
      selected,
      dim,
      disabled: !!myVote || voteInFlight,
    });

    card.addEventListener("click", async () => {
      if (myVote || voteInFlight) return;
      voteInFlight = true;
      const allCards = [...list.querySelectorAll(".candidate-card")];
      allCards.forEach((c) => {
        c.disabled = true;
        if (c.dataset.candidate !== id) c.classList.add("is-dimmed");
        else c.classList.add("is-selected");
      });

      try {
        await castVote(code, roundNumber, id, uid);
        myVote = { choice: id, round: roundNumber, uid };
        showToast("投票成功");
      } catch (err) {
        voteInFlight = false;
        myVote = await getMyVote(code, roundNumber, uid);
        if (myVote) {
          renderVoting(roundNumber);
          return;
        }
        showToast("投票失敗，請再試一次");
        renderVoting(roundNumber);
        return;
      }
      voteInFlight = false;
      renderVoting(roundNumber);
    });

    list.appendChild(card);
  });
}

function renderResults(roundNumber) {
  const options = roundData.options || [];
  const totals = roundData.totals || {};
  const totalVotes = options.reduce((sum, id) => sum + (totals[id] || 0), 0);
  const winner = roundData.winner;

  mainPanel.innerHTML = `
    <h2 class="vote-title">第 ${roundNumber} 階段結果</h2>
    <p class="vote-subtitle">共 ${totalVotes} 票</p>
    <div id="resultList"></div>
    <p class="center muted small">等待主持人進入下一階段……</p>`;

  const list = mainPanel.querySelector("#resultList");
  options.forEach((id) => {
    const wrap = document.createElement("div");
    wrap.className = "candidate-result";
    const card = renderCandidateCard(id, candidates[id], {
      dim: !!winner && winner !== id,
      selected: winner === id,
      disabled: true,
    });
    const line = document.createElement("div");
    line.className = "result-line";
    line.innerHTML = `<span>${totals[id] || 0} 票</span><strong>${formatPercent(totals[id] || 0, totalVotes)}</strong>`;
    wrap.append(card, line);
    list.appendChild(wrap);
  });
}

async function renderFinal() {
  mainPanel.classList.add("hidden");
  finalPanel.classList.remove("hidden");
  finalPanel.innerHTML = `<p class="center muted">正在整理你的投票結果……</p>`;

  const myVotes = await getAllMyVotes(code, uid);
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
    rows.push({ round, mine, winner: data.winner });
  }

  finalPanel.innerHTML = `
    <div class="center">
      <h2>全部投票完成</h2>
      <p class="muted">你的選擇與每階段勝出結果一致 ${same} / ${counted}</p>
    </div>
    <div id="comparisonList"></div>`;

  const list = finalPanel.querySelector("#comparisonList");
  rows.forEach(({ round, mine, winner }) => {
    const row = document.createElement("div");
    row.className = "comparison-row";
    row.innerHTML = `<strong>第 ${round} 階段</strong>`;

    const grid = document.createElement("div");
    grid.className = "comparison-grid";
    grid.style.marginTop = "10px";

    const mineCard = document.createElement("div");
    mineCard.className = "comparison-card";
    if (mine && candidates[mine]) {
      mineCard.innerHTML = `<img src="${candidates[mine].imageData}" alt="你的選擇"><div class="caption">你的選擇</div>`;
    } else {
      mineCard.innerHTML = `<div class="panel center muted" style="box-shadow:none;margin:0">未投票</div><div class="caption">你的選擇</div>`;
    }

    const winnerCard = document.createElement("div");
    winnerCard.className = "comparison-card";
    if (winner && candidates[winner]) {
      winnerCard.innerHTML = `<img src="${candidates[winner].imageData}" alt="全體結果"><div class="caption">全體結果</div>`;
    }

    grid.append(mineCard, winnerCard);
    row.appendChild(grid);
    list.appendChild(row);
  });
}

roomCodeInput.addEventListener("input", () => {
  roomCodeInput.value = normalizeCode(roomCodeInput.value);
});
roomCodeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinBtn.click();
});
joinBtn.addEventListener("click", () => {
  const value = normalizeCode(roomCodeInput.value);
  if (value.length !== 6) {
    joinError.textContent = "請輸入 6 位數場次代碼";
    return;
  }
  join(value);
});

(async () => {
  const user = await ensureAuth();
  uid = user.uid;
  const urlCode = normalizeCode(new URLSearchParams(location.search).get("room") || "");
  if (urlCode.length === 6) {
    roomCodeInput.value = urlCode;
    join(urlCode);
  }
})();
