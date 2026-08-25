export const EXCHANGE_SLOT_LABELS = Object.freeze([
  "20:00–20:30",
  "20:30–21:00",
  "21:00–21:30",
  "21:30–22:00",
]);

export const EXCHANGE_COURT_LABELS = Object.freeze(["B", "C"]);

export const EXCHANGE_RULES = Object.freeze({
  balance: 10,
  balanceHeavy: 25,
  duplicatePartner: 14,
  duplicateOpponent: 4,
  historyPartner: 8,
  historyOpponent: 1.5,
  gender: 3,
  courtBalance: 1.5,
  historyLookback: 8,
  historyDecay: 0.78,
});

function pairKey(left, right) {
  return [left, right].sort((a, b) => String(a).localeCompare(String(b), "ko")).join("\u0001");
}

function permutations(items) {
  if (items.length <= 1) return [items.slice()];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  );
}

function partitions(indices) {
  const [a, b, c, d] = indices;
  return [
    [[a, b], [c, d]],
    [[a, c], [b, d]],
    [[a, d], [b, c]],
  ];
}

function teamScore(team, players) {
  return team.reduce((sum, index) => sum + Number(players[index].score), 0);
}

function genderMismatch(court, players) {
  const type = (team) => team.map((index) => players[index].gender).sort().join("");
  return type(court[0]) === type(court[1]) ? 0 : 1;
}

function sessionCourts(session) {
  if (session.courts?.length) return session.courts;
  if (!session.schedule || !session.participants) return [];
  return session.schedule.flatMap((slot) =>
    slot.map((court) => court.map((team) => team.map((index) => session.participants[index]?.name).filter(Boolean))),
  );
}

function historyWeights(sessions) {
  const partner = new Map();
  const opponent = new Map();
  const active = sessions
    .filter((session) => session.status !== "archived" && session.matchType === "exchange")
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-EXCHANGE_RULES.historyLookback)
    .reverse();
  active.forEach((session, age) => {
    const weight = EXCHANGE_RULES.historyDecay ** age;
    for (const court of sessionCourts(session)) {
      const [left, right] = court;
      partner.set(pairKey(left[0], left[1]), (partner.get(pairKey(left[0], left[1])) ?? 0) + weight);
      partner.set(pairKey(right[0], right[1]), (partner.get(pairKey(right[0], right[1])) ?? 0) + weight);
      for (const leftName of left) {
        for (const rightName of right) {
          const key = pairKey(leftName, rightName);
          opponent.set(key, (opponent.get(key) ?? 0) + weight);
        }
      }
    }
  });
  return { partner, opponent };
}

export function validateExchangeSchedule(schedule, players) {
  if (players.length !== 8) return { valid: false, reason: "교류전 참석자는 8명이어야 합니다." };
  const clubCounts = players.reduce((counts, player) => {
    counts[player.club] = (counts[player.club] ?? 0) + 1;
    return counts;
  }, {});
  if (clubCounts.TeSK !== 4 || clubCounts["금테클"] !== 4) {
    return { valid: false, reason: "TeSK 4명과 금테클 4명을 선택해야 합니다." };
  }
  if (!Array.isArray(schedule) || schedule.length !== 4) {
    return { valid: false, reason: "교류전은 4타임이어야 합니다." };
  }
  for (let slotIndex = 0; slotIndex < schedule.length; slotIndex += 1) {
    const slot = schedule[slotIndex];
    const flattened = slot?.flat(2) ?? [];
    if (slot?.length !== 2 || flattened.length !== 8 || new Set(flattened).size !== 8) {
      return { valid: false, reason: `${slotIndex + 1}타임에 8명이 한 번씩 배치되어야 합니다.` };
    }
    for (const court of slot) {
      if (court?.length !== 2 || court.some((team) => team?.length !== 2)) {
        return { valid: false, reason: `${slotIndex + 1}타임의 팀 구성이 올바르지 않습니다.` };
      }
      const teamClubs = court.map((team) => team.map((index) => players[index]?.club));
      if (slotIndex < 3) {
        if (teamClubs.some((clubs) => clubs[0] !== clubs[1]) || teamClubs[0][0] === teamClubs[1][0]) {
          return { valid: false, reason: "1~3타임은 같은 클럽끼리 팀을 이루어야 합니다." };
        }
      } else if (teamClubs.some((clubs) => new Set(clubs).size !== 2)) {
        return { valid: false, reason: "마지막 타임은 각 팀에 두 클럽 선수가 한 명씩 있어야 합니다." };
      }
    }
  }
  return { valid: true, reason: "교류전 규칙 A 충족" };
}

export function evaluateExchangeSchedule(schedule, players, sessions = []) {
  const validation = validateExchangeSchedule(schedule, players);
  const breakdown = {
    balance: 0,
    balanceHeavy: 0,
    duplicatePartner: 0,
    duplicateOpponent: 0,
    historyPartner: 0,
    historyOpponent: 0,
    gender: 0,
    courtBalance: 0,
  };
  const partnerCounts = new Map();
  const opponentCounts = new Map();
  const courtCounts = Array.from({ length: players.length }, () => [0, 0]);
  const weights = historyWeights(sessions);
  const courts = [];

  schedule.forEach((slot, slotIndex) => {
    slot.forEach((court, courtIndex) => {
      const [left, right] = court;
      const difference = Math.abs(teamScore(left, players) - teamScore(right, players));
      breakdown.balance += EXCHANGE_RULES.balance * difference;
      breakdown.balanceHeavy += EXCHANGE_RULES.balanceHeavy * Math.max(0, difference - 1.5);
      breakdown.gender += EXCHANGE_RULES.gender * genderMismatch(court, players);
      const leftPartner = pairKey(players[left[0]].name, players[left[1]].name);
      const rightPartner = pairKey(players[right[0]].name, players[right[1]].name);
      for (const key of [leftPartner, rightPartner]) {
        partnerCounts.set(key, (partnerCounts.get(key) ?? 0) + 1);
        breakdown.historyPartner += EXCHANGE_RULES.historyPartner * (weights.partner.get(key) ?? 0);
      }
      for (const leftIndex of left) {
        for (const rightIndex of right) {
          const key = pairKey(players[leftIndex].name, players[rightIndex].name);
          opponentCounts.set(key, (opponentCounts.get(key) ?? 0) + 1);
          breakdown.historyOpponent += EXCHANGE_RULES.historyOpponent * (weights.opponent.get(key) ?? 0);
        }
      }
      for (const index of court.flat()) courtCounts[index][courtIndex] += 1;
      courts.push({
        slotIndex,
        courtIndex,
        difference,
        matchType: slotIndex === 3 ? "클럽 혼합 복식" : "클럽 대항 복식",
      });
    });
  });

  const duplicatePartnerCount = [...partnerCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const duplicateOpponentCount = [...opponentCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  breakdown.duplicatePartner = EXCHANGE_RULES.duplicatePartner * duplicatePartnerCount;
  breakdown.duplicateOpponent = EXCHANGE_RULES.duplicateOpponent * duplicateOpponentCount;
  breakdown.courtBalance = courtCounts.reduce(
    (sum, [courtB]) => sum + EXCHANGE_RULES.courtBalance * Math.abs(courtB - 2),
    0,
  );

  const totalPenalty = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  const maxTeamDifference = Math.max(...courts.map((court) => court.difference), 0);
  const heavyCourtCount = courts.filter((court) => court.difference > 1.5).length;
  const reusedPartnerCount = [...partnerCounts.keys()].filter((key) => weights.partner.has(key)).length;
  const reusedOpponentCount = [...opponentCounts.keys()].filter((key) => weights.opponent.has(key)).length;
  const headline = !validation.valid
    ? validation.reason
    : heavyCourtCount === 0 && duplicatePartnerCount === 0
      ? "클럽 규칙과 실력 균형이 좋습니다"
      : heavyCourtCount === 0
        ? "필수 규칙을 지키며 반복을 줄였습니다"
        : "필수 규칙은 맞지만 실력 차이를 확인하세요";

  return {
    validation,
    headline,
    breakdown,
    courts,
    metrics: {
      totalPenalty,
      maxTeamDifference,
      heavyCourtCount,
      duplicatePartnerCount,
      duplicateOpponentCount,
      genderMismatchCount: courts.filter((court) => genderMismatch(schedule[court.slotIndex][court.courtIndex], players)).length,
      reusedPartnerCount,
      reusedOpponentCount,
      courtImbalanceCount: courtCounts.filter(([courtB]) => courtB !== 2).length,
      segregatedSlots: [],
    },
  };
}

function enumerateMixedSlots(tesk, gold) {
  const teamPairings = [
    [[0, 1], [2, 3]],
    [[0, 2], [1, 3]],
    [[0, 3], [1, 2]],
  ];
  return permutations(gold).flatMap((goldOrder) => {
    const teams = tesk.map((teskIndex, index) => [teskIndex, goldOrder[index]]);
    return teamPairings.map((pairing) => pairing.map(([left, right]) => [teams[left], teams[right]]));
  });
}

function finalPartnerSignature(schedule) {
  return schedule[3]
    .flatMap((court) => court.map((team) => team.slice().sort((a, b) => a - b).join("-")))
    .sort()
    .join("|");
}

export function generateExchangeCandidates({ players, sessions = [], candidateCount = 3, seed = 0, onProgress = null }) {
  const emptyValidation = validateExchangeSchedule(Array.from({ length: 4 }, () => []), players);
  if (players.length !== 8 || players.filter((player) => player.club === "TeSK").length !== 4 || players.filter((player) => player.club === "금테클").length !== 4) {
    throw new Error(emptyValidation.reason);
  }
  const tesk = players.map((player, index) => [player, index]).filter(([player]) => player.club === "TeSK").map(([, index]) => index);
  const gold = players.map((player, index) => [player, index]).filter(([player]) => player.club === "금테클").map(([, index]) => index);
  const teskSequences = permutations(partitions(tesk));
  const goldSequences = permutations(partitions(gold));
  const mixedSlots = enumerateMixedSlots(tesk, gold);
  const total = teskSequences.length * goldSequences.length * 8 * mixedSlots.length;
  const scored = [];
  let completed = 0;

  for (const teskSequence of teskSequences) {
    for (const goldSequence of goldSequences) {
      for (let mask = 0; mask < 8; mask += 1) {
        const firstThree = [0, 1, 2].map((slotIndex) => {
          const teskTeams = teskSequence[slotIndex];
          const goldTeams = goldSequence[slotIndex];
          return (mask >> slotIndex) & 1
            ? [[teskTeams[0], goldTeams[1]], [teskTeams[1], goldTeams[0]]]
            : [[teskTeams[0], goldTeams[0]], [teskTeams[1], goldTeams[1]]];
        });
        for (const mixedSlot of mixedSlots) {
          const schedule = [...firstThree, mixedSlot];
          const evaluation = evaluateExchangeSchedule(schedule, players, sessions);
          const tieBreaker = (completed + Number(seed || 0) * 997) % 1009;
          scored.push({
            schedule,
            totalPenalty: evaluation.metrics.totalPenalty,
            maxTeamDifference: evaluation.metrics.maxTeamDifference,
            tieBreaker,
          });
          completed += 1;
        }
        onProgress?.(Math.min(99, Math.round((completed / total) * 100)));
      }
    }
  }

  scored.sort((left, right) =>
    left.totalPenalty - right.totalPenalty ||
    left.maxTeamDifference - right.maxTeamDifference ||
    left.tieBreaker - right.tieBreaker,
  );
  const selected = [];
  const finalPartners = new Set();
  for (const candidate of scored) {
    const signature = finalPartnerSignature(candidate.schedule);
    if (finalPartners.has(signature)) continue;
    finalPartners.add(signature);
    selected.push(candidate);
    if (selected.length === candidateCount) break;
  }
  onProgress?.(100);
  return selected.map(({ schedule }) => ({
    schedule,
    originalSchedule: structuredClone(schedule),
    evaluation: evaluateExchangeSchedule(schedule, players, sessions),
  }));
}

export function exchangeScheduleToText(schedule, players, date) {
  const lines = [`## ${date} TeSK × 금테클 교류전`, "", "[구관 코트]"];
  schedule.forEach((slot, slotIndex) => {
    lines.push("", EXCHANGE_SLOT_LABELS[slotIndex]);
    slot.forEach((court, courtIndex) => {
      const [left, right] = court.map((team) => team.map((index) => players[index].name));
      lines.push(`${EXCHANGE_COURT_LABELS[courtIndex]}코트: ${left.join(" ")} vs ${right.join(" ")}`);
    });
  });
  return lines.join("\n");
}
