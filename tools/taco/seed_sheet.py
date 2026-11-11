"""Seed TACO using foods.seed. Credentials come only from the process environment.

Run with --dry-run first (no credentials or network needed). Never loads an env file.
Existing names are preserved by the sheet; retrying a batch is safe. No automatic retries.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import urllib.request
from pathlib import Path

TABLE = Path(__file__).resolve().parents[2] / "apps/miniapp/data/foods.taco.json"
REFERENCE = "TACO 4ª edição (NEPA/UNICAMP, 2011)"
KEYS = ["name", "kcal", "protein", "carbs", "fat", "fiber"]
BATCH_SIZE = 250


def rows() -> list[dict]:
    table = json.loads(TABLE.read_text(encoding="utf-8"))
    if table.get("table") != "taco4" or table.get("per") != "100 g" or table.get("columns") != KEYS:
        raise ValueError("invalid table schema")
    out, seen = [], set()
    for row in table["foods"]:
        if not isinstance(row, list) or len(row) != len(KEYS):
            raise ValueError("invalid food row")
        name, *values = row
        if not isinstance(name, str) or not name.strip() or name in seen:
            raise ValueError("invalid or duplicate food name")
        if any(type(v) not in (int, float) or not math.isfinite(v) or v < 0 for v in values):
            raise ValueError("invalid nutritional value")
        seen.add(name)
        out.append(dict(zip(KEYS, row), baseUnit="g", baseQty=100,
                        reference=REFERENCE, quality="TACO/fonte confiável"))
    if len(out) != 575:
        raise ValueError("expected 575 foods")
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    foods = rows()
    batches = [foods[i:i + BATCH_SIZE] for i in range(0, len(foods), BATCH_SIZE)]
    if args.dry_run:
        print(f"foods={len(foods)} batches={len(batches)}")
        for i, batch in enumerate(batches, 1):
            print(f"batch={i} foods={len(batch)}")
        return 0
    url, key = os.environ.get("SHEET_API_URL"), os.environ.get("SHEET_API_KEY")
    if not url or not key:
        raise ValueError("SHEET_API_URL and SHEET_API_KEY are required")
    for i, batch in enumerate(batches, 1):
        body = json.dumps({"key": key, "op": "foods.seed", "args": {"foods": batch}}).encode("utf-8")
        request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=120) as response:
            result = json.load(response)
        counts = result.get("result") if result.get("ok") is True else None
        if not isinstance(counts, dict) or any(type(counts.get(k)) is not int for k in ("added", "skipped", "total")):
            raise ValueError("batch refused or invalid response; stopped")
        print(f"batch={i} added={counts['added']} skipped={counts['skipped']} total={counts['total']}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Network exceptions may contain the credential-bearing URL. Never echo them.
        print("Seed failed; stopped. No credentials or response body printed.", file=sys.stderr)
        sys.exit(1)
