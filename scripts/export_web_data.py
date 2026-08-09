#!/usr/bin/env python3
"""Export the canonical CSV/Markdown data for the static mobile web app."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "docs" / "data" / "app-data.json"


def load_matchup_module():
    path = ROOT / "scripts" / "matchup.py"
    spec = importlib.util.spec_from_file_location("matchup", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def render_data() -> str:
    matchup = load_matchup_module()
    levels = matchup.load_levels()
    members = matchup.load_members(levels)
    sessions = matchup.parse_history()
    payload = {
        "schemaVersion": 1,
        "rulesVersion": "5cbec4e-web-v2",
        "levels": levels,
        "members": [
            {
                "id": f"member-{index:03d}",
                "name": player.name,
                "gender": player.gender,
                "level": player.level,
                "score": player.score,
                "guest": False,
                "active": True,
            }
            for index, player in enumerate(members.values(), start=1)
        ],
        "sessions": [
            {
                "date": session["date"],
                "courts": [[list(left), list(right)] for left, right in session["courts"]],
            }
            for session in sessions
        ],
    }
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    expected = render_data()
    if args.check:
        actual = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else ""
        if actual != expected:
            raise SystemExit("docs/data/app-data.json is stale; run: python scripts/export_web_data.py")
        print("web data is up to date")
        return
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(expected, encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
