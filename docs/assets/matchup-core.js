export const RULES = Object.freeze({
  balance: 10,
  balanceKnee: 1.5,
  balanceHeavy: 25,
  gender: 12,
  spread: 0.5,
  duplicatePartner: 25,
  duplicateOpponent: 3,
  opponentAllThree: 30,
  historyPartner: 5,
  historyOpponent: 1.5,
  historyDecay: 0.75,
  historyLookback: 8,
  segregationTolerance: 0.5,
  localCandidateCount: 90,
  requirementCandidateCount: 40,
});

export const SLOT_LABELS = Object.freeze([
  "20:00-20:50 (몸풀기 포함)",
  "20:50-21:25",
  "21:25-22:00",
]);

const COURT_LABELS = Object.freeze(["K", "L"]);

function combinations(values, size, start = 0, picked = [], output = []) {
  if (picked.length === size) {
    output.push([...picked]);
    return output;
  }
  for (let index = start; index <= values.length - (size - picked.length); index += 1) {
    picked.push(values[index]);
    combinations(values, size, index + 1, picked, output);
    picked.pop();
  }
  return output;
}

function indexPairKey(pair) {
  return [...pair].sort((a, b) => a - b).join(":");
}

function namePairKey(pair) {
  return [...pair].sort((a, b) => a.localeCompare(b, "ko")).join("\u0001");
}

function seededRandom(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function teamSplits(four) {
  const [a, b, c, d] = four;
  return [
    [[a, b], [c, d]],
    [[a, c], [b, d]],
    [[a, d], [b, c]],
  ];
}

export function enumerateSlots(players) {
  const indexes = players.map((_, index) => index);
  const slots = [];
  for (const first of combinations(indexes, 4)) {
    if (!first.includes(0)) continue;
    const firstSet = new Set(first);
    const second = indexes.filter((index) => !firstSet.has(index));
    for (const courtOne of teamSplits(first)) {
      for (const courtTwo of teamSplits(second)) {
        slots.push([courtOne, courtTwo]);
      }
    }
  }
  return slots;
}

function genderType(team, players) {
  return team.map((index) => players[index].gender).sort().join("");
}

export function genderMismatch(court, players) {
  return genderType(court[0], players) === genderType(court[1], players) ? 0 : 1;
}

export function matchType(court, players) {
  const left = genderType(court[0], players);
  const right = genderType(court[1], players);
  if (left === "남여" && right === "남여") return "혼복";
  if (left === "남남" && right === "남남") return "남복";
  if (left === "여여" && right === "여여") return "여복";
  return "성별 조합 주의";
}

function teamScore(team, players) {
  return team.reduce((sum, index) => sum + players[index].score, 0);
}

export function localPenalty(slot, players) {
  let penalty = 0;
  for (const court of slot) {
    const leftScore = teamScore(court[0], players);
    const rightScore = teamScore(court[1], players);
    const difference = Math.abs(leftScore - rightScore);
    penalty += RULES.balance * difference;
    penalty += RULES.balanceHeavy * Math.max(0, difference - RULES.balanceKnee);
    penalty += RULES.gender * genderMismatch(court, players);
    const scores = court.flat().map((index) => players[index].score);
    penalty += RULES.spread * (Math.max(...scores) - Math.min(...scores));
  }
  return penalty;
}

export function isSegregated(slot, players) {
  const groups = slot.map((court) => court.flat().map((index) => players[index].score));
  groups.sort((left, right) => right.reduce((a, b) => a + b, 0) - left.reduce((a, b) => a + b, 0));
  const [strong, weak] = groups;
  return Math.min(...strong) >= Math.max(...weak) - RULES.segregationTolerance;
}

function slotPairs(slot) {
  const partners = [];
  const opponents = [];
  for (const court of slot) {
    const [left, right] = court;
    partners.push(indexPairKey(left), indexPairKey(right));
    for (const first of left) {
      for (const second of right) opponents.push(indexPairKey([first, second]));
    }
  }
  return { partners, opponents };
}

export function buildHistoryWeights(sessions) {
  const partner = new Map();
  const opponent = new Map();
  const recent = sessions
    .filter((session) => session.status !== "archived")
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-RULES.historyLookback)
    .reverse();
  recent.forEach((session, age) => {
    const weight = RULES.historyDecay ** age;
    for (const court of session.courts ?? []) {
      const [left, right] = court;
      const leftKey = namePairKey(left);
      const rightKey = namePairKey(right);
      partner.set(leftKey, (partner.get(leftKey) ?? 0) + weight);
      partner.set(rightKey, (partner.get(rightKey) ?? 0) + weight);
      for (const first of left) {
        for (const second of right) {
          const key = namePairKey([first, second]);
          opponent.set(key, (opponent.get(key) ?? 0) + weight);
        }
      }
    }
  });
  return { partner, opponent };
}

function historicalKey(indexKey, players) {
  const indexes = indexKey.split(":").map(Number);
  if (indexes.some((index) => players[index].guest)) return null;
  return namePairKey(indexes.map((index) => players[index].name));
}

function increment(counter, key) {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

function globalPenaltyDetails(slots, players, historyWeights) {
  const partnerCounter = new Map();
  const opponentCounter = new Map();
  let historyPartner = 0;
  let historyOpponent = 0;
  const reusedPartners = new Set();
  const reusedOpponents = new Set();

  for (const slot of slots) {
    const pairs = slotPairs(slot);
    for (const pair of pairs.partners) {
      increment(partnerCounter, pair);
      const key = historicalKey(pair, players);
      const weight = key ? historyWeights.partner.get(key) ?? 0 : 0;
      historyPartner += RULES.historyPartner * weight;
      if (weight > 0) reusedPartners.add(key);
    }
    for (const pair of pairs.opponents) {
      increment(opponentCounter, pair);
      const key = historicalKey(pair, players);
      const weight = key ? historyWeights.opponent.get(key) ?? 0 : 0;
      historyOpponent += RULES.historyOpponent * weight;
      if (weight > 0) reusedOpponents.add(key);
    }
  }

  const duplicatePartnerCount = [...partnerCounter.values()].reduce(
    (sum, count) => sum + Math.max(0, count - 1),
    0,
  );
  const duplicateOpponentCount = [...opponentCounter.values()].reduce(
    (sum, count) => sum + Math.max(0, count - 1),
    0,
  );
  const allThreeOpponentCount = [...opponentCounter.values()].filter((count) => count >= 3).length;

  return {
    historyPartner,
    historyOpponent,
    duplicatePartner: RULES.duplicatePartner * duplicatePartnerCount,
    duplicateOpponent: RULES.duplicateOpponent * duplicateOpponentCount,
    opponentAllThree: RULES.opponentAllThree * allThreeOpponentCount,
    duplicatePartnerCount,
    duplicateOpponentCount,
    allThreeOpponentCount,
    reusedPartnerCount: reusedPartners.size,
    reusedOpponentCount: reusedOpponents.size,
  };
}

export function validateSchedule(schedule, players) {
  if (!Array.isArray(schedule) || schedule.length !== 3) {
    return { valid: false, reason: "대진은 3타임이어야 합니다." };
  }
  const expected = players.map((_, index) => index).sort((a, b) => a - b).join(":");
  for (let slotIndex = 0; slotIndex < schedule.length; slotIndex += 1) {
    const slot = schedule[slotIndex];
    if (!Array.isArray(slot) || slot.length !== 2 || slot.some((court) => court.length !== 2)) {
      return { valid: false, reason: `${slotIndex + 1}타임의 코트 구성이 올바르지 않습니다.` };
    }
    const indexes = slot.flat(2);
    if (indexes.length !== players.length || [...indexes].sort((a, b) => a - b).join(":") !== expected) {
      return { valid: false, reason: `${slotIndex + 1}타임에 중복 또는 누락된 참석자가 있습니다.` };
    }
  }
  if (!schedule.some((slot) => isSegregated(slot, players))) {
    return { valid: false, reason: "최소 한 타임의 실력 분리 조건이 필요합니다." };
  }
  return { valid: true, reason: "모든 필수 조건을 충족합니다." };
}

function evaluationHeadline(metrics, validation) {
  if (!validation.valid) return `필수 규칙 위반 · ${validation.reason}`;
  if (metrics.duplicatePartnerCount === 0 && metrics.maxTeamDifference <= 1) {
    return "팀 균형 우수 · 파트너 중복 없음";
  }
  if (metrics.duplicatePartnerCount > 0) {
    return `파트너 중복 ${metrics.duplicatePartnerCount}회 · 조정 권장`;
  }
  if (metrics.maxTeamDifference >= 2) {
    return `최대 팀 점수 차 ${formatScore(metrics.maxTeamDifference)} · 균형 확인 필요`;
  }
  return "필수 규칙 충족 · 전반적인 균형 양호";
}

export function evaluateSchedule(schedule, players, sessions = []) {
  const historyWeights = buildHistoryWeights(sessions);
  let balance = 0;
  let balanceHeavy = 0;
  let gender = 0;
  let spread = 0;
  let genderMismatchCount = 0;
  const differences = [];
  const courts = [];

  schedule.forEach((slot, slotIndex) => {
    slot.forEach((court, courtIndex) => {
      const leftScore = teamScore(court[0], players);
      const rightScore = teamScore(court[1], players);
      const difference = Math.abs(leftScore - rightScore);
      const mismatch = genderMismatch(court, players);
      const scores = court.flat().map((index) => players[index].score);
      balance += RULES.balance * difference;
      balanceHeavy += RULES.balanceHeavy * Math.max(0, difference - RULES.balanceKnee);
      gender += RULES.gender * mismatch;
      spread += RULES.spread * (Math.max(...scores) - Math.min(...scores));
      genderMismatchCount += mismatch;
      differences.push(difference);
      courts.push({
        slotIndex,
        courtIndex,
        label: COURT_LABELS[courtIndex],
        leftScore,
        rightScore,
        difference,
        matchType: matchType(court, players),
      });
    });
  });

  const global = globalPenaltyDetails(schedule, players, historyWeights);
  const breakdown = {
    balance,
    balanceHeavy,
    duplicatePartner: global.duplicatePartner,
    opponentAllThree: global.opponentAllThree,
    gender,
    historyPartner: global.historyPartner,
    historyOpponent: global.historyOpponent,
    duplicateOpponent: global.duplicateOpponent,
    spread,
  };
  const totalPenalty = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  const validation = validateSchedule(schedule, players);
  const segregatedSlots = schedule
    .map((slot, index) => (isSegregated(slot, players) ? index : -1))
    .filter((index) => index >= 0);
  const metrics = {
    totalPenalty,
    maxTeamDifference: Math.max(...differences),
    averageTeamDifference: differences.reduce((sum, value) => sum + value, 0) / differences.length,
    heavyCourtCount: differences.filter((difference) => difference > RULES.balanceKnee).length,
    genderMismatchCount,
    segregatedSlots,
    duplicatePartnerCount: global.duplicatePartnerCount,
    duplicateOpponentCount: global.duplicateOpponentCount,
    allThreeOpponentCount: global.allThreeOpponentCount,
    reusedPartnerCount: global.reusedPartnerCount,
    reusedOpponentCount: global.reusedOpponentCount,
  };
  return {
    validation,
    metrics,
    breakdown,
    courts,
    headline: evaluationHeadline(metrics, validation),
  };
}

function globalPenalty(slots, players, historyWeights) {
  const details = globalPenaltyDetails(slots, players, historyWeights);
  return (
    details.historyPartner +
    details.historyOpponent +
    details.duplicatePartner +
    details.duplicateOpponent +
    details.opponentAllThree
  );
}

function permutations(values) {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, itemIndex) => itemIndex !== index)).map((rest) => [value, ...rest]),
  );
}

function orderSlots(candidate, players, segregatedSlot) {
  const target = Math.min(Math.max(segregatedSlot - 1, 0), 2);
  const valid = permutations(candidate.entries)
    .filter((entries) => isSegregated(entries[target].slot, players));
  if (!valid.length) throw new Error("실력 분리 타임을 지정한 위치에 배치할 수 없습니다.");
  valid.sort((left, right) => compareTuple(
    left.map((entry) => localPenalty(entry.slot, players)),
    right.map((entry) => localPenalty(entry.slot, players)),
  ));
  return valid[0].map((entry) => entry.slot);
}

function compareTuple(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function assignCourts(ordered, players) {
  let best = null;
  let bestKey = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const arranged = [];
    const kCount = new Map(players.map((_, index) => [index, 0]));
    ordered.forEach((slot, slotIndex) => {
      let [first, second] = slot;
      if ((mask >> slotIndex) & 1) [first, second] = [second, first];
      arranged.push([first, second]);
      first.flat().forEach((index) => kCount.set(index, kCount.get(index) + 1));
    });
    const spread = [...kCount.values()].reduce(
      (sum, count) => sum + Math.abs(2 * count - ordered.length),
      0,
    );
    const strongK = arranged.reduce((sum, [first, second]) => {
      const firstScore = first.flat().reduce((value, index) => value + players[index].score, 0);
      const secondScore = second.flat().reduce((value, index) => value + players[index].score, 0);
      return sum + (firstScore >= secondScore ? 1 : 0);
    }, 0);
    const key = [spread, -strongK, mask];
    if (!bestKey || compareTuple(key, bestKey) < 0) {
      best = arranged;
      bestKey = key;
    }
  }
  return best;
}

export function normalizeScheduleTeams(schedule, players) {
  return schedule.map((slot) =>
    slot.map((court) => {
      const [left, right] = court;
      return teamScore(left, players) >= teamScore(right, players)
        ? [left, right]
        : [right, left];
    }),
  );
}

export function generateCandidates({
  players,
  sessions = [],
  candidateCount = 3,
  seed = null,
  segregatedSlot = 2,
  onProgress = () => {},
}) {
  if (players.length !== 8) throw new Error(`참석자는 8명이어야 합니다 (현재 ${players.length}명).`);
  const historyWeights = buildHistoryWeights(sessions);
  const random = seed === null ? null : seededRandom(seed);
  const scored = enumerateSlots(players)
    .map((slot, index) => ({
      slot,
      id: index,
      penalty: localPenalty(slot, players) + (random ? random() * 1.5 : 0),
    }))
    .sort((left, right) => left.penalty - right.penalty || left.id - right.id);

  const segregated = scored.filter(({ slot }) => isSegregated(slot, players));
  if (!segregated.length) throw new Error("실력 분리 타임을 만들 수 없습니다.");
  const poolById = new Map();
  scored.slice(0, RULES.localCandidateCount).forEach((entry) => poolById.set(entry.id, entry));
  segregated.slice(0, RULES.requirementCandidateCount).forEach((entry) => poolById.set(entry.id, entry));
  const pool = [...poolById.values()].sort(
    (left, right) => left.penalty - right.penalty || left.id - right.id,
  );

  const best = [];
  let iteration = 0;
  let bound = Infinity;
  const totalIterations = pool.length * (pool.length - 1) * (pool.length - 2) / 6;
  for (let firstIndex = 0; firstIndex < pool.length; firstIndex += 1) {
    const first = pool[firstIndex];
    if (3 * first.penalty > bound) break;
    for (let secondIndex = firstIndex + 1; secondIndex < pool.length; secondIndex += 1) {
      const second = pool[secondIndex];
      if (first.penalty + 2 * second.penalty > bound) break;
      for (let thirdIndex = secondIndex + 1; thirdIndex < pool.length; thirdIndex += 1) {
        const third = pool[thirdIndex];
        const localTotal = first.penalty + second.penalty + third.penalty;
        if (localTotal > bound) break;
        iteration += 1;
        const entries = [first, second, third];
        if (!entries.some((entry) => isSegregated(entry.slot, players))) continue;
        const slots = entries.map((entry) => entry.slot);
        const total = localTotal + globalPenalty(slots, players, historyWeights);
        best.push({
          penalty: total,
          order: iteration,
          entries,
        });
        best.sort((left, right) => left.penalty - right.penalty || left.order - right.order);
        if (best.length > candidateCount) best.pop();
        if (best.length === candidateCount) bound = best.at(-1).penalty;
      }
    }
    if (firstIndex % 8 === 0) onProgress(Math.min(99, Math.round((iteration / totalIterations) * 100)));
  }

  if (!best.length) throw new Error("모든 필수 조건을 만족하는 대진을 만들 수 없습니다.");

  onProgress(100);
  return best.map((candidate, index) => {
    const ordered = orderSlots(candidate, players, segregatedSlot);
    const schedule = normalizeScheduleTeams(assignCourts(ordered, players), players);
    return {
      rank: index + 1,
      generationPenalty: candidate.penalty,
      schedule,
      originalSchedule: structuredClone(schedule),
      evaluation: evaluateSchedule(schedule, players, sessions),
    };
  });
}

export function swapPlayers(schedule, source, target, players = null) {
  if (source[0] !== target[0]) throw new Error("같은 타임 안에서만 자리를 바꿀 수 있습니다.");
  const copy = structuredClone(schedule);
  const [sourceSlot, sourceCourt, sourceTeam, sourcePlayer] = source;
  const [targetSlot, targetCourt, targetTeam, targetPlayer] = target;
  const first = copy[sourceSlot][sourceCourt][sourceTeam][sourcePlayer];
  copy[sourceSlot][sourceCourt][sourceTeam][sourcePlayer] =
    copy[targetSlot][targetCourt][targetTeam][targetPlayer];
  copy[targetSlot][targetCourt][targetTeam][targetPlayer] = first;
  return players ? normalizeScheduleTeams(copy, players) : copy;
}

export function formatScore(value) {
  return Number.isInteger(value) ? String(value) : Number(value).toFixed(1).replace(/\.0$/, "");
}

export function scheduleToText(schedule, players, date) {
  const lines = [`## ${date} 코트운영`, ""];
  schedule.forEach((slot, slotIndex) => {
    lines.push(SLOT_LABELS[slotIndex]);
    slot.forEach((court, courtIndex) => {
      let [left, right] = court;
      if (teamScore(left, players) < teamScore(right, players)) [left, right] = [right, left];
      const team = (indexes) => indexes.map((index) => players[index].name).join(" ");
      lines.push(`${COURT_LABELS[courtIndex]}코트: ${team(left)} vs ${team(right)}`);
    });
    lines.push("");
  });
  return lines.join("\n").trim();
}
