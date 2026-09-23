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

const TEAM_IDS = ["1", "2", "4", "5", "6"];

const BUFFS = {
  1: "Cướp 2 điểm",
  2: "Nhân đôi điểm",
  3: "Vấp đá",
  4: "Hoán đổi điểm",
  5: "Tăng tốc",
  6: "Cân bằng điểm"
};

let game = {
  teams: {
    1: { name: "Nhóm 1", score: 0, correct: 0, duckPos: 0, members: {} },
    2: { name: "Nhóm 2", score: 0, correct: 0, duckPos: 0, members: {} },
    4: { name: "Nhóm 4", score: 0, correct: 0, duckPos: 0, members: {} },
    5: { name: "Nhóm 5", score: 0, correct: 0, duckPos: 0, members: {} },
    6: { name: "Nhóm 6", score: 0, correct: 0, duckPos: 0, members: {} }
  },

  questions: [],
  currentQuestion: -1,
  questionOpen: false,
  activeResponder: null,
  lockedGroups: [],
  answerRevealed: false,

  buffQuestionIndexes: [],
  selectedBuffs: [],
  lastStealTarget: null,
  openedSince4: 0,
  openedSince6: 0,

  scoring: {
    teamStep: 2,
    personalPoint: 1
  }
};

let autoNextTimer = null;
let answerTimeout = null;


/* =========================================================
   LOAD / SAVE QUESTIONS
========================================================= */

function loadQuestions() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      const parsed = JSON.parse(raw);

      if (Array.isArray(parsed)) {
        game.questions = parsed;
      }
    }

    console.log(`[DATA] Đã tải ${game.questions.length} câu hỏi.`);
  } catch (err) {
    console.error("[DATA] Không thể tải questions.json:", err.message);
    game.questions = [];
  }
}

function saveQuestionsToFile() {
  try {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify(game.questions, null, 2),
      "utf8"
    );
  } catch (err) {
    console.error("[DATA] Không thể lưu questions.json:", err.message);
  }
}

loadQuestions();


/* =========================================================
   SNAPSHOT
========================================================= */

function snapshot() {
  return {
    teams: game.teams,
    questions: game.questions,
    currentQuestion: game.currentQuestion,
    questionOpen: game.questionOpen,
    activeResponder: game.activeResponder,
    lockedGroups: game.lockedGroups,
    answerRevealed: game.answerRevealed,

    buffQuestionIndexes: game.buffQuestionIndexes,
    selectedBuffs: game.selectedBuffs,

    scoring: game.scoring
  };
}


/* =========================================================
   HELPER
========================================================= */

function clearTimers() {
  if (autoNextTimer) {
    clearTimeout(autoNextTimer);
    autoNextTimer = null;
  }

  if (answerTimeout) {
    clearTimeout(answerTimeout);
    answerTimeout = null;
  }
}

function otherGroups(group) {
  const g = String(group);

  return TEAM_IDS.filter(id => id !== g);
}

function randomChoice(arr) {
  if (!arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle(arr) {
  const result = [...arr];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}


/* =========================================================
   RANDOM 12 CÂU CÓ BUFF
========================================================= */

function randomizeBuffQuestions() {
  const indexes = [];

  for (let i = 0; i < game.questions.length; i++) {
    indexes.push(i);
  }

  game.buffQuestionIndexes = shuffle(indexes).slice(
    0,
    Math.min(12, game.questions.length)
  );

  console.log(
    "[BUFF QUESTIONS]",
    game.buffQuestionIndexes.map(i => i + 1)
  );
}

function isBuffQuestion(index) {
  return game.buffQuestionIndexes.includes(index);
}


/* =========================================================
   CHUYỂN CÂU
   QUAN TRỌNG:
   MC BẤM CHUYỂN CÂU -> CHUYỂN NGAY
========================================================= */

function triggerNextQuestion() {
  clearTimers();

  /*
   * Nếu chưa có bộ 12 câu buff cho game hiện tại
   * thì random một lần.
   */
  if (game.buffQuestionIndexes.length === 0) {
    randomizeBuffQuestions();
  }

  const nextIndex = game.currentQuestion + 1;

  if (nextIndex < game.questions.length) {
    game.currentQuestion = nextIndex;

    game.questionOpen = true;
    game.activeResponder = null;
    game.lockedGroups = [];
    game.answerRevealed = false;

    io.emit("questionOpened", {
      index: game.currentQuestion,
      question: game.questions[game.currentQuestion],
      hasBuff: isBuffQuestion(game.currentQuestion)
    });

    io.emit("state", snapshot());

    console.log(
      `[QUESTION] Mở câu ${game.currentQuestion + 1}/${game.questions.length}`
    );

    return;
  }

  /*
   * HẾT CÂU
   */

  game.questionOpen = false;
  game.activeResponder = null;
  game.answerRevealed = true;

  const ranking = Object.entries(game.teams)
    .map(([group, team]) => ({
      group,
      name: team.name,
      score: team.score,
      duckPos: team.duckPos ?? team.score
    }))
    .sort((a, b) => {
      if (b.duckPos !== a.duckPos) {
        return b.duckPos - a.duckPos;
      }

      return b.score - a.score;
    });

  io.emit("gameFinished", ranking);

  io.emit("state", snapshot());

  console.log("[GAME] Đã hết câu hỏi.");
}


/*
 * Alias cho tương thích với code cũ.
 */
function nextQuestionImmediately() {
  triggerNextQuestion();
}


/* =========================================================
   BUFF WEIGHT
========================================================= */

function getTeamRank(group) {
  const ranking = Object.entries(game.teams)
    .sort((a, b) => {
      const scoreA = a[1].score || 0;
      const scoreB = b[1].score || 0;

      return scoreB - scoreA;
    })
    .map(([id]) => id);

  const index = ranking.indexOf(String(group));

  return index === -1 ? TEAM_IDS.length : index + 1;
}

function weightedBuffForGroup(group) {
  /*
   * Buff:
   * 1 = 25%
   * 2 = 25%
   * 3 = 23%
   * 4 = 7%
   * 5 = 18%
   * 6 = 2%
   */

  const weights = {
    1: 25,
    2: 25,
    3: 23,
    4: 7,
    5: 18,
    6: 2
  };

  const rank = getTeamRank(group);

  /*
   * Buff 6 dễ xuất hiện hơn cho nhóm đang đứng top.
   */
  if (rank <= 2) {
    weights[6] += 5;
    weights[1] -= 2;
    weights[2] -= 2;
    weights[3] -= 1;
  }

  /*
   * Nếu chưa có Buff 4 đủ lâu,
   * tăng mạnh khả năng Buff 4.
   */
  if (game.openedSince4 >= 12 && game.selectedBuffs.filter(x => x === 4).length < 2) {
    return 4;
  }

  /*
   * Buff 6 pity.
   */
  if (
    game.openedSince6 >= 20 &&
    game.selectedBuffs.filter(x => x === 6).length < 1 &&
    rank <= 2
  ) {
    return 6;
  }

  const entries = Object.entries(weights);

  const total = entries.reduce(
    (sum, [, weight]) => sum + Math.max(0, weight),
    0
  );

  let random = Math.random() * total;

  for (const [buffId, weight] of entries) {
    random -= Math.max(0, weight);

    if (random <= 0) {
      return Number(buffId);
    }
  }

  return 1;
}


/* =========================================================
   RANDOM 3 HỘP BUFF
========================================================= */

function createBuffBoxes(group) {
  game.openedSince4++;
  game.openedSince6++;

  const boxes = [];

  for (let i = 0; i < 3; i++) {
    boxes.push(weightedBuffForGroup(group));
  }

  /*
   * Nếu pity đang bắt buộc,
   * cả 3 hộp đều cùng buff.
   */

  if (
    game.openedSince4 >= 12 &&
    game.selectedBuffs.filter(x => x === 4).length < 2
  ) {
    boxes[0] = 4;
    boxes[1] = 4;
    boxes[2] = 4;
  }

  const rank = getTeamRank(group);

  if (
    game.openedSince6 >= 20 &&
    game.selectedBuffs.filter(x => x === 6).length < 1 &&
    rank <= 2
  ) {
    boxes[0] = 6;
    boxes[1] = 6;
    boxes[2] = 6;
  }

  return boxes;
}


/* =========================================================
   JOIN
========================================================= */

io.on("connection", socket => {
  socket.emit("state", snapshot());

  /*
   * JOIN MEMBER
   */

  socket.on("joinMember", ({ group, name }) => {
    const g = String(group);
    const mName = String(name || "").trim();

    if (!game.teams[g] || !mName) {
      return;
    }

    if (!game.teams[g].members[mName]) {
      game.teams[g].members[mName] = {
        score: 0,
        correct: 0
      };
    }

    socket.data.group = g;
    socket.data.name = mName;

    socket.emit("joined", {
      group: g,
      name: mName
    });

    io.emit("state", snapshot());
  });


  /* =======================================================
     SAVE QUESTIONS
  ======================================================= */

  socket.on("saveQuestions", questions => {
    if (!Array.isArray(questions)) {
      return;
    }

    game.questions = questions
      .map(q => ({
        q: String(q.q || "").trim(),

        options: Array.isArray(q.options)
          ? q.options
              .slice(0, 4)
              .map(x => String(x).trim())
          : [],

        answer: Math.max(
          0,
          Math.min(3, Number(q.answer) || 0)
        )
      }))
      .filter(q =>
        q.q &&
        q.options.length === 4 &&
        q.options.every(Boolean)
      );

    saveQuestionsToFile();

    /*
     * Nếu đang ở trạng thái chưa bắt đầu,
     * reset bộ buff để lần bắt đầu mới random lại.
     */
    if (game.currentQuestion === -1) {
      game.buffQuestionIndexes = [];
    }

    io.emit("questionsSaved", game.questions);
    io.emit("state", snapshot());
  });


  /* =======================================================
     MC CHUYỂN CÂU NGAY
  ======================================================= */

  socket.on("nextQuestion", () => {
    console.log(
      `[MC] Yêu cầu chuyển câu từ socket ${socket.id}`
    );

    /*
     * KHÔNG kiểm tra:
     * - activeResponder
     * - questionOpen
     * - answerRevealed
     * - buff
     *
     * MC bấm là chuyển ngay.
     */

    triggerNextQuestion();
  });


  /*
   * Tương thích tên event cũ
   */

  socket.on("skipQuestion", () => {
    triggerNextQuestion();
  });


  /* =======================================================
     BUZZ
  ======================================================= */

  socket.on("buzz", ({ group, name }) => {
    const g = String(group);
    const mName = String(name || "").trim();

    if (!game.questionOpen) {
      return;
    }

    if (!game.teams[g]) {
      return;
    }

    if (game.activeResponder) {
      return;
    }

    if (game.lockedGroups.includes(g)) {
      return;
    }

    game.activeResponder = {
      group: g,
      name: mName
    };

    io.emit("buzzed", {
      group: g,
      name: mName
    });

    socket.emit("answerAccess", {
      group: g,
      name: mName,
      question: game.questions[game.currentQuestion]
    });

    io.emit("state", snapshot());

    /*
     * Người bấm chuông có 5 giây để trả lời.
     */

    if (answerTimeout) {
      clearTimeout(answerTimeout);
    }

    answerTimeout = setTimeout(() => {
      if (
        game.activeResponder &&
        game.activeResponder.group === g
      ) {
        handleTimeout(mName, g);
      }
    }, 5000);
  });


  /* =======================================================
     SUBMIT ANSWER
  ======================================================= */

  socket.on(
    "submitAnswer",
    ({ index, name, group }) => {
      const g = String(group);

      if (
        !game.activeResponder ||
        game.activeResponder.group !== g
      ) {
        return;
      }

      if (answerTimeout) {
        clearTimeout(answerTimeout);
        answerTimeout = null;
      }

      const question =
        game.questions[game.currentQuestion];

      if (!question) {
        return;
      }

      const selected = Number(index);

      /*
       * ĐÚNG
       */

      if (selected === Number(question.answer)) {
        awardCorrect(g, name);
      }

      /*
       * SAI
       */

      else {
        awardWrong(g, name);
      }
    }
  );


  /* =======================================================
     MC CHỌN ĐÁP ÁN
     MC có thể chọn A/B/C/D trực tiếp.
  ======================================================= */

  socket.on(
    "chooseAnswer",
    ({ index }) => {
      const g =
        game.activeResponder &&
        String(game.activeResponder.group);

      if (!g) {
        return;
      }

      const question =
        game.questions[game.currentQuestion];

      if (!question) {
        return;
      }

      const selected = Number(index);

      if (answerTimeout) {
        clearTimeout(answerTimeout);
        answerTimeout = null;
      }

      if (selected === Number(question.answer)) {
        awardCorrect(
          g,
          game.activeResponder.name
        );
      } else {
        awardWrong(
          g,
          game.activeResponder.name
        );
      }
    }
  );


  /* =======================================================
     CHỌN BUFF
  ======================================================= */

  socket.on(
    "chooseBuff",
    ({ boxIndex, group }) => {
      const g = String(group);

      if (!game.teams[g]) {
        return;
      }

      if (!isBuffQuestion(game.currentQuestion)) {
        return;
      }

      const boxes = createBuffBoxes(g);

      const index = Number(boxIndex);

      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= boxes.length
      ) {
        return;
      }

      const buffId = boxes[index];

      game.selectedBuffs.push(buffId);

      /*
       * Reset bộ đếm pity tương ứng.
       */

      if (buffId === 4) {
        game.openedSince4 = 0;
      }

      if (buffId === 6) {
        game.openedSince6 = 0;
      }

      io.emit("buffRevealed", {
        group: g,
        boxIndex: index,
        buffId,
        buffName: BUFFS[buffId]
      });

      applyBuff(g, buffId);
    }
  );


  /* =======================================================
     RESET GAME
  ======================================================= */

  socket.on("resetGame", () => {
    clearTimers();

    for (const id of TEAM_IDS) {
      if (!game.teams[id]) continue;

      game.teams[id].score = 0;
      game.teams[id].correct = 0;
      game.teams[id].duckPos = 0;
      game.teams[id].members = {};
    }

    game.currentQuestion = -1;
    game.questionOpen = false;
    game.activeResponder = null;
    game.lockedGroups = [];
    game.answerRevealed = false;

    game.buffQuestionIndexes = [];
    game.selectedBuffs = [];
    game.lastStealTarget = null;

    game.openedSince4 = 0;
    game.openedSince6 = 0;

    io.emit("fullReset");
    io.emit("state", snapshot());

    console.log("[GAME] Reset game.");
  });


  /*
   * Compatibility
   */

  socket.on("reset", () => {
    clearTimers();

    game.currentQuestion = -1;
    game.questionOpen = false;
    game.activeResponder = null;
    game.lockedGroups = [];
    game.answerRevealed = false;

    game.buffQuestionIndexes = [];
    game.selectedBuffs = [];

    io.emit("state", snapshot());
  });
});


/* =========================================================
   TIMEOUT
========================================================= */

function handleTimeout(name, group) {
  const g = String(group);

  if (!game.activeResponder) {
    return;
  }

  if (game.activeResponder.group !== g) {
    return;
  }

  game.lockedGroups.push(g);
  game.activeResponder = null;

  io.emit("wrong", {
    name,
    group: g,
    timedOut: true
  });

  /*
   * Nếu tất cả nhóm đã sai:
   * hiện đáp án nhưng KHÔNG tự chuyển câu.
   *
   * MC vẫn có thể bấm "chuyển câu ngay".
   */

  if (game.lockedGroups.length >= TEAM_IDS.length) {
    game.questionOpen = false;
    game.answerRevealed = true;

    io.emit("questionSkipped");
  }

  io.emit("state", snapshot());
}


/* =========================================================
   ĐÚNG
========================================================= */

function awardCorrect(group, name) {
  const g = String(group);

  if (!game.teams[g]) {
    return;
  }

  const team = game.teams[g];

  team.score += game.scoring.teamStep;
  team.duckPos += game.scoring.teamStep;
  team.correct += 1;

  if (team.members[name]) {
    team.members[name].score +=
      game.scoring.personalPoint;

    team.members[name].correct += 1;
  }

  game.activeResponder = null;
  game.answerRevealed = true;
  game.questionOpen = false;

  io.emit("correct", {
    group: g,
    name,
    points: game.scoring.teamStep,
    hasBuff: isBuffQuestion(game.currentQuestion)
  });

  io.emit("state", snapshot());
}


/* =========================================================
   SAI
========================================================= */

function awardWrong(group, name) {
  const g = String(group);

  if (!game.lockedGroups.includes(g)) {
    game.lockedGroups.push(g);
  }

  game.activeResponder = null;

  io.emit("wrong", {
    group: g,
    name,
    timedOut: false
  });

  /*
   * Sau 3 giây cho các nhóm còn lại cướp chuông.
   */

  setTimeout(() => {
    if (
      game.questionOpen &&
      !game.activeResponder &&
      !game.lockedGroups.includes(g)
    ) {
      return;
    }

    if (
      game.questionOpen &&
      !game.activeResponder &&
      game.lockedGroups.length < TEAM_IDS.length
    ) {
      io.emit("resetBuzz");
      io.emit("state", snapshot());
    }
  }, 3000);

  /*
   * Nếu tất cả nhóm sai:
   * khóa câu và hiện đáp án.
   */

  if (game.lockedGroups.length >= TEAM_IDS.length) {
    game.questionOpen = false;
    game.answerRevealed = true;

    io.emit("questionSkipped");
  }

  io.emit("state", snapshot());
}


/* =========================================================
   APPLY BUFF
========================================================= */

function applyBuff(group, buffId) {
  const g = String(group);

  if (!game.teams[g]) {
    return;
  }

  const team = game.teams[g];

  /* -------------------------------------------------------
     BUFF 1 - CƯỚP 2 ĐIỂM
  ------------------------------------------------------- */

  if (buffId === 1) {
    const eligible = otherGroups(g).filter(id => {
      if (id === game.lastStealTarget) {
        return false;
      }

      return (game.teams[id].score || 0) > 0;
    });

    let candidates = eligible;

    if (!candidates.length) {
      candidates = otherGroups(g).filter(id =>
        (game.teams[id].score || 0) > 0
      );
    }

    if (!candidates.length) {
      io.emit("buffResult", {
        group: g,
        buffId,
        success: false,
        message: "Không có nhóm nào có điểm để cướp."
      });

      io.emit("state", snapshot());
      return;
    }

    const target = randomChoice(candidates);

    game.lastStealTarget = target;

    const stolen = Math.min(
      2,
      game.teams[target].score
    );

    game.teams[target].score -= stolen;
    game.teams[target].duckPos -= stolen;

    team.score += stolen;
    team.duckPos += stolen;

    io.emit("buffAction", {
      type: "steal",
      from: g,
      to: target,
      amount: stolen
    });

    io.emit("buffResult", {
      group: g,
      buffId,
      success: true,
      target,
      amount: stolen,
      message: `Nhóm ${g} cướp ${stolen} điểm từ Nhóm ${target}!`
    });

    io.emit("state", snapshot());
    return;
  }


  /* -------------------------------------------------------
     BUFF 2 - NHÂN ĐÔI ĐIỂM
  ------------------------------------------------------- */

  if (buffId === 2) {
    const amount = game.scoring.teamStep;

    team.score += amount;
    team.duckPos += amount;

    io.emit("buffResult", {
      group: g,
      buffId,
      success: true,
      amount,
      message: `Nhóm ${g} nhận thêm ${amount} điểm!`
    });

    io.emit("state", snapshot());
    return;
  }


  /* -------------------------------------------------------
     BUFF 3 - VẤP ĐÁ
  ------------------------------------------------------- */

  if (buffId === 3) {
    const lost = Math.min(1, Math.max(0, team.score));

    team.score -= lost;
    team.duckPos -= lost;

    io.emit("buffResult", {
      group: g,
      buffId,
      success: true,
      amount: lost,
      message: `Nhóm ${g} bị trừ ${lost} điểm!`
    });

    io.emit("state", snapshot());
    return;
  }


  /* -------------------------------------------------------
     BUFF 4 - HOÁN ĐỔI ĐIỂM
  ------------------------------------------------------- */

  if (buffId === 4) {
    const candidates = otherGroups(g);

    if (!candidates.length) {
      return;
    }

    const target = randomChoice(candidates);

    const scoreA = team.score;
    const scoreB = game.teams[target].score;

    const duckA = team.duckPos;
    const duckB = game.teams[target].duckPos;

    team.score = scoreB;
    game.teams[target].score = scoreA;

    team.duckPos = duckB;
    game.teams[target].duckPos = duckA;

    io.emit("buffAction", {
      type: "swap",
      from: g,
      to: target
    });

    io.emit("buffResult", {
      group: g,
      buffId,
      success: true,
      target,
      message: `Nhóm ${g} đã hoán đổi điểm với Nhóm ${target}!`
    });

    io.emit("state", snapshot());
    return;
  }


  /* -------------------------------------------------------
     BUFF 5 - TĂNG TỐC
  ------------------------------------------------------- */

  if (buffId === 5) {
    const amount = 3;

    team.score += amount;
    team.duckPos += amount;

    io.emit("buffResult", {
      group: g,
      buffId,
      success: true,
      amount,
      message: `Nhóm ${g} tăng tốc +3 điểm!`
    });

    io.emit("state", snapshot());
    return;
  }


  /* -------------------------------------------------------
     BUFF 6 - CÂN BẰNG ĐIỂM
  ------------------------------------------------------- */

  if (buffId === 6) {
    const scores = TEAM_IDS.map(id => ({
      id,
      score: game.teams[id].score || 0
    }));

    const lowestScore = Math.min(
      ...scores.map(x => x.score)
    );

    if (team.score <= lowestScore) {
      io.emit("buffResult", {
        group: g,
        buffId,
        success: false,
        message: `Nhóm ${g} đã ở mức điểm thấp nhất.`
      });

      io.emit("state", snapshot());
      return;
    }

    const oldScore = team.score;

    team.score = lowestScore;
    team.duckPos = lowestScore;

    io.emit("buffResult", {
      group: g,
      buffId,
      success: true,
      oldScore,
      newScore: lowestScore,
      message: `Nhóm ${g} được cân bằng về ${lowestScore} điểm.`
    });

    io.emit("state", snapshot());
  }
}


/* =========================================================
   SERVER
========================================================= */

server.listen(PORT, () => {
  console.log(`🦆 Duck Race server đang chạy tại port ${PORT}`);
});
