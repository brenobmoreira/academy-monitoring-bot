"""Offline URL-budget fixture: the 110 stored client foods and the dev workout plan.

No credentials, environment files, network or sheet calls. Nutrients are copied verbatim from
clients/luan_alimentos.tsv and the generated TACO file. Run with the agent's PYTHONPATH=src.
"""

import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def catalog_fixture(with_table: bool = True) -> dict:
    sample = json.loads((ROOT / "apps/miniapp/dev/sample-catalog.json").read_text(encoding="utf-8"))
    with (ROOT / "clients/luan_alimentos.tsv").open(encoding="utf-8", newline="") as stream:
        foods = list(csv.reader(stream, delimiter="\t"))[1:]
    rows = [[r[0], r[1], *[float(v) for v in r[2:7]], r[12] or None,
             float(r[13]) if r[13] else None] for r in foods]
    names = [r[0] for r in foods]
    if with_table:
        table = json.loads((ROOT / "apps/miniapp/data/foods.taco.json").read_text(encoding="utf-8"))
        # Same behavior as foods.seed: matching names stay as they were.
        present = {" ".join(n.lower().split()) for n in names}
        for r in table["foods"]:
            if " ".join(r[0].lower().split()) not in present:
                rows.append([r[0], "g", 100, *r[1:5], None, None])
                names.append(r[0])
    return {
        "today": sample["today"], "timezone": sample["tz"], "client": {"name": "Cliente Teste"},
        "nextSession": sample["next"], "sessions": sample["sessions"],
        "plan": [{"session": r["s"], "exercise": r["e"], "group": r.get("g"),
                  "prescription": r.get("p"), "lastWork": {"text": r.get("l")}} for r in sample["plan"]],
        "exercises": [{"name": r[0], "group": r[1]} for r in sample["ex"]],
        "recentGroups": [{"group": "Peito", "sets": 6}, {"group": "Costas", "sets": 8}],
        "foods": names, "foodTable": rows, "favorites": sample.get("fav", []),
        "meals": sample["meals"], "units": sample["units"],
    }


if __name__ == "__main__":
    from agent.miniapp import catalog_v1, keyboard_markup

    for shared in (False, True):
        cat = catalog_fixture(shared)
        for budget in (10**6, 4096):
            markup, dropped = keyboard_markup("https://example.github.io/academy-monitoring-bot/apps/miniapp/", cat, budget)
            print(json.dumps({"shared": shared, "budget": budget,
                              "foods": len(cat["foods"]), "own": len(catalog_v1(cat)["foods"]),
                              "lengths": [len(b["web_app"]["url"]) for b in markup["keyboard"][0]],
                              "dropped": dropped}))
