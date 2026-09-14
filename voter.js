import {
  auth,
  db,
  ensureAuth,
  makeParticipantId,
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
let participantId = null;
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
  if (room.status === "results") return `第 ${room.currentRound} 階段已截止`;
  return "等待中";
}

async function join(codeToJoin) {
  joinBtn.disabled = true;
  joinError.textContent = "";
  try {
    await joinRoom(codeToJoin, participantId, "voter");
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
      } else {
        // 房間狀態（results → voting 等）可能會比 round 文件晚/早一步更新。
        // 即使目前訂閱的是同一個 round，也要重新依最新 room 狀態渲染，
        // 否則不同裝置在網路延遲下可能會停留在上一個畫面。
        renderRound();
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
  roundData = null;
  myVote = null;
  mainPanel.innerHTML = `<p class="center muted">正在載入第 ${roundNumber} 階段……</p>`;

  unsubRound = subscribeRound(
    code,
    roundNumber,
    async (snap) => {
      // 若主持人剛切換階段，room 與 round 的即時更新到達順序可能不同。
      // round 文件尚未到時先保持載入畫面；onSnapshot 之後會自動再觸發。
      if (!snap.exists()) {
        roundData = null;
        mainPanel.innerHTML = `<p class="center muted">正在同步第 ${roundNumber} 階段……</p>`;
        return;
      }

      roundData = snap.data();
      try {
        myVote = await getMyVote(code, roundNumber, participantId);
      } catch (err) {
        console.error("讀取個人投票失敗", err);
        myVote = null;
      }
      renderRound();
    },
    (err) => {
      console.error("round subscription error", err);
      mainPanel.innerHTML = `
        <div class="center stack">
          <p>無法讀取投票階段。</p>
          <p class="muted small">請確認網路連線後重新整理頁面。</p>
        </div>`;
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
        await castVote(code, roundNumber, id, participantId, "voter");
        myVote = { choice: id, round: roundNumber, uid: participantId };
        showToast("投票成功");
      } catch (err) {
        voteInFlight = false;
        myVote = await getMyVote(code, roundNumber, participantId);
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
  mainPanel.innerHTML = `
    <h2 class="vote-title">第 ${roundNumber} 階段已截止</h2>
    <p class="vote-subtitle">結果會在全部 5 個階段完成後一次公布</p>
    <div id="closedCandidateList" class="candidates"></div>
    <p class="center muted small" style="margin-top:14px">等待主持人進入下一階段……</p>`;

  const list = mainPanel.querySelector("#closedCandidateList");
  options.forEach((id) => {
    const selected = myVote?.choice === id;
    list.appendChild(renderCandidateCard(id, candidates[id], {
      selected,
      dim: !!myVote && !selected,
      disabled: true,
    }));
  });
}

async function renderFinal() {
  mainPanel.classList.add("hidden");
  finalPanel.classList.remove("hidden");
  finalPanel.classList.toggle("default-room-results", !!roomData?.defaultRoom);
  finalPanel.innerHTML = `<p class="center muted">正在整理最終投票結果……</p>`;

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

  finalPanel.innerHTML = `
    <div class="center final-heading">
      <h2>最終全體結果</h2>
      <p class="muted">你的選擇命中全體結果 <strong>${counted ? Math.round((same / counted) * 100) : 0}%（${same}/${counted}）</strong></p>
    </div>
    <div id="finalRoundList" class="final-round-list"></div>
    <div class="center" style="margin-top:18px">
      <button id="newGameBtn" class="btn" type="button">開啟新局</button>
    </div>`;

  const list = finalPanel.querySelector("#finalRoundList");
  rows.forEach((row) => list.appendChild(buildFinalRoundCard(row)));

  finalPanel.querySelector("#newGameBtn")?.addEventListener("click", returnToHome);
}

function returnToHome() {
  unsubRoom?.();
  unsubRound?.();
  unsubRoom = null;
  unsubRound = null;
  currentRoundSubscribed = null;

  code = null;
  roomData = null;
  roundData = null;
  candidates = {};
  myVote = null;
  voteInFlight = false;

  roomCodeInput.value = "";
  joinError.textContent = "";
  roomCodeText.textContent = "";
  setStatus("");
  mainPanel.innerHTML = "";
  finalPanel.innerHTML = "";

  roomPanel.classList.add("hidden");
  finalPanel.classList.add("hidden");
  mainPanel.classList.remove("hidden");
  joinPanel.classList.remove("hidden");

  history.replaceState(null, "", location.pathname);
  roomCodeInput.focus();
}

function buildFinalRoundCard({ round, mine, winner, options, totals, tieBreak }) {
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
  participantId = makeParticipantId(uid, "voter");
  const urlCode = normalizeCode(new URLSearchParams(location.search).get("room") || "");
  if (urlCode.length === 6) {
    roomCodeInput.value = urlCode;
    join(urlCode);
  }
})();
