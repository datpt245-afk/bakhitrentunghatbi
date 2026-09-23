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
  1: {
    name: "Cướp 2 điểm",
    desc: "Cướp tối đa 2 điểm từ một đội khác. Đội cướp tiến, đội bị cướp lùi theo số điểm bị mất.",
    rare: false
  },

  2: {
    name: "Nhân đôi điểm",
    desc: "Nhận thêm đúng số điểm vừa nhận từ câu hỏi.",
    rare: false
  },

  3: {
    name: "Vấp đá",
    desc: "Mất 1 điểm và vịt lùi 1 ô.",
    rare: false
  },

  4: {
    name: "Hoán đổi điểm",
    desc: "Hoán đổi toàn bộ điểm và vị trí với một đội khác.",
    rare: false
  },

  5: {
    name: "Tăng tốc",
    desc: "Vịt tiến 3 ô và nhận thêm 3 điểm.",
    rare: false
  },

  6: {
    name: "Cân bằng điểm",
    desc: "Điểm của đội được đưa xuống bằng đội đang có ít điểm nhất.",
    rare: true
  }
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

  scoring: {
    teamStep: 2,
    personalPoint: 1
  },

  boxStats: {
    openedSince4: 0,
    openedSince6: 0,
    selected4: 0,
    selected6: 0
  },

  lastStealTarget: null,

  // Random đúng 12 câu trong tổng số câu hỏi.
  buffQuestionIndexes: []
};


// ===============================
// QUESTIONS
// ===============================

function loadQuestions() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      game.questions = JSON.parse(
        fs.readFileSync(DATA_FILE, "utf8")
      );
    }
  } catch (err) {
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
  } catch (err) {}
}

loadQuestions();


// ===============================
// SNAPSHOT
// ===============================

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
    scoring: game.scoring,
    buffQuestionIndexes: game.buffQuestionIndexes
  };
}


// ===============================
// BASIC HELPERS
// ===============================

function clearPending() {
  game.pendingAnswer = null;
  game.pendingBuff = null;
  game.wrongPending = null;
}

function otherGroups(group) {
  return Object.keys(game.teams).filter(
    g => g !== String(group)
  );
}


// ===============================
// RANDOM 12 BUFF QUESTIONS
// ===============================

function randomizeBuffQuestions() {
  const total = game.questions.length;

  const count = Math.min(12, total);

  const indexes = Array.from(
    { length: total },
    (_, i) => i
  );

  for (let i = indexes.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [indexes[i], indexes[j]] =
      [indexes[j], indexes[i]];
  }

  game.buffQuestionIndexes =
    indexes
      .slice(0, count)
      .sort((a, b) => a - b);
}

function currentQuestionHasBuff() {
  return game.buffQuestionIndexes.includes(
    game.currentQuestion
  );
}


// ===============================
// TEAM RANKING
// ===============================

function teamRanking() {
  return Object.keys(game.teams).sort((a, b) => {

    const scoreA =
      Number(game.teams[a].score) || 0;

    const scoreB =
      Number(game.teams[b].score) || 0;

    if (scoreA !== scoreB) {
      return scoreB - scoreA;
    }

    return Number(a) - Number(b);
  });
}


// ===============================
// BUFF 6 WEIGHT
// ===============================

function buff6WeightForGroup(group) {

  const rank =
    teamRanking().indexOf(
      String(group)
    ) + 1;

  // Ưu tiên đội đang đứng 1 / 2
  const weights = [
    8,
    5,
    2,
    0.7,
    0.2
  ];

  return weights[rank - 1] || 0.2;
}


// ===============================
// RANDOM BUFF
// ===============================

function weightedBuffForGroup(group) {

  const weights = {
    1: 25,
    2: 25,
    3: 23,
    4: 7,
    5: 18,
    6: 2 * buff6WeightForGroup(group)
  };

  const total =
    Object.values(weights)
      .reduce((a, b) => a + b, 0);

  let r =
    Math.random() * total;

  for (const id of [1, 2, 3, 4, 5, 6]) {

    r -= weights[id];

    if (r <= 0) {
      return id;
    }
  }

  return 1;
}


// ===============================
// BLIND BOXES
// ===============================

function makeBuffChoices(group) {

  game.boxStats.openedSince4++;
  game.boxStats.openedSince6++;

  // PITY BUFF 4
  if (
    game.boxStats.selected4 < 2 &&
    game.boxStats.openedSince4 >= 12
  ) {
    return [4, 4, 4];
  }

  // PITY BUFF 6
  const rank =
    teamRanking().indexOf(
      String(group)
    ) + 1;

  if (
    game.boxStats.selected6 < 1 &&
    game.boxStats.openedSince6 >= 20 &&
    rank <= 2
  ) {
    return [6, 6, 6];
  }

  return [
    weightedBuffForGroup(group),
    weightedBuffForGroup(group),
    weightedBuffForGroup(group)
  ];
}


// ===============================
// NEXT QUESTION
// ===============================

function triggerNextQuestion() {

  clearPending();

  game.answerRevealed = false;

  game.activeResponder = null;

  game.lockedGroups = [];

  // Chưa có câu nào -> random 12 câu buff
  if (game.currentQuestion === -1) {
    randomizeBuffQuestions();
  }

  const nextIndex =
    game.currentQuestion + 1;

  // CÒN CÂU
  if (
    nextIndex <
    game.questions.length
  ) {

    game.currentQuestion =
      nextIndex;

    game.questionOpen = true;

    const question =
      game.questions[
        game.currentQuestion
      ];

    io.emit("questionOpened", {
      index: game.currentQuestion,

      question,

      hasBuff:
        currentQuestionHasBuff()
    });

  }

  // HẾT 31 CÂU
  else {

    game.questionOpen = false;

    const ranking =
      Object.entries(game.teams)
        .map(([group, team]) => ({
          group,

          name: team.name,

          duckPos:
            Number(team.duckPos) || 0,

          score:
            Number(team.score) || 0
        }))
        .sort(
          (a, b) =>
            b.duckPos - a.duckPos ||
            b.score - a.score
        );

    io.emit("gameFinished", {
      ranking,

      winner:
        ranking[0] || null
    });
  }

  io.emit(
    "state",
    snapshot()
  );
}


// ===============================
// CORRECT ANSWER
// ===============================

function awardCorrect() {

  const responder =
    game.activeResponder;

  if (
    !responder ||
    !game.pendingAnswer
  ) {
    return;
  }

  const group =
    String(responder.group);

  const team =
    game.teams[group];

  const base =
    Math.max(
      1,
      Number(game.scoring.teamStep) || 1
    );

  // ĐIỂM
  team.score += base;

  // VỊT ĐI CÙNG ĐIỂM
  team.duckPos += base;

  team.correct += 1;

  // Điểm cá nhân
  if (
    team.members[
      responder.name
    ]
  ) {

    team.members[
      responder.name
    ].score += Math.max(
      1,
      Number(
        game.scoring.personalPoint
      ) || 1
    );

    team.members[
      responder.name
    ].correct += 1;
  }

  game.questionOpen = false;

  game.answerRevealed = true;

  const hasBuff =
    currentQuestionHasBuff();

  io.emit("result", {

    correct: true,

    name: responder.name,

    group,

    teamStep: base,

    personalPoint:
      Math.max(
        1,
        Number(
          game.scoring.personalPoint
        ) || 1
      ),

    hasBuff
  });


  // CÓ BUFF
  if (hasBuff) {

    const buffChoices =
      makeBuffChoices(group);

    game.pendingBuff = {

      group,

      name: responder.name,

      buffChoices,

      chosen: false,

      target: null
    };

    io.emit(
      "buffChoiceOpened",
      {
        group,
        name: responder.name,
        choices: buffChoices
      }
    );

  }

  // KHÔNG CÓ BUFF
  else {

    game.pendingBuff = null;

    game.activeResponder = null;

    game.pendingAnswer = null;
  }

  io.emit(
    "state",
    snapshot()
  );
}


// ===============================
// WRONG ANSWER
// ===============================

function awardWrong(
  timedOut = false
) {

  const responder =
    game.activeResponder;

  if (!responder) {
    return;
  }

  const group =
    String(responder.group);

  // Một thành viên sai =
  // CẢ NHÓM bị khóa câu đó.
  if (
    !game.lockedGroups.includes(group)
  ) {

    game.lockedGroups.push(group);
  }

  game.activeResponder = null;

  game.pendingAnswer = null;

  game.wrongPending = {
    name: responder.name,
    group
  };

  io.emit("wrong", {

    name: responder.name,

    group,

    timedOut,

    canSteal: true
  });

  io.emit(
    "state",
    snapshot()
  );


  // Sau đúng 3 giây
  setTimeout(() => {

    if (
      !game.wrongPending ||
      String(
        game.wrongPending.group
      ) !== group
    ) {
      return;
    }

    game.wrongPending = null;

    game.questionOpen = true;

    game.activeResponder = null;

    game.pendingAnswer = null;

    io.emit(
      "stealOpened",
      {
        message:
          "🔔 CHUÔNG NHƯỜNG CHO BẠN KHÁC!"
      }
    );

    io.emit(
      "state",
      snapshot()
    );

  }, 3000);
}


// ===============================
// SOCKET
// ===============================

io.on("connection", socket => {

  socket.emit(
    "state",
    snapshot()
  );


  // =============================
  // JOIN MEMBER
  // =============================

  socket.on(
    "joinMember",
    ({ group, name }) => {

      const g =
        String(group);

      const memberName =
        String(name || "")
          .trim();

      if (
        game.teams[g] &&
        memberName
      ) {

        if (
          !game.teams[g]
            .members[memberName]
        ) {

          game.teams[g]
            .members[memberName] = {
              score: 0,
              correct: 0
            };
        }

        socket.emit(
          "joined",
          {
            group: g,
            name: memberName
          }
        );

        io.emit(
          "state",
          snapshot()
        );
      }
    }
  );


  // =============================
  // SAVE QUESTIONS
  // =============================

  socket.on(
    "saveQuestions",
    questions => {

      if (
        !Array.isArray(questions)
      ) {
        return;
      }

      game.questions =
        questions
          .map(q => ({
            q:
              String(q.q || "")
                .trim(),

            options:
              Array.isArray(q.options)
                ? q.options
                    .slice(0, 4)
                    .map(
                      x =>
                        String(x)
                          .trim()
                    )
                : [],

            answer:
              Math.max(
                0,
                Math.min(
                  3,
                  Number(q.answer) || 0
                )
              )
          }))
          .filter(
            q =>
              q.q &&
              q.options.length === 4 &&
              q.options.every(Boolean)
          );

      saveQuestionsToFile();

      io.emit(
        "questionsSaved",
        game.questions
      );

      io.emit(
        "state",
        snapshot()
      );
    }
  );


  // =============================
  // NEXT QUESTION
  // =============================

  socket.on(
    "nextQuestion",
    () => {

      // Buff 4 phải chọn đội trước
      if (
        game.pendingBuff &&
        game.pendingBuff.buffId === 4
      ) {
        return;
      }

      if (
        game.questionOpen ||
        game.pendingBuff ||
        game.pendingAnswer
      ) {
        return;
      }

      triggerNextQuestion();
    }
  );


  // =============================
  // BUZZ
  // =============================

  socket.on(
    "buzz",
    ({ group, name }) => {

      const g =
        String(group);

      // Nhóm đã sai thì không được bấm lại
      if (
        !game.questionOpen ||
        game.activeResponder ||
        game.lockedGroups.includes(g)
      ) {
        return;
      }

      game.activeResponder = {
        group: g,

        name:
          String(name || ""),

        socketId:
          socket.id
      };

      game.pendingAnswer = null;

      io.emit(
        "buzzed",
        {
          group: g,
          name:
            game.activeResponder.name
        }
      );

      io.emit(
        "state",
        snapshot()
      );
    }
  );


  // =============================
  // MC CHỌN A/B/C/D
  // =============================

  socket.on(
    "mcSelectAnswer",
    ({ index }) => {

      if (
        !game.activeResponder ||
        game.pendingAnswer ||
        game.pendingBuff
      ) {
        return;
      }

      const currentQuestion =
        game.questions[
          game.currentQuestion
        ];

      if (
        !currentQuestion ||
        !Number.isInteger(index) ||
        index < 0 ||
        index > 3
      ) {
        return;
      }

      game.pendingAnswer = {
        index,

        name:
          game.activeResponder.name,

        group:
          String(
            game.activeResponder.group
          )
      };

      io.emit(
        "answerSelected",
        game.pendingAnswer
      );

      const correct =
        index ===
        currentQuestion.answer;

      if (correct) {
        awardCorrect();
      } else {
        awardWrong(false);
      }
    }
  );


  // =============================
  // CHO PHÉP NHƯỜNG
  // =============================

  socket.on(
    "allowSteal",
    () => {

      if (
        game.pendingBuff ||
        !game.wrongPending
      ) {
        return;
      }

      game.wrongPending = null;

      game.activeResponder = null;

      game.pendingAnswer = null;

      game.questionOpen = true;

      io.emit(
        "stealOpened"
      );

      io.emit(
        "state",
        snapshot()
      );
    }
  );


  // =============================
  // SKIP QUESTION
  // =============================

  socket.on(
    "skipQuestion",
    () => {

      if (game.pendingBuff) {
        return;
      }

      clearPending();

      game.answerRevealed = true;

      game.questionOpen = false;

      game.activeResponder = null;

      io.emit(
        "questionSkipped"
      );

      io.emit(
        "state",
        snapshot()
      );
    }
  );


  // =============================
  // CHOOSE BUFF BOX
  // =============================

  socket.on(
    "chooseBuff",
    ({ choice }) => {

      const pending =
        game.pendingBuff;

      if (
        !pending ||
        pending.chosen ||
        Number(choice) < 0 ||
        Number(choice) > 2
      ) {
        return;
      }

      pending.chosen = true;

      pending.choice =
        Number(choice);

      const buffId =
        pending.buffChoices[
          Number(choice)
        ];

      pending.buffId = buffId;

      if (buffId === 4) {
        game.boxStats.selected4++;
        game.boxStats.openedSince4 = 0;
      }

      if (buffId === 6) {
        game.boxStats.selected6++;
        game.boxStats.openedSince6 = 0;
      }

      io.emit(
        "buffBoxChosen",
        {
          group: pending.group,

          name: pending.name,

          choice:
            Number(choice)
        }
      );

      io.emit(
        "buffRevealed",
        {
          group: pending.group,

          name: pending.name,

          choice:
            Number(choice),

          buffId,

          buff: BUFFS[buffId],

          choices:
            pending.buffChoices
        }
      );

      io.emit(
        "buffRevealedMC",
        {
          group: pending.group,

          name: pending.name,

          choice:
            Number(choice),

          buffId,

          buff: BUFFS[buffId],

          choices:
            pending.buffChoices
        }
      );


      if (buffId === 1) {
        applyBuff1(pending);

      } else if (buffId === 2) {
        applyBuff2(pending);

      } else if (buffId === 3) {
        applyBuff3(pending);

      } else if (buffId === 5) {
        applyBuff5(pending);

      } else if (buffId === 6) {
        applyBuff6(pending);
      }

      // Buff 4 chờ MC chọn đội
      io.emit(
        "state",
        snapshot()
      );
    }
  );


  // =============================
  // BUFF 4 - SWAP
  // =============================

  socket.on(
    "chooseSwapTarget",
    ({ targetGroup }) => {

      const pending =
        game.pendingBuff;

      if (
        !pending ||
        !pending.chosen ||
        pending.buffId !== 4
      ) {
        return;
      }

      const from =
        String(pending.group);

      const to =
        String(targetGroup);

      if (
        !game.teams[to] ||
        to === from
      ) {
        return;
      }

      const a =
        game.teams[from];

      const b =
        game.teams[to];

      // HOÁN ĐỔI CẢ ĐIỂM LẪN VỊ TRÍ
      [
        a.score,
        b.score
      ] = [
        b.score,
        a.score
      ];

      [
        a.duckPos,
        b.duckPos
      ] = [
        b.duckPos,
        a.duckPos
      ];

      io.emit(
        "buffApplied",
        {
          group: from,

          buffId: 4,

          targetGroup: to
        }
      );

      finishBuff();
    }
  );


  // =============================
  // BUFF 1
  // =============================

  function applyBuff1(pending) {

    let choices =
      otherGroups(
        pending.group
      )
      .filter(
        g =>
          Number(
            game.teams[g].score
          ) > 0
      );


    // Không cướp cùng một đội
    // hai lần liên tiếp nếu còn lựa chọn khác.
    if (
      choices.length > 1 &&
      game.lastStealTarget &&
      choices.includes(
        String(
          game.lastStealTarget
        )
      )
    ) {

      choices =
        choices.filter(
          g =>
            g !==
            String(
              game.lastStealTarget
            )
        );
    }


    if (choices.length) {

      const target =
        choices[
          Math.floor(
            Math.random() *
            choices.length
          )
        ];

      game.lastStealTarget =
        target;

      const amount =
        Math.min(
          2,
          Number(
            game.teams[target].score
          ) || 0
        );


      // ĐỘI BỊ CƯỚP LÙI
      game.teams[target].score -=
        amount;

      game.teams[target].duckPos -=
        amount;

      // ĐỘI CƯỚP TIẾN
      game.teams[
        pending.group
      ].score += amount;

      game.teams[
        pending.group
      ].duckPos += amount;


      io.emit(
        "buffApplied",
        {
          group:
            pending.group,

          buffId: 1,

          targetGroup: target,

          amount
        }
      );

    } else {

      io.emit(
        "buffApplied",
        {
          group:
            pending.group,

          buffId: 1,

          targetGroup: null,

          amount: 0
        }
      );
    }

    finishBuff();
  }


  // =============================
  // BUFF 2
  // =============================

  function applyBuff2(pending) {

    const amount =
      Math.max(
        1,
        Number(
          game.scoring.teamStep
        ) || 1
      );

    game.teams[
      pending.group
    ].score += amount;

    game.teams[
      pending.group
    ].duckPos += amount;

    io.emit(
      "buffApplied",
      {
        group:
          pending.group,

        buffId: 2,

        amount
      }
    );

    finishBuff();
  }


  // =============================
  // BUFF 3
  // =============================

  function applyBuff3(pending) {

    const team =
      game.teams[
        pending.group
      ];

    const hitPos =
      Number(team.duckPos) || 0;

    team.score =
      Math.max(
        0,
        Number(team.score) - 1
      );

    // MẤT ĐIỂM -> VỊT LÙI
    team.duckPos =
      Math.max(
        0,
        Number(team.duckPos) - 1
      );

    io.emit(
      "buffApplied",
      {
        group:
          pending.group,

        buffId: 3,

        amount: -1,

        scoreLost: 1,

        hitPos
      }
    );

    finishBuff();
  }


  // =============================
  // BUFF 5
  // =============================

  function applyBuff5(pending) {

    const team =
      game.teams[
        pending.group
      ];

    const amount = 3;

    team.score += amount;

    team.duckPos += amount;

    io.emit(
      "buffApplied",
      {
        group:
          pending.group,

        buffId: 5,

        amount,

        scoreAdded: amount
      }
    );

    finishBuff();
  }


  // =============================
  // BUFF 6
  // =============================

  function applyBuff6(pending) {

    const lowestScore =
      Math.min(
        ...Object.values(
          game.teams
        ).map(
          team =>
            Number(team.score) || 0
        )
      );

    const ranked =
      teamRanking();

    const lowestGroups =
      ranked.filter(
        group =>
          (
            Number(
              game.teams[group].score
            ) || 0
          ) === lowestScore
      );

    const lowestGroup =
      lowestGroups[
        Math.floor(
          Math.random() *
          lowestGroups.length
        )
      ];

    const team =
      game.teams[
        pending.group
      ];

    const oldScore =
      Number(team.score) || 0;

    // KÉO ĐIỂM XUỐNG THẤP NHẤT
    team.score =
      lowestScore;

    // VỊT CŨNG LÙI THEO ĐIỂM
    team.duckPos =
      lowestScore;

    io.emit(
      "buffApplied",
      {
        group:
          pending.group,

        buffId: 6,

        targetGroup:
          lowestGroup,

        oldScore,

        newScore:
          lowestScore
      }
    );

    finishBuff();
  }


  // =============================
  // FINISH BUFF
  // =============================

  function finishBuff() {

    const responderSocket =
      game.activeResponder
        ?.socketId;

    if (responderSocket) {

      io.to(
        responderSocket
      ).emit(
        "buffFinished",
        {
          group:
            game.pendingBuff?.group
        }
      );
    }

    game.pendingBuff = null;

    game.activeResponder = null;

    game.pendingAnswer = null;

    io.emit(
      "state",
      snapshot()
    );
  }


  // =============================
  // RESET BUZZ
  // =============================

  socket.on(
    "resetBuzz",
    () => {

      game.activeResponder = null;

      game.pendingAnswer = null;

      io.emit(
        "resetBuzz"
      );

      io.emit(
        "state",
        snapshot()
      );
    }
  );


  // =============================
  // SCORING
  // =============================

  socket.on(
    "setScoring",
    ({ teamStep, personalPoint }) => {

      game.scoring.teamStep =
        Math.max(
          1,
          Number(teamStep) || 2
        );

      game.scoring.personalPoint =
        Math.max(
          1,
          Number(personalPoint) || 1
        );

      io.emit(
        "state",
        snapshot()
      );
    }
  );


  // =============================
  // RESET GAME
  // =============================

  socket.on(
    "resetGame",
    () => {

      Object.keys(
        game.teams
      ).forEach(group => {

        game.teams[group] = {
          name:
            `Nhóm ${group}`,

          score: 0,

          correct: 0,

          duckPos: 0,

          members: {}
        };
      });

      game.currentQuestion = -1;

      game.questionOpen = false;

      game.activeResponder = null;

      game.lockedGroups = [];

      game.pendingAnswer = null;

      game.wrongPending = null;

      game.answerRevealed = false;

      game.pendingBuff = null;

      game.boxStats = {
        openedSince4: 0,
        openedSince6: 0,
        selected4: 0,
        selected6: 0
      };

      game.lastStealTarget = null;

      // Reset để random lại 12 câu buff
      game.buffQuestionIndexes = [];

      io.emit(
        "fullReset"
      );

      io.emit(
        "state",
        snapshot()
      );
    }
  );
});

server.listen(
  PORT,
  () => {
    console.log(
      `🚀 Server đang chạy tại port ${PORT}`
    );
  }
);
