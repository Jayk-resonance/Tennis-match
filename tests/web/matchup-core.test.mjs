import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHistoryWeights,
  enumerateSlots,
  evaluateSchedule,
  generateCandidates,
  isSegregated,
  swapPlayers,
  validateSchedule,
} from "../../docs/assets/matchup-core.js";

const players = [
  ["김제우", "남", "A", 5],
  ["김동원", "남", "B+", 4],
  ["이채윤", "여", "B", 3],
  ["진혜주", "여", "B-", 2.5],
  ["조재윤", "남", "B", 3],
  ["신명수", "남", "B", 3],
  ["김예은", "여", "C", 1],
  ["조영혜", "여", "C-", 0.5],
].map(([name, gender, level, score], index) => ({
  id: `p${index}`,
  name,
  gender,
  level,
  score,
  guest: false,
}));

const sessions = [
  {
    date: "2026-08-02",
    courts: [
      [["김제우", "김예은"], ["김동원", "조영혜"]],
      [["이채윤", "조재윤"], ["진혜주", "신명수"]],
    ],
  },
];

test("8명 기준 한 타임 조합은 315개다", () => {
  assert.equal(enumerateSlots(players).length, 315);
});

test("최근 회차 파트너와 상대 이력을 가중 집계한다", () => {
  const weights = buildHistoryWeights(sessions);
  assert.equal(weights.partner.get("김예은\u0001김제우"), 1);
  assert.equal(weights.opponent.get("김동원\u0001김제우"), 1);
});

test("보관된 대진은 최근 이력 계산에서 제외한다", () => {
  const archived = {
    date: "2026-08-09",
    status: "archived",
    courts: [[["김제우", "김동원"], ["이채윤", "진혜주"]]],
  };
  const weights = buildHistoryWeights([archived, ...sessions]);
  assert.equal(weights.partner.has("김동원\u0001김제우"), false);
  assert.equal(weights.partner.get("김예은\u0001김제우"), 1);
});

test("후보 3개가 모든 필수 조건을 충족한다", () => {
  const candidates = generateCandidates({ players, sessions, candidateCount: 3, segregatedSlot: 2 });
  assert.equal(candidates.length, 3);
  for (const candidate of candidates) {
    assert.equal(validateSchedule(candidate.schedule, players).valid, true);
    assert.equal(candidate.schedule.some((slot) => isSegregated(slot, players)), true);
    assert.equal(candidate.evaluation.metrics.segregatedSlots.includes(1), true);
  }
});

test("실력 분리 타임을 여러 개 선택하면 선택한 모든 순서에 적용한다", () => {
  for (const selectedSlots of [[2, 3], [1, 2, 3]]) {
    const candidates = generateCandidates({ players, sessions, candidateCount: 3, segregatedSlots: selectedSlots });
    assert.equal(candidates.length, 3);
    for (const candidate of candidates) {
      for (const selectedSlot of selectedSlots) {
        assert.equal(candidate.evaluation.metrics.segregatedSlots.includes(selectedSlot - 1), true);
      }
    }
  }
});

test("1.5점 차를 넘는 코트에는 일방 경기 추가 벌점을 적용한다", () => {
  const [candidate] = generateCandidates({ players, sessions, candidateCount: 1 });
  const expected = candidate.evaluation.courts.reduce(
    (sum, court) => sum + 25 * Math.max(0, court.difference - 1.5),
    0,
  );
  assert.equal(candidate.evaluation.breakdown.balanceHeavy, expected);
  assert.equal(
    candidate.evaluation.metrics.heavyCourtCount,
    candidate.evaluation.courts.filter((court) => court.difference > 1.5).length,
  );
});

test("같은 타임의 두 선수를 교환한 뒤 다시 평가할 수 있다", () => {
  const [candidate] = generateCandidates({ players, sessions, candidateCount: 1 });
  const swapped = swapPlayers(candidate.schedule, [0, 0, 0, 0], [0, 1, 1, 1]);
  const evaluation = evaluateSchedule(swapped, players, sessions);
  assert.equal(typeof evaluation.metrics.totalPenalty, "number");
  assert.equal(swapped[0].flat(2).sort((a, b) => a - b).join(":"), "0:1:2:3:4:5:6:7");
});

test("서로 다른 타임으로 끌어 놓는 동작은 차단한다", () => {
  const [candidate] = generateCandidates({ players, sessions, candidateCount: 1 });
  assert.throws(
    () => swapPlayers(candidate.schedule, [0, 0, 0, 0], [1, 1, 1, 1]),
    /같은 타임/,
  );
});
