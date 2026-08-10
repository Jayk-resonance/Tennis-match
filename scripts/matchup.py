#!/usr/bin/env python3
"""테니스 동호회 주간 대진표 생성기.

사용 예)
  python3 scripts/matchup.py generate 김제우 김동원 이채윤 진혜주 조재윤 신명수 김예은 조영혜
  python3 scripts/matchup.py generate --date 2026-08-16 --guest "박게스트:남:B" 김제우 ...
  python3 scripts/matchup.py save --pick 1
  python3 scripts/matchup.py members
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import re
import sys
from collections import Counter
from dataclasses import dataclass
from datetime import date, timedelta
from heapq import heappush, heapreplace
from itertools import combinations, permutations
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
MEMBERS_CSV = DATA / "members.csv"
LEVELS_CSV = DATA / "levels.csv"
HISTORY_MD = DATA / "history.md"
PENDING_JSON = DATA / ".pending.json"

COURTS = ("K", "L")
SLOT_LABELS = ("20:00-20:50 (몸풀기 포함)", "20:50-21:25", "21:25-22:00")

# ---------------------------------------------------------------- 가중치 설정
W_BALANCE = 10.0      # 한 코트 안 두 팀의 점수 차 1점당 벌점
BAL_KNEE = 1.5        # 이 점수 차를 넘으면 '일방적인 경기'로 보고 가중 처벌
W_BAL_HEAVY = 25.0    # BAL_KNEE 초과분 1점당 추가 벌점
W_GENDER = 12.0       # 혼복/남복/여복이 아닌 코트마다 벌점 (2남2녀는 혼복이어야 함)
W_SPREAD = 0.5        # 한 코트 안 최고-최저 실력 차 1점당 벌점(약한 보정)
W_DUP_PARTNER = 25.0  # 같은 날 같은 파트너 반복 1회당 벌점
W_DUP_OPPONENT = 3.0  # 같은 날 같은 상대를 2번 만날 때 벌점
W_OPP_ALL3 = 30.0     # 같은 상대를 3타임 내내 만날 때 추가 벌점
W_HIST_PARTNER = 5.0  # 과거 파트너 이력 가중치 (팀당 1회 적용, 하루 12회)
W_HIST_OPPONENT = 1.5  # 과거 상대 이력 가중치 (쌍당 1회 적용, 하루 24회)
HIST_DECAY = 0.75     # 한 회차 거슬러 올라갈 때마다 이력 가중치 감쇠
HIST_LOOKBACK = 8     # 최근 몇 회차까지 볼지
SEG_TOLERANCE = 0.5   # '분리 타임' 판정 시 허용하는 실력 겹침 폭

K_LOCAL = 90          # 타임별 후보 중 상위 몇 개를 탐색에 쓸지
K_SEG = 24            # 분리 타임 후보 개수
K_REQ = 40            # --must-play 조건을 만족하는 타임 후보 개수


# ---------------------------------------------------------------- 데이터 로딩
@dataclass(frozen=True)
class Player:
    name: str
    gender: str  # "남" / "여"
    level: str
    score: float
    guest: bool = False


def load_levels() -> dict[str, float]:
    levels: dict[str, float] = {}
    with LEVELS_CSV.open(encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            levels[row["레벨"].strip()] = float(row["점수"])
    return levels


def load_members(levels: dict[str, float]) -> dict[str, Player]:
    members: dict[str, Player] = {}
    with MEMBERS_CSV.open(encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            name = row["이름"].strip()
            if not name:
                continue
            level = row["레벨"].strip()
            if level not in levels:
                raise SystemExit(f"[오류] '{name}'의 레벨 '{level}'이 levels.csv에 없습니다.")
            members[name] = Player(name, row["성별"].strip(), level, levels[level])
    return members


COURT_RE = re.compile(r"^([KL])코트\s*:\s*(.+)$")
DATE_RE = re.compile(r"^##\s*(\d{4}-\d{2}-\d{2})")
WAIVE_RE = re.compile(r"^>\s*의도된\s*예외\s*:\s*(.+)$")


def parse_court_line(raw: str) -> tuple[list[str], list[str]] | None:
    """'a b vs c d' → (['a','b'], ['c','d']).

    구 표기 'a b c d'(vs 없음)는 1·3번째가 한 팀이라는 규칙으로 해석합니다.
    """
    if " vs " in raw:
        left, right = raw.split(" vs ", 1)
        t1, t2 = left.split(), right.split()
        return (t1, t2) if len(t1) == len(t2) == 2 else None
    names = raw.split()
    if len(names) != 4:
        return None
    return ([names[0], names[2]], [names[1], names[3]])


def parse_history() -> list[dict]:
    """history.md → [{date, courts: [([t1a,t1b], [t2a,t2b]), ...]}, ...] (오래된 순)"""
    if not HISTORY_MD.exists():
        return []
    sessions: list[dict] = []
    current: dict | None = None
    for line in HISTORY_MD.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        m = DATE_RE.match(line)
        if m:
            current = {"date": m.group(1), "courts": [], "waived": []}
            sessions.append(current)
            continue
        m = WAIVE_RE.match(line)
        if m and current is not None:
            # "> 의도된 예외: 파트너 중복" — 점검에서 해당 항목을 눈감아 줍니다.
            current["waived"] += [x.strip() for x in m.group(1).split(",") if x.strip()]
            continue
        m = COURT_RE.match(line)
        if m and current is not None:
            teams = parse_court_line(m.group(2))
            if teams:
                current["courts"].append(teams)
    sessions.sort(key=lambda s: s["date"])
    return sessions


def history_weights(sessions: list[dict]) -> tuple[Counter, Counter]:
    """최근 회차일수록 큰 가중치로 파트너/상대 이력을 집계."""
    partner: Counter = Counter()
    opponent: Counter = Counter()
    recent = sessions[-HIST_LOOKBACK:]
    for age, sess in enumerate(reversed(recent)):
        w = HIST_DECAY ** age
        for t1, t2 in sess["courts"]:
            partner[frozenset(t1)] += w
            partner[frozenset(t2)] += w
            for a in t1:
                for b in t2:
                    opponent[frozenset((a, b))] += w
    return partner, opponent


# ------------------------------------------------------------------ 대진 탐색
Court = tuple[tuple[int, int], tuple[int, int]]
Slot = tuple[Court, Court]


def team_splits(four: tuple[int, int, int, int]) -> list[Court]:
    a, b, c, d = four
    return [((a, b), (c, d)), ((a, c), (b, d)), ((a, d), (b, c))]


def gender_type(team: tuple[int, int], players: list[Player]) -> str:
    return "".join(sorted(players[i].gender for i in team))


def gender_mismatch(c: Court, players: list[Player]) -> float:
    """0 = 혼복/남복/여복(깔끔), 1 = 그 외.

    '남남 vs 여여'(남자 2명 vs 여자 2명)도 감점 대상입니다. 코트에 2남2녀가
    있으면 실질적으로 혼복이 되어야 밸런스가 맞기 때문입니다.
    """
    g1, g2 = gender_type(c[0], players), gender_type(c[1], players)
    return 0.0 if g1 == g2 else 1.0


def enumerate_slots(players: list[Player]) -> list[Slot]:
    n = len(players)
    slots: list[Slot] = []
    for first in combinations(range(n), 4):
        if 0 not in first:
            continue
        second = tuple(i for i in range(n) if i not in first)
        for c1 in team_splits(first):
            for c2 in team_splits(second):
                slots.append((c1, c2))
    return slots


def local_penalty(slot: Slot, players: list[Player]) -> float:
    pen = 0.0
    for court in slot:
        t1, t2 = court
        s1 = players[t1[0]].score + players[t1[1]].score
        s2 = players[t2[0]].score + players[t2[1]].score
        diff = abs(s1 - s2)
        pen += W_BALANCE * diff + W_BAL_HEAVY * max(0.0, diff - BAL_KNEE)
        pen += W_GENDER * gender_mismatch(court, players)
        allp = t1 + t2
        scores = [players[i].score for i in allp]
        pen += W_SPREAD * (max(scores) - min(scores))
    return pen


def is_segregated(slot: Slot, players: list[Player]) -> bool:
    """상위권끼리 / 하위권끼리 묶인 타임인지 판정."""
    groups = []
    for court in slot:
        idx = court[0] + court[1]
        groups.append([players[i].score for i in idx])
    strong, weak = sorted(groups, key=sum, reverse=True)
    return min(strong) >= max(weak) - SEG_TOLERANCE


def slot_pairs(slot: Slot) -> tuple[list[frozenset], list[frozenset]]:
    partners, opponents = [], []
    for court in slot:
        t1, t2 = court
        partners.append(frozenset(t1))
        partners.append(frozenset(t2))
        for a in t1:
            for b in t2:
                opponents.append(frozenset((a, b)))
    return partners, opponents


def hist_key(pair: frozenset, players: list[Player]) -> frozenset | None:
    """이력 조회용 이름 쌍. 게스트가 낀 쌍은 None — 매번 다른 사람으로 봅니다."""
    if any(players[i].guest for i in pair):
        return None
    return frozenset(players[i].name for i in pair)


def global_penalty(
    slots: tuple[Slot, Slot, Slot],
    players: list[Player],
    hist_partner: Counter,
    hist_opponent: Counter,
) -> float:
    pen = 0.0
    partner_c: Counter = Counter()
    opponent_c: Counter = Counter()
    for slot in slots:
        partners, opponents = slot_pairs(slot)
        partner_c.update(partners)
        opponent_c.update(opponents)
        for pair in partners:
            key = hist_key(pair, players)
            if key:
                pen += W_HIST_PARTNER * hist_partner.get(key, 0.0)
        for pair in opponents:
            key = hist_key(pair, players)
            if key:
                pen += W_HIST_OPPONENT * hist_opponent.get(key, 0.0)
    pen += W_DUP_PARTNER * sum(c - 1 for c in partner_c.values() if c > 1)
    pen += W_DUP_OPPONENT * sum(c - 1 for c in opponent_c.values() if c > 1)
    pen += W_OPP_ALL3 * sum(1 for c in opponent_c.values() if c >= 3)
    return pen


def make_requirement(spec: str, players: list[Player]):
    """'남자게스트:남복' → 그 사람이 남복 코트에 들어가는 타임인지 판정하는 함수."""
    if ":" not in spec:
        raise SystemExit(f"[오류] --must-play 형식은 '이름:남복|여복|혼복' 입니다: {spec}")
    name, kind = (x.strip() for x in spec.split(":", 1))
    if kind not in ("남복", "여복", "혼복"):
        raise SystemExit(f"[오류] 경기 유형은 남복/여복/혼복 중 하나여야 합니다: {kind}")
    idx = next((i for i, p in enumerate(players) if p.name == name), None)
    if idx is None:
        raise SystemExit(f"[오류] 참석자에 없는 이름입니다: {name}")

    def ok(slot: Slot) -> bool:
        return any(idx in c[0] + c[1] and match_type(c, players) == kind for c in slot)
    return ok, f"{name} {kind}"


COMP_RE = re.compile(r"^(\d)남(\d)녀$")


def make_exclusion(spec: str, players: list[Player]):
    """'남자게스트:1남3녀' → 그 사람이 그런 성별 구성의 코트에 들어가는 타임을 금지."""
    if ":" not in spec:
        raise SystemExit(f"[오류] --never 형식은 '이름:N남M녀' 입니다: {spec}")
    name, comp = (x.strip() for x in spec.split(":", 1))
    m = COMP_RE.match(comp)
    if not m or int(m.group(1)) + int(m.group(2)) != 4:
        raise SystemExit(f"[오류] 코트 구성은 합이 4여야 합니다 (예: 1남3녀): {comp}")
    want_m = int(m.group(1))
    idx = next((i for i, p in enumerate(players) if p.name == name), None)
    if idx is None:
        raise SystemExit(f"[오류] 참석자에 없는 이름입니다: {name}")

    def bad(slot: Slot) -> bool:
        for c in slot:
            four = c[0] + c[1]
            if idx in four:
                return sum(1 for i in four if players[i].gender == "남") == want_m
        return False
    return bad, f"{name}는 {comp} 코트 금지"


def make_separation(spec: str, players: list[Player]):
    """'김예은,조영혜' → 두 사람이 다른 코트인 타임이 하나 이상.

    '이채윤,조영혜@3' 처럼 `@타임번호`를 붙이면 **그 타임에** 떨어뜨립니다.
    """
    pin = None
    if "@" in spec:
        spec, pos = spec.rsplit("@", 1)
        if pos not in ("1", "2", "3"):
            raise SystemExit(f"[오류] 타임 번호는 1/2/3 중 하나여야 합니다: @{pos}")
        pin = int(pos)
    parts = [x.strip() for x in spec.split(",")]
    if len(parts) != 2:
        raise SystemExit(f"[오류] --separate 형식은 '이름A,이름B' 입니다: {spec}")
    ids = []
    for n in parts:
        i = next((k for k, p in enumerate(players) if p.name == n), None)
        if i is None:
            raise SystemExit(f"[오류] 참석자에 없는 이름입니다: {n}")
        ids.append(i)
    a, b = ids

    def ok(slot: Slot) -> bool:
        return not any({a, b} <= set(c[0] + c[1]) for c in slot)
    where = f"{pin}타임" if pin else "한 타임 이상"
    return ok, f"{parts[0]}·{parts[1]} 다른 코트({where})", pin


def search(
    players: list[Player],
    hist_partner: Counter,
    hist_opponent: Counter,
    n_candidates: int = 3,
    seed: int | None = None,
    requires: list = (),
    excludes: list = (),
    pins: list = (),
    seg_slot: int = 2,
) -> list[dict]:
    """3타임을 고릅니다.

    excludes — 하나라도 걸리면 그 타임 배치를 아예 후보에서 뺍니다(모든 타임에 적용).
    requires — 3타임 중 **최소 한 타임**이 만족해야 하는 조건들.
    """
    all_slots = enumerate_slots(players)
    for pred, label in excludes:
        all_slots = [s for s in all_slots if not pred(s)]
        if not all_slots:
            raise SystemExit(f"[오류] '{label}' 조건을 만족하는 타임 배치가 없습니다.")

    rnd = random.Random(seed) if seed is not None else None
    localpen = {}
    for slot in all_slots:
        pen = local_penalty(slot, players)
        if rnd is not None:
            pen += rnd.uniform(0, 1.5)
        localpen[slot] = pen
    ordered = sorted(all_slots, key=lambda s: localpen[s])

    preds = [(lambda s: is_segregated(s, players), "실력 분리 타임")] + list(requires)

    # 후보 풀: 벌점 상위 + 각 조건을 만족하는 타임 (조건별 후보를 반드시 남김)
    pool_set = set(ordered[:K_LOCAL])
    for pred, label in preds:
        hits = [s for s in ordered if pred(s)]
        if not hits:
            raise SystemExit(f"[오류] '{label}' 조건을 만족하는 타임 배치가 없습니다.")
        pool_set.update(hits[:K_REQ])
    pool = sorted(pool_set, key=lambda s: localpen[s])
    lp = [localpen[s] for s in pool]

    # 조건 충족 여부를 비트마스크로 미리 계산해 두고 3개 조합을 훑습니다.
    full = (1 << len(preds)) - 1
    masks = [sum(1 << b for b, (pred, _) in enumerate(preds) if pred(s)) for s in pool]

    n = len(pool)
    best: list = []          # (-total, tie, trio) 최대힙 — 상위 n_candidates 유지
    bound = float("inf")     # 현재 n번째 후보의 벌점 (가지치기 기준)
    tie = 0
    for i in range(n):
        if 3 * lp[i] > bound:
            break
        for j in range(i + 1, n):
            if lp[i] + 2 * lp[j] > bound:
                break
            mij = masks[i] | masks[j]
            for k in range(j + 1, n):
                low = lp[i] + lp[j] + lp[k]
                if low > bound:      # 이후 k는 벌점이 더 크므로 중단
                    break
                if mij | masks[k] != full:
                    continue
                trio = (pool[i], pool[j], pool[k])
                if pins and not valid_orderings(trio, players, seg_slot, pins):
                    continue
                total = low + global_penalty(trio, players, hist_partner, hist_opponent)
                tie += 1
                if len(best) < n_candidates:
                    heappush(best, (-total, tie, trio))
                elif total < -best[0][0]:
                    heapreplace(best, (-total, tie, trio))
                if len(best) == n_candidates:
                    bound = -best[0][0]

    if not best:
        raise SystemExit("[오류] 모든 조건을 동시에 만족하는 대진이 없습니다.")

    out = []
    for neg, _, trio in sorted(best, key=lambda x: -x[0]):
        seg = next(s for s in trio if is_segregated(s, players))
        out.append({"penalty": -neg, "slots": trio, "seg": seg})
    return out


# ------------------------------------------------------------ 순서 / 코트 배정
def valid_orderings(trio, players: list[Player], seg_slot: int, pins=()) -> list[tuple]:
    """분리 타임을 지정 위치에 두고, 타임 지정 조건까지 맞는 배열들."""
    out = []
    for perm in permutations(trio):
        if not is_segregated(perm[seg_slot - 1], players):
            continue
        if all(pred(perm[pos - 1]) for pos, pred in pins):
            out.append(perm)
    return out


def order_slots(cand: dict, players: list[Player], seg_slot: int, pins=()) -> list[Slot]:
    opts = valid_orderings(cand["slots"], players, seg_slot, pins)
    if not opts:
        raise SystemExit("[오류] 타임 순서 조건을 만족하도록 배열할 수 없습니다.")
    # 몸풀기 타임(1타임)이 가장 안정적인 배열을 고릅니다.
    return list(min(opts, key=lambda p: [local_penalty(s, players) for s in p]))


def assign_courts(ordered: list[Slot], players: list[Player]) -> list[tuple[Court, Court]]:
    """각 타임마다 어느 코트를 K로 둘지 선택 — 선수들이 코트를 골고루 쓰도록."""
    best, best_key = None, None
    for mask in range(8):
        arranged = []
        k_count: Counter = Counter()
        for t, slot in enumerate(ordered):
            c1, c2 = slot
            if mask >> t & 1:
                c1, c2 = c2, c1
            arranged.append((c1, c2))
            for i in c1[0] + c1[1]:
                k_count[i] += 1
        spread = sum(abs(2 * k_count[i] - len(ordered)) for i in range(len(players)))
        # 동점이면 '분리 타임'의 강한 코트를 K로
        strong_k = 0
        for c1, c2 in arranged:
            s1 = sum(players[i].score for i in c1[0] + c1[1])
            s2 = sum(players[i].score for i in c2[0] + c2[1])
            strong_k += 1 if s1 >= s2 else 0
        key = (spread, -strong_k, mask)
        if best_key is None or key < best_key:
            best_key, best = key, arranged
    return best


# --------------------------------------------------------------------- 렌더링
def court_names(court: Court, players: list[Player]) -> str:
    """'김제우 김예은 vs 이채윤 조재윤' — 점수가 높은 팀을 왼쪽에 둡니다."""
    t1, t2 = court
    if sum(players[i].score for i in t1) < sum(players[i].score for i in t2):
        t1, t2 = t2, t1
    left = " ".join(players[i].name for i in t1)
    right = " ".join(players[i].name for i in t2)
    return f"{left} vs {right}"


def render_plan(arranged, players: list[Player], day: str) -> str:
    lines = [f"## {day} 코트운영", ""]
    for t, (c1, c2) in enumerate(arranged):
        lines.append(SLOT_LABELS[t])
        lines.append("K코트: " + court_names(c1, players))
        lines.append("L코트: " + court_names(c2, players))
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def fmt_score(x: float) -> str:
    return f"{x:g}"


def team_label(team: tuple[int, int], players: list[Player]) -> str:
    a, b = players[team[0]], players[team[1]]
    return f"{a.name}+{b.name}({fmt_score(a.score + b.score)})"


def match_type(c: Court, players: list[Player]) -> str:
    g1 = gender_type(c[0], players)
    g2 = gender_type(c[1], players)
    if g1 == g2 == "남남":
        return "남복"
    if g1 == g2 == "여여":
        return "여복"
    if g1 == g2 == "남여":
        return "혼복"
    return f"⚠{g1} vs {g2}"


def render_analysis(arranged, players: list[Player], hist_partner: Counter,
                    hist_opponent: Counter, seg: Slot) -> str:
    lines = ["[균형 분석]"]
    for t, (c1, c2) in enumerate(arranged):
        tag = " ← 실력 분리 타임" if is_segregated((c1, c2), players) else ""
        lines.append(f"{t + 1}타임 {SLOT_LABELS[t]}{tag}")
        for label, c in (("K", c1), ("L", c2)):
            s1 = sum(players[i].score for i in c[0])
            s2 = sum(players[i].score for i in c[1])
            lines.append(
                f"  {label}코트: {team_label(c[0], players)} vs {team_label(c[1], players)}"
                f"  | 차이 {fmt_score(abs(s1 - s2))} | {match_type(c, players)}"
            )

    partner_c: Counter = Counter()
    opponent_c: Counter = Counter()
    for c1, c2 in arranged:
        p, o = slot_pairs((c1, c2))
        partner_c.update(p)
        opponent_c.update(o)

    dup = [(pair, c) for pair, c in partner_c.items() if c > 1]
    if dup:
        txt = ", ".join(
            f"{'+'.join(players[i].name for i in pair)}×{c}" for pair, c in dup
        )
        lines.append(f"[파트너 중복] {txt}")
    else:
        lines.append(f"[파트너 중복] 없음 (총 {len(partner_c)}쌍 모두 다름)")

    dup_o = [(pair, c) for pair, c in opponent_c.items() if c > 2]
    if dup_o:
        txt = ", ".join(f"{'-'.join(players[i].name for i in pair)}×{c}" for pair, c in dup_o)
        lines.append(f"[⚠ 3타임 내내 상대] {txt}")
    else:
        lines.append("[3타임 내내 상대] 없음")

    reused = []
    for pair in partner_c:
        key = hist_key(pair, players)
        w = hist_partner.get(key, 0.0) if key else 0.0
        if w > 0:
            reused.append(f"{'+'.join(players[i].name for i in pair)}({w:.2f})")
    lines.append("[최근 파트너 재조합] " + (", ".join(reused) if reused else "없음"))

    reused_o = []
    for pair in opponent_c:
        key = hist_key(pair, players)
        w = hist_opponent.get(key, 0.0) if key else 0.0
        if w >= 1.0:
            reused_o.append(f"{'-'.join(players[i].name for i in pair)}({w:.2f})")
    lines.append("[최근 상대 재대결] " + (", ".join(sorted(reused_o)) if reused_o else "없음"))

    guests = [p.name for p in players if p.guest]
    if guests:
        lines.append(f"[게스트] {', '.join(guests)} — 매번 다른 사람으로 보고 이력 조회 안 함")

    per_player = []
    for i, p in enumerate(players):
        mates = [
            players[j].name
            for pair in partner_c
            if i in pair
            for j in pair
            if j != i
        ]
        per_player.append(f"{p.name}({p.level}): {', '.join(mates)}")
    lines.append("[선수별 파트너] " + " / ".join(per_player))
    return "\n".join(lines)


def penalty_breakdown(arranged, players: list[Player],
                      hist_partner: Counter, hist_opponent: Counter) -> str:
    """벌점이 어느 항목에서 나왔는지 항목별로 분해해서 보여줍니다."""
    slots = [(c1, c2) for c1, c2 in arranged]
    bal = heavy = gen = spread = 0.0
    for c1, c2 in slots:
        for court in (c1, c2):
            t1, t2 = court
            s1 = sum(players[i].score for i in t1)
            s2 = sum(players[i].score for i in t2)
            diff = abs(s1 - s2)
            bal += W_BALANCE * diff
            heavy += W_BAL_HEAVY * max(0.0, diff - BAL_KNEE)
            gen += W_GENDER * gender_mismatch(court, players)
            sc = [players[i].score for i in t1 + t2]
            spread += W_SPREAD * (max(sc) - min(sc))

    partner_c: Counter = Counter()
    opponent_c: Counter = Counter()
    hp = ho = 0.0
    for slot in slots:
        p, o = slot_pairs(slot)
        partner_c.update(p)
        opponent_c.update(o)
        for pair in p:
            key = hist_key(pair, players)
            if key:
                hp += W_HIST_PARTNER * hist_partner.get(key, 0.0)
        for pair in o:
            key = hist_key(pair, players)
            if key:
                ho += W_HIST_OPPONENT * hist_opponent.get(key, 0.0)
    dup_p = W_DUP_PARTNER * sum(c - 1 for c in partner_c.values() if c > 1)
    dup_o = W_DUP_OPPONENT * sum(c - 1 for c in opponent_c.values() if c > 1)
    all3 = W_OPP_ALL3 * sum(1 for c in opponent_c.values() if c >= 3)

    rows = [
        ("코트 내 팀 실력 균형", bal, f"팀 점수 차 1점당 {W_BALANCE:g}  × 코트 6개"),
        ("일방적인 코트", heavy, f"{BAL_KNEE:g}점 차 초과분 1점당 {W_BAL_HEAVY:g}"),
        ("같은 날 파트너 중복", dup_p, f"중복 1회당 {W_DUP_PARTNER:g}"),
        ("3타임 내내 같은 상대", all3, f"해당 쌍당 {W_OPP_ALL3:g}"),
        ("혼복·남복·여복 어긋남", gen, f"어긋난 코트당 {W_GENDER:g}  × 코트 6개"),
        ("최근 파트너 재조합", hp, f"이력 가중치 × {W_HIST_PARTNER:g}  × 팀 12개"),
        ("최근 상대 재대결", ho, f"이력 가중치 × {W_HIST_OPPONENT:g}  × 쌍 24개"),
        ("같은 날 상대 중복", dup_o, f"중복 1회당 {W_DUP_OPPONENT:g}"),
        ("코트 내 실력 편차", spread, f"최고-최저 1점당 {W_SPREAD:g}  × 코트 6개"),
    ]
    total = sum(r[1] for r in rows)
    out = ["[벌점 내역]  ※ '실력 분리 타임'은 벌점이 아니라 필수 조건 — 이미 통과"]
    for name, val, how in sorted(rows, key=lambda r: -r[1]):
        share = (val / total * 100) if total else 0
        out.append(f"  {name:<16} {val:6.1f}  ({share:4.1f}%)   {how}")
    out.append(f"  {'합계':<16} {total:6.1f}")
    return "\n".join(out)


# ------------------------------------------------------------------- 명령어들
def next_sunday(sessions: list[dict]) -> str:
    today = date.today()
    d = today + timedelta(days=(6 - today.weekday()) % 7)
    done = {s["date"] for s in sessions}
    while d.isoformat() in done:
        d += timedelta(days=7)
    return d.isoformat()


def resolve_players(names: list[str], members: dict[str, Player],
                    guests: list[str], levels: dict[str, float]) -> list[Player]:
    table = dict(members)
    for spec in guests:
        parts = [x.strip() for x in spec.split(":")]
        if len(parts) != 3:
            raise SystemExit(f"[오류] 게스트 형식은 '이름:성별:레벨' 입니다: {spec}")
        gname, gender, level = parts
        if gender not in ("남", "여"):
            raise SystemExit(f"[오류] 게스트 성별은 남/여 중 하나여야 합니다: {spec}")
        if level not in levels:
            raise SystemExit(f"[오류] 알 수 없는 레벨입니다: {level}")
        table[gname] = Player(gname, gender, level, levels[level], guest=True)

    players, missing = [], []
    for n in names:
        if n in table:
            players.append(table[n])
        else:
            missing.append(n)
    if missing:
        raise SystemExit(
            "[오류] 명단에 없는 이름: " + ", ".join(missing)
            + "\n  → 회원이면 data/members.csv에 추가하고, 게스트면 "
              "--guest \"이름:남:B\" 형식으로 넘기세요."
        )
    dupes = [n for n, c in Counter(p.name for p in players).items() if c > 1]
    if dupes:
        raise SystemExit("[오류] 이름이 중복됩니다: " + ", ".join(dupes))
    return players


def cmd_generate(args) -> None:
    levels = load_levels()
    members = load_members(levels)
    sessions = parse_history()
    hist_partner, hist_opponent = history_weights(sessions)

    players = resolve_players(args.names, members, args.guest, levels)
    if len(players) != 8:
        raise SystemExit(
            f"[오류] 참석자는 8명이어야 합니다 (현재 {len(players)}명). "
            "인원이 다르면 로테이션 규칙을 먼저 정해야 합니다."
        )

    day = args.date or next_sunday(sessions)
    if any(s["date"] == day for s in sessions):
        print(f"[주의] {day} 대진표가 이미 히스토리에 있습니다.\n", file=sys.stderr)

    requires, excludes, pins = [], [], []
    for spec in args.must_play:
        requires.append(make_requirement(spec, players))
    for spec in args.separate:
        pred, label, pin = make_separation(spec, players)
        requires.append((pred, label))
        if pin:
            pins.append((pin, pred))
    for spec in args.never:
        excludes.append(make_exclusion(spec, players))
    for _, label in requires:
        print(f"[추가 조건] 한 타임은 '{label}'")
    for _, label in excludes:
        print(f"[추가 조건] 모든 타임 '{label}'")
    if requires or excludes:
        print()
    cands = search(players, hist_partner, hist_opponent, n_candidates=args.top,
                   seed=args.seed, requires=requires, excludes=excludes,
                   pins=pins, seg_slot=args.seg_slot)

    payload = {"date": day, "candidates": []}
    for rank, cand in enumerate(cands, 1):
        ordered = order_slots(cand, players, args.seg_slot, pins)
        arranged = assign_courts(ordered, players)
        plan = render_plan(arranged, players, day)
        analysis = render_analysis(arranged, players, hist_partner,
                                   hist_opponent, cand["seg"])
        payload["candidates"].append(
            {"rank": rank, "penalty": round(cand["penalty"], 2),
             "plan": plan, "analysis": analysis}
        )
        print(f"===== 후보 {rank} (벌점 {cand['penalty']:.1f}) =====")
        print(plan)
        print(analysis)
        if args.explain:
            print(penalty_breakdown(arranged, players, hist_partner, hist_opponent))
        print()

    PENDING_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"→ 후보 저장됨: {PENDING_JSON.relative_to(ROOT)}")
    print("→ 확정하려면: python3 scripts/matchup.py save --pick 1")


def cmd_save(args) -> None:
    if args.from_file:
        if not args.date:
            raise SystemExit("[오류] --from 을 쓸 때는 --date 도 지정해야 합니다.")
        raw = (sys.stdin.read() if args.from_file == "-"
               else Path(args.from_file).read_text(encoding="utf-8"))
        lines = [f"## {args.date} 코트운영", ""]
        n_courts = 0
        for line in raw.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if COURT_RE.match(line):
                if not parse_court_line(COURT_RE.match(line).group(2)):
                    raise SystemExit(f"[오류] 코트 줄을 읽을 수 없습니다: {line}")
                n_courts += 1
            lines.append(line)
            if line.startswith("L코트"):
                lines.append("")
        if n_courts != 6:
            raise SystemExit(f"[오류] 코트 줄이 6개여야 합니다 (현재 {n_courts}개).")
        day, plan = args.date, "\n".join(lines).rstrip() + "\n"
        label = "직접 지정한 대진"
    else:
        if not PENDING_JSON.exists():
            raise SystemExit("[오류] 확정 대기 중인 대진표가 없습니다. 먼저 generate를 실행하세요.")
        payload = json.loads(PENDING_JSON.read_text(encoding="utf-8"))
        picks = {c["rank"]: c for c in payload["candidates"]}
        if args.pick not in picks:
            raise SystemExit(f"[오류] 후보 {args.pick}이(가) 없습니다. 가능한 값: {sorted(picks)}")
        day, plan = payload["date"], picks[args.pick]["plan"]
        label = f"후보 {args.pick}"

    sessions = parse_history()
    if any(s["date"] == day for s in sessions):
        raise SystemExit(
            f"[오류] {day} 대진표가 이미 history.md에 있습니다. "
            "덮어쓰려면 해당 항목을 먼저 지우세요."
        )

    text = HISTORY_MD.read_text(encoding="utf-8").rstrip() + "\n\n"
    HISTORY_MD.write_text(text + plan, encoding="utf-8")
    if PENDING_JSON.exists():
        PENDING_JSON.unlink()
    print(f"저장 완료: {day} {label} → data/history.md")


def plan_to_slots(text: str, players: list[Player]) -> list[Slot]:
    """대진표 텍스트 → 내부 슬롯 구조. 코트는 K, L 순서로 짝지어 읽습니다."""
    idx = {p.name: i for i, p in enumerate(players)}
    courts: list[Court] = []
    for line in text.splitlines():
        m = COURT_RE.match(line.strip())
        if not m:
            continue
        teams = parse_court_line(m.group(2))
        if not teams:
            raise SystemExit(f"[오류] 코트 줄을 읽을 수 없습니다: {line.strip()}")
        try:
            courts.append(tuple(tuple(idx[n] for n in t) for t in teams))
        except KeyError as e:
            raise SystemExit(f"[오류] 참석자 명단에 없는 이름입니다: {e.args[0]}")
    if len(courts) != 6:
        raise SystemExit(f"[오류] 코트 줄이 6개여야 합니다 (현재 {len(courts)}개).")
    return [(courts[i], courts[i + 1]) for i in range(0, 6, 2)]


def cmd_score(args) -> None:
    levels = load_levels()
    members = load_members(levels)
    sessions = parse_history()
    hist_partner, hist_opponent = history_weights(sessions)

    players = resolve_players(args.names, members, args.guest, levels)
    if len(players) != 8:
        raise SystemExit(f"[오류] 참석자는 8명이어야 합니다 (현재 {len(players)}명).")

    text = sys.stdin.read() if args.plan == "-" else Path(args.plan).read_text(encoding="utf-8")
    slots = plan_to_slots(text, players)
    arranged = [(c1, c2) for c1, c2 in slots]

    total = sum(local_penalty(s, players) for s in slots)
    total += global_penalty(tuple(slots), players, hist_partner, hist_opponent)

    segs = [i + 1 for i, s in enumerate(slots) if is_segregated(s, players)]
    print(f"===== 입력한 대진 (벌점 {total:.1f}) =====")
    print(render_plan(arranged, players, args.date or "입력 대진"))
    print(render_analysis(arranged, players, hist_partner, hist_opponent, slots[0]))
    print(penalty_breakdown(arranged, players, hist_partner, hist_opponent))
    if segs:
        print(f"[필수 조건] 실력 분리 타임 {segs}타임 — 통과")
    else:
        print("[필수 조건] ⚠ 실력 분리 타임이 없습니다 — 미통과")


def cmd_members(args) -> None:
    levels = load_levels()
    members = load_members(levels)
    rows = sorted(members.values(), key=lambda p: (-p.score, p.name))
    print(f"{'이름':<8}{'성별':<5}{'레벨':<5}{'점수'}")
    for p in rows:
        print(f"{p.name:<8}{p.gender:<5}{p.level:<5}{fmt_score(p.score)}")
    m = sum(1 for p in rows if p.gender == "남")
    print(f"\n총 {len(rows)}명 (남 {m} / 여 {len(rows) - m})")


def cmd_history(args) -> None:
    sessions = parse_history()
    if not sessions:
        raise SystemExit("[오류] 기록된 대진표가 없습니다.")
    hist_partner, _ = history_weights(sessions)
    print(f"기록된 회차: {len(sessions)}회 ({sessions[0]['date']} ~ {sessions[-1]['date']})")

    levels = load_levels()
    members = load_members(levels)
    gender = {n: p.gender for n, p in members.items()}
    gender["남자게스트"] = "남"
    gender["여자게스트"] = "여"

    print("\n[회차별 점검]")
    for s in sessions:
        cs = s["courts"]
        slots = [set(cs[i][0] + cs[i][1]) | set(cs[i + 1][0] + cs[i + 1][1])
                 for i in range(0, len(cs) - 1, 2)]
        everyone = set().union(*slots) if slots else set()
        issues = []
        if len(slots) != 3:
            issues.append(f"타임 {len(slots)}개")
        if len(everyone) != 8:
            issues.append(f"인원 {len(everyone)}명")
        if any(x != everyone for x in slots):
            issues.append("타임마다 인원 다름")

        # 2남2녀 코트인데 혼복이 아닌 경우 — 원본 표기가 애매했을 가능성
        for t1, t2 in cs:
            four = t1 + t2
            if sum(1 for x in four if gender.get(x) == "남") != 2:
                continue
            g1 = "".join(sorted(gender.get(x, "?") for x in t1))
            g2 = "".join(sorted(gender.get(x, "?") for x in t2))
            if not (g1 == g2 == "남여"):
                issues.append(f"2남2녀인데 혼복 아님({'+'.join(t1)} vs {'+'.join(t2)})")

        dup = [p for p, c in Counter(frozenset(t) for tt in cs for t in tt).items() if c > 1]
        for p in dup:
            issues.append(f"파트너 중복({'+'.join(p)})")

        waived = [i for i in issues if any(w in i for w in s["waived"])]
        remain = [i for i in issues if i not in waived]
        if remain:
            status = "확인필요 — " + " / ".join(remain)
        elif waived:
            status = "OK (의도된 예외 — " + " / ".join(waived) + ")"
        else:
            status = "OK"
        print(f"  {s['date']}  {status}")

    # 게스트(회원 명단에 없는 이름)는 매번 다른 사람이므로 이력 집계에서 뺍니다.
    member_pairs = {p: w for p, w in hist_partner.items() if all(n in members for n in p)}
    skipped = len(hist_partner) - len(member_pairs)

    print("\n[최근 파트너 빈도 상위 15쌍]")
    for pair, w in sorted(member_pairs.items(), key=lambda x: -x[1])[:15]:
        print(f"  {'+'.join(sorted(pair)):<16} {w:.2f}")
    if skipped:
        print(f"  (게스트가 낀 {skipped}쌍은 제외 — 이름이 같아도 매번 다른 사람)")


def main() -> None:
    ap = argparse.ArgumentParser(description="테니스 동호회 주간 대진표 생성기")
    sub = ap.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("generate", help="참석자 8명으로 대진표 후보 생성")
    g.add_argument("names", nargs="+", help="참석자 이름 8명")
    g.add_argument("--date", help="대진 날짜 (YYYY-MM-DD). 기본값: 다음 일요일")
    g.add_argument("--guest", action="append", default=[],
                   metavar="이름:성별:레벨", help="게스트 추가 (반복 사용 가능)")
    g.add_argument("--top", type=int, default=3, help="보여줄 후보 개수 (기본 3)")
    g.add_argument("--seg-slot", type=int, default=2, choices=(1, 2, 3),
                   help="실력 분리 타임을 몇 번째 타임에 둘지 (기본 2)")
    g.add_argument("--seed", type=int, help="다른 조합을 뽑고 싶을 때 주는 난수 시드")
    g.add_argument("--must-play", action="append", default=[],
                   metavar="이름:남복|여복|혼복",
                   help="한 타임은 지정한 사람이 해당 유형 경기를 하도록 보장")
    g.add_argument("--separate", action="append", default=[], metavar="이름A,이름B[@타임]",
                   help="두 사람을 다른 코트에 배치. @1/@2/@3 을 붙이면 그 타임에 고정")
    g.add_argument("--never", action="append", default=[], metavar="이름:N남M녀",
                   help="모든 타임에서 그 사람이 해당 성별 구성 코트에 못 들어가게 함")
    g.add_argument("--explain", action="store_true",
                   help="벌점이 어느 항목에서 나왔는지 항목별로 분해해서 보여줍니다")
    g.set_defaults(func=cmd_generate)

    sc = sub.add_parser("score", help="직접 짠 대진표를 채점")
    sc.add_argument("plan", help="대진표 텍스트 파일 경로 ('-' 이면 표준입력)")
    sc.add_argument("names", nargs="+", help="참석자 이름 8명")
    sc.add_argument("--guest", action="append", default=[], metavar="이름:성별:레벨")
    sc.add_argument("--date", help="표시용 날짜")
    sc.set_defaults(func=cmd_score)

    s = sub.add_parser("save", help="확정한 대진표를 히스토리에 저장")
    s.add_argument("--pick", type=int, default=1, help="확정할 후보 번호 (기본 1)")
    s.add_argument("--from", dest="from_file", metavar="파일",
                   help="후보 대신 직접 짠 대진표 파일을 저장 ('-' 이면 표준입력). --date 필요")
    s.add_argument("--date", help="--from 과 함께 쓰는 대진 날짜 (YYYY-MM-DD)")
    s.set_defaults(func=cmd_save)

    m = sub.add_parser("members", help="회원 명단 출력")
    m.set_defaults(func=cmd_members)

    h = sub.add_parser("history", help="히스토리 요약 출력")
    h.set_defaults(func=cmd_history)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:  # head/less 등으로 파이프가 닫힌 경우
        sys.stdout = None
        sys.exit(0)
