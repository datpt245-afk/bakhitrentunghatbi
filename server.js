const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "questions.json");

app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(__dirname));

const BUFFS = {
  1: { name: "Cướp 2 điểm", desc: "Trừ 2 điểm từ một đội khác được chọn ngẫu nhiên.", rare: false },
  2: { name: "Nhân đôi điểm", desc: "Nhân đôi số điểm vừa nhận từ câu hỏi này.", rare: false },
  3: { name: "Vấp đá", desc: "Vịt của đội lùi 1 ô.", rare: false },
  4: { name: "Hoán đổi điểm", desc: "Đổi toàn bộ điểm với một đội khác.", rare: false },
  5: { name: "Tăng tốc", desc: "Vịt của đội tiến 5 ô.", rare: false },
  6: { name: "Mất trắng", desc: "Mất toàn bộ điểm hiện có.", rare: true }
};

let game = {
  teams: {
    1: { name: "Nhóm 1", score: 0, correct: 0, duckPos: 0, members: {} },
    2: { name: "Nhóm 2", score: 0, correct: 0, duckPos: 0, members: {} },
    3: { name: "Nhóm 3", score: 0, correct: 0, duckPos: 0, members: {} },
    4: { name: "Nhóm 4", score: 0, correct: 0, duckPos: 0, members: {} },
    5: { name: "Nhóm 5", score: 0, correct: 0, duckPos: 0, members: {} }
  },
  questions: [],
  currentQuestion: -1,
  questionOpen: false,
  activeResponder: null,
  lockedGroups: [],
  pendingAnswer: null,
  wrongPending: null,
  answerRevealed: false,
  pendingBuff: null,
  scoring: { teamStep: 2, personalPoint: 1 }
};

function loadQuestions() {
  try {
    if (fs.existsSync(DATA_FILE)) game.questions = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (err) {
    game.questions = [];
  }
}
function saveQuestionsToFile() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(game.questions, null, 2), "utf8"); } catch (err) {}
}
loadQuestions();

function snapshot() {
  return {
    teams: game.teams,
    questions: game.questions,
    currentQuestion: game.currentQuestion,
    questionOpen: game.questionOpen,
    activeResponder: game.activeResponder,
    lockedGroups: game.lockedGroups,
    pendingAnswer: game.pendingAnswer,
    wrongPending: game.wrongPending,
    answerRevealed: game.answerRevealed,
    pendingBuff: game.pendingBuff,
    scoring: game.scoring
  };
}

function clearPending() {
  game.pendingAnswer = null;
  game.pendingBuff = null;
  game.wrongPending = null;
}

function triggerNextQuestion() {
  clearPending();
  game.answerRevealed = false;
  game.activeResponder = null;
  game.lockedGroups = [];
  if (game.currentQuestion + 1 < game.questions.length) {
    game.currentQuestion++;
    game.questionOpen = true;
    io.emit("questionOpened", { index: game.currentQuestion, question: game.questions[game.currentQuestion] });
  } else {
    game.questionOpen = false;
    io.emit("gameFinished");
  }
  io.emit("state", snapshot());
}

function randomBuff() {
  // Buff 1-5: 18.75% each; Buff 6: 6.25%.
  const pool = [1,1,1,2,2,2,3,3,3,4,4,4,5,5,5,6];
  return pool[Math.floor(Math.random() * pool.length)];
}

function otherGroups(group) {
  return Object.keys(game.teams).filter(g => g !== String(group));
}

function awardCorrect() {
  const r = game.activeResponder;
  if (!r || !game.pendingAnswer) return;
  const g = String(r.group);
  const team = game.teams[g];
  const base = Math.max(1, Number(game.scoring.teamStep) || 1);
  team.score += base;
  team.duckPos += base;
  team.correct += 1;
  if (team.members[r.name]) {
    team.members[r.name].score += Math.max(1, Number(game.scoring.personalPoint) || 1);
    team.members[r.name].correct += 1;
  }
  game.questionOpen = false;
  game.answerRevealed = true;
  const buffId = randomBuff();
  game.pendingBuff = { group: g, name: r.name, buffId, chosen: false, target: null };
  io.emit("result", {
    correct: true,
    name: r.name,
    group: g,
    teamStep: base,
    personalPoint: Math.max(1, Number(game.scoring.personalPoint) || 1)
  });
  io.emit("buffChoiceOpened", { group: g, name: r.name });
  io.emit("state", snapshot());
}

function awardWrong(timedOut = false) {
  const r = game.activeResponder;
  if (!r) return;
  const g = String(r.group);
  if (!game.lockedGroups.includes(g)) game.lockedGroups.push(g);
  game.activeResponder = null;
  game.pendingAnswer = null;
  game.wrongPending = { name: r.name, group: g };
  io.emit("wrong", { name: r.name, group: g, timedOut, canSteal: true });
  io.emit("state", snapshot());

  // Sau 3 giây, tự động nhường chuông cho các đội còn lại.
  setTimeout(() => {
    if (!game.wrongPending || String(game.wrongPending.group) !== g) return;
    game.wrongPending = null;
    game.questionOpen = true;
    game.activeResponder = null;
    game.pendingAnswer = null;
    io.emit("stealOpened", { message: "🔔 CHUÔNG NHƯỜNG CHO BẠN KHÁC!" });
    io.emit("state", snapshot());
  }, 3000);
}

io.on("connection", socket => {
  socket.emit("state", snapshot());

  socket.on("joinMember", ({ group, name }) => {
    const g = String(group);
    const mName = String(name || "").trim();
    if (game.teams[g] && mName) {
      if (!game.teams[g].members[mName]) game.teams[g].members[mName] = { score: 0, correct: 0 };
      socket.emit("joined", { group: g, name: mName });
      io.emit("state", snapshot());
    }
  });

  socket.on("saveQuestions", questions => {
    if (!Array.isArray(questions)) return;
    game.questions = questions.map(q => ({
      q: String(q.q || "").trim(),
      options: Array.isArray(q.options) ? q.options.slice(0,4).map(x => String(x).trim()) : [],
      answer: Math.max(0, Math.min(3, Number(q.answer) || 0))
    })).filter(q => q.q && q.options.length === 4 && q.options.every(Boolean));
    saveQuestionsToFile();
    io.emit("questionsSaved", game.questions);
    io.emit("state", snapshot());
  });

  socket.on("nextQuestion", () => {
    if (game.questionOpen || game.pendingBuff || game.pendingAnswer) return;
    triggerNextQuestion();
  });

  socket.on("buzz", ({ group, name }) => {
    const g = String(group);
    if (!game.questionOpen || game.activeResponder || game.lockedGroups.includes(g)) return;
    game.activeResponder = { group: g, name: String(name || ""), socketId: socket.id };
    game.pendingAnswer = null;
    io.emit("buzzed", { group: g, name: game.activeResponder.name });
    io.emit("state", snapshot());
  });

  // MC bấm trực tiếp vào A/B/C/D trên màn hình chiếu theo câu trả lời miệng.
  // Bấm một lần là hệ thống kiểm tra ngay, không có bước "kiểm tra" riêng.
  socket.on("mcSelectAnswer", ({ index }) => {
    if (!game.activeResponder || game.pendingAnswer || game.pendingBuff) return;
    const currentQ = game.questions[game.currentQuestion];
    if (!currentQ || !Number.isInteger(index) || index < 0 || index > 3) return;
    game.pendingAnswer = { index, name: game.activeResponder.name, group: String(game.activeResponder.group) };
    io.emit("answerSelected", game.pendingAnswer);
    const isCorrect = index === currentQ.answer;
    if (isCorrect) {
      awardCorrect();
    } else {
      awardWrong(false);
    }
  });

  // MC chooses whether to let remaining teams steal or skip to the next question.
  socket.on("allowSteal", () => {
    if (game.pendingBuff || !game.wrongPending) return;
    game.wrongPending = null;
    game.activeResponder = null;
    game.pendingAnswer = null;
    game.questionOpen = true;
    io.emit("stealOpened");
    io.emit("state", snapshot());
  });

  socket.on("skipQuestion", () => {
    if (game.pendingBuff) return;
    clearPending();
    game.answerRevealed = true;
    game.questionOpen = false;
    game.activeResponder = null;
    io.emit("questionSkipped");
    io.emit("state", snapshot());
  });

  socket.on("chooseBuff", ({ choice }) => {
    const p = game.pendingBuff;
    if (!p || p.chosen || Number(choice) < 0 || Number(choice) > 2) return;
    p.chosen = true;
    p.choice = Number(choice);
    io.emit("buffBoxChosen", { group: p.group, name: p.name, choice: Number(choice) });
    const buffId = p.buffId;
    io.emit("buffRevealed", { group: p.group, name: p.name, choice: Number(choice), buffId, buff: BUFFS[buffId] });
    io.emit("buffRevealedMC", { group: p.group, name: p.name, choice: Number(choice), buffId, buff: BUFFS[buffId] });
    if (buffId === 1) applyBuff1(p);
    else if (buffId === 2) applyBuff2(p);
    else if (buffId === 3) applyBuff3(p);
    else if (buffId === 5) applyBuff5(p);
    else if (buffId === 6) applyBuff6(p);
    // Buff 4 waits for the player to choose a target.
    io.emit("state", snapshot());
  });

  socket.on("chooseSwapTarget", ({ targetGroup }) => {
    const p = game.pendingBuff;
    if (!p || !p.chosen || p.buffId !== 4) return;
    const from = String(p.group), to = String(targetGroup);
    if (!game.teams[to] || to === from) return;
    const a = game.teams[from], b = game.teams[to];
    [a.score, b.score] = [b.score, a.score];
    [a.duckPos, b.duckPos] = [b.duckPos, a.duckPos];
    io.emit("buffApplied", { group: from, buffId: 4, targetGroup: to });
    finishBuff();
  });

  function applyBuff1(p) {
    const choices = otherGroups(p.group).filter(g => game.teams[g].score > 0);
    if (choices.length) {
      const target = choices[Math.floor(Math.random() * choices.length)];
      const amount = Math.min(2, game.teams[target].score);
      game.teams[target].score -= amount;
      game.teams[target].duckPos = Math.max(0, game.teams[target].duckPos - amount);
      game.teams[p.group].score += amount;
      game.teams[p.group].duckPos += amount;
      io.emit("buffApplied", { group: p.group, buffId: 1, targetGroup: target, amount });
    } else {
      io.emit("buffApplied", { group: p.group, buffId: 1, targetGroup: null, amount: 0 });
    }
    finishBuff();
  }
  function applyBuff2(p) {
    const amount = Math.max(1, Number(game.scoring.teamStep) || 1);
    game.teams[p.group].score += amount;
    game.teams[p.group].duckPos += amount;
    io.emit("buffApplied", { group: p.group, buffId: 2, amount });
    finishBuff();
  }
  function applyBuff3(p) {
    game.teams[p.group].duckPos = Math.max(0, game.teams[p.group].duckPos - 1);
    io.emit("buffApplied", { group: p.group, buffId: 3, amount: -1 });
    finishBuff();
  }
  function applyBuff5(p) {
    game.teams[p.group].duckPos += 5;
    io.emit("buffApplied", { group: p.group, buffId: 5, amount: 5 });
    finishBuff();
  }
  function applyBuff6(p) {
    game.teams[p.group].score = 0;
    game.teams[p.group].duckPos = 0;
    io.emit("buffApplied", { group: p.group, buffId: 6, amount: 0 });
    finishBuff();
  }
  function finishBuff() {
    const responderSocket = game.activeResponder?.socketId;
    if (responderSocket) io.to(responderSocket).emit("buffFinished", { group: game.pendingBuff?.group });
    game.pendingBuff = null;
    game.activeResponder = null;
    game.pendingAnswer = null;
    io.emit("state", snapshot());
  }

  socket.on("resetBuzz", () => {
    game.activeResponder = null;
    game.pendingAnswer = null;
    io.emit("resetBuzz");
    io.emit("state", snapshot());
  });

  socket.on("setScoring", ({ teamStep, personalPoint }) => {
    game.scoring.teamStep = Math.max(1, Number(teamStep) || 2);
    game.scoring.personalPoint = Math.max(1, Number(personalPoint) || 1);
    io.emit("state", snapshot());
  });

  socket.on("resetGame", () => {
    Object.keys(game.teams).forEach(g => {
      game.teams[g] = { name: `Nhóm ${g}`, score: 0, correct: 0, duckPos: 0, members: {} };
    });
    game.currentQuestion = -1;
    game.questionOpen = false;
    game.activeResponder = null;
    game.lockedGroups = [];
    game.pendingAnswer = null;
    game.wrongPending = null;
    game.answerRevealed = false;
    game.pendingBuff = null;
    io.emit("fullReset");
    io.emit("state", snapshot());
  });
});

server.listen(PORT, () => console.log(`🚀 Server đang chạy tại port ${PORT}`));
