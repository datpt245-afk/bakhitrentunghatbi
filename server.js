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
  3: { name: "Vấp đá", desc: "Vịt đâm vào hòn đá, mất 1 điểm và lùi 1 ô.", rare: false },
  4: { name: "Hoán đổi điểm", desc: "Đổi toàn bộ điểm với một đội khác.", rare: false },
  5: { name: "Tăng tốc", desc: "Vịt của đội tiến 3 ô và nhận thêm 3 điểm.", rare: false },
  6: { name: "Cân bằng điểm", desc: "Điểm của đội được đưa về bằng với đội đang có ít điểm nhất.", rare: true }
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
  scoring: { teamStep: 2, personalPoint: 1 },
  boxStats: { openedSince4: 0, openedSince6: 0, selected4: 0, selected6: 0 },
  lastStealTarget: null,
  buffQuestionIndexes: []
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

function randomizeBuffQuestions() {
  const count = Math.min(12, game.questions.length);
  const indexes = Array.from({ length: game.questions.length }, (_, i) => i);
  for (let i = indexes.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indexes[i], indexes[j]] = [indexes[j], indexes[i]];
  }
  game.buffQuestionIndexes = indexes.slice(0, count).sort((a, b) => a - b);
}

function currentQuestionHasBuff() {
  return game.buffQuestionIndexes.includes(game.currentQuestion);
}

function triggerNextQuestion() {
  clearPending();
  game.answerRevealed = false;
  game.activeResponder = null;
  game.lockedGroups = [];
  if (game.currentQuestion + 1 < game.questions.length) {
    if (game.currentQuestion === -1 || !game.buffQuestionIndexes.length) randomizeBuffQuestions();
    game.currentQuestion++;
    game.questionOpen = true;
    io.emit("questionOpened", {
      index: game.currentQuestion,
      question: game.questions[game.currentQuestion],
      hasBuff: currentQuestionHasBuff()
    });
  } else {
    game.questionOpen = false;
    const ranking = Object.entries(game.teams)
      .map(([group, team]) => ({ group, name: team.name, duckPos: Number(team.duckPos) || 0, score: Number(team.score) || 0 }))
      .sort((a, b) => b.duckPos - a.duckPos || b.score - a.score);
    io.emit("gameFinished", { ranking, winner: ranking[0] || null });
  }
  io.emit("state", snapshot());
}

function teamRanking() {
  return Object.keys(game.teams).sort((a, b) => {
    const scoreDiff = (Number(game.teams[b].score) || 0) - (Number(game.teams[a].score) || 0);
    if (scoreDiff !== 0) return scoreDiff;
    return Number(b) - Number(a);
  });
}

function buff6WeightForGroup(group) {
  const rank = teamRanking().indexOf(String(group)) + 1;
  // Buff 6 is a balancing buff: strongly favor the teams currently in 1st/2nd.
  return [8, 5, 2, 0.7, 0.2][rank - 1] || 0.2;
}

function weightedBuffForGroup(group) {
  const weights = { 1: 25, 2: 25, 3: 23, 4: 7, 5: 18, 6: 2 * buff6WeightForGroup(group) };
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (const id of [1,2,3,4,5,6]) {
    r -= weights[id];
    if (r <= 0) return id;
  }
  return 1;
}

function makeBuffChoices(group) {
  game.boxStats.openedSince4 += 1;
  game.boxStats.openedSince6 += 1;

  // Pity system: if a rare buff has gone unchosen for too long, all 3 boxes become it.
  // This still only affects the random selection INSIDE the blind boxes.
  if (game.boxStats.selected4 < 2 && game.boxStats.openedSince4 >= 12) {
    return [4, 4, 4];
  }
  const responderRank = teamRanking().indexOf(String(group)) + 1;
  if (game.boxStats.selected6 < 1 && game.boxStats.openedSince6 >= 20 && responderRank <= 2) {
    return [6, 6, 6];
  }

  return [weightedBuffForGroup(group), weightedBuffForGroup(group), weightedBuffForGroup(group)];
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
  const hasBuff = currentQuestionHasBuff();
  io.emit("result", {
    correct: true,
    name: r.name,
    group: g,
    teamStep: base,
    personalPoint: Math.max(1, Number(game.scoring.personalPoint) || 1),
    hasBuff
  });

  if (hasBuff) {
    const buffChoices = makeBuffChoices(g);
    game.pendingBuff = { group: g, name: r.name, buffChoices, chosen: false, target: null };
    io.emit("buffChoiceOpened", { group: g, name: r.name, choices: buffChoices });
  } else {
    game.pendingBuff = null;
  }
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
    // Sau khi đã chọn và áp dụng buff, cho phép MC chuyển câu ngay cả khi
    // client MC chưa kịp nhận state cuối cùng. Buff 4 vẫn phải chọn mục tiêu trước.
    if (game.pendingBuff && game.pendingBuff.chosen && game.pendingBuff.buffId !== 4) {
      finishBuff();
    }
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
    const buffId = p.buffChoices[Number(choice)];
    p.buffId = buffId;
    if (buffId === 4) game.boxStats.selected4 += 1;
    if (buffId === 6) game.boxStats.selected6 += 1;
    if (buffId === 4) game.boxStats.openedSince4 = 0;
    if (buffId === 6) game.boxStats.openedSince6 = 0;
    io.emit("buffRevealed", { group: p.group, name: p.name, choice: Number(choice), buffId, buff: BUFFS[buffId], choices: p.buffChoices });
    io.emit("buffRevealedMC", { group: p.group, name: p.name, choice: Number(choice), buffId, buff: BUFFS[buffId], choices: p.buffChoices });
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
    io.emit("buffApplied", { group: from, buffId: 4, targetGroup: to });
    finishBuff();
  });

  function applyBuff1(p) {
    let choices = otherGroups(p.group).filter(g => game.teams[g].score > 0);
    if (choices.length > 1 && game.lastStealTarget && choices.includes(String(game.lastStealTarget))) {
      choices = choices.filter(g => g !== String(game.lastStealTarget));
    }
    if (choices.length) {
      const target = choices[Math.floor(Math.random() * choices.length)];
      game.lastStealTarget = target;
      const amount = Math.min(2, game.teams[target].score);
      game.teams[target].score -= amount;
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
    const team = game.teams[p.group];
    const hitPos = Number(team.duckPos) || 0;
    team.score = Math.max(0, Number(team.score) - 1);
    io.emit("buffApplied", { group: p.group, buffId: 3, amount: -1, scoreLost: 1, hitPos });
    finishBuff();
  }
  function applyBuff5(p) {
    const team = game.teams[p.group];
    const amount = 3;
    team.score += amount;
    team.duckPos += amount;
    io.emit("buffApplied", { group: p.group, buffId: 5, amount, scoreAdded: amount });
    finishBuff();
  }
  function applyBuff6(p) {
    const ranked = teamRanking();
    const lowestScore = Math.min(...Object.values(game.teams).map(t => Number(t.score) || 0));
    const lowestGroups = ranked.filter(g => (Number(game.teams[g].score) || 0) === lowestScore);
    const target = lowestGroups[Math.floor(Math.random() * lowestGroups.length)];
    const team = game.teams[p.group];
    const oldScore = Number(team.score) || 0;
    team.score = lowestScore;
    io.emit("buffApplied", { group: p.group, buffId: 6, targetGroup: target, oldScore, newScore: lowestScore });
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
    game.boxStats = { openedSince4: 0, openedSince6: 0, selected4: 0, selected6: 0 };
    game.lastStealTarget = null;
    game.buffQuestionIndexes = [];
    io.emit("fullReset");
    io.emit("state", snapshot());
  });
});

server.listen(PORT, () => console.log(`🚀 Server đang chạy tại port ${PORT}`));
