"""Builds the shared food table from TACO, 4th edition (NEPA/UNICAMP, 2011).

Input: the spreadsheet `taco_phase_1_no_format.xlsx` of github.com/raulfdm/taco-api (MIT), at a
pinned commit and checked by SHA-256. That file is the original TACO table without formatting; it
still carries the table's own markers, which the repo's CSV export has lost:

    Tr   trace                      -> 0
    NA   not applicable             -> 0   (the nutrient is not expected in that food)
    *    being re-analysed, or an empty cell -> unknown

A food with an unknown kcal, protein, fat, carbohydrate or fibre is LEFT OUT (never guessed) and
listed in the report. Values are per 100 g of edible portion, rounded as TACO publishes them:
kcal to a whole number, grams to one decimal. Names are TACO's, unchanged.

Output: apps/miniapp/data/foods.taco.json, read by the Mini App page. tools/taco/seed_sheet.py
sends the same rows to a client's Alimentos tab, so the page and the sheet cannot disagree.
Also writes src/agent/data/foods.taco.names.json inside the agent package. --names-only rebuilds
that package resource from the already generated page table, without downloading the source.

Run:  python tools/taco/build_foods.py [path/to/taco_phase_1_no_format.xlsx]
Without a path the file is downloaded. Standard library only.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import urllib.request
import zipfile
from io import BytesIO
from pathlib import Path

COMMIT = "06e466ad2f3d76064b587808b1804564b2c40f67"
URL = (
    "https://raw.githubusercontent.com/raulfdm/taco-api/"
    f"{COMMIT}/references/normalization/taco_phase_1_no_format.xlsx"
)
SHA256 = "e287b4a56eb8e01735e4a6f95c40c0e5815dda42062ec9889d5025ccbfc71911"
REFERENCE = "TACO 4ª edição (NEPA/UNICAMP, 2011)"

# column header in the spreadsheet -> (our key, decimals)
COLUMNS = {
    "kcal": ("kcal", 0),
    "Proteína (g)": ("protein", 1),
    "Carboidratros (g)": ("carbs", 1),  # sic: the spreadsheet's spelling
    "Lipídeos (g)": ("fat", 1),
    "Fibra Alimentar (g)": ("fiber", 1),
}
ZERO = {"Tr", "NA"}

ROOT = Path(__file__).resolve().parents[2]
PAGE_FILE = ROOT / "apps" / "miniapp" / "data" / "foods.taco.json"
NAMES_FILE = ROOT / "services" / "agent" / "src" / "agent" / "data" / "foods.taco.names.json"


def write_names(names: list[str]) -> None:
    NAMES_FILE.parent.mkdir(parents=True, exist_ok=True)
    NAMES_FILE.write_text(json.dumps(names, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def read_sheet(data: bytes) -> list[dict[str, str]]:
    """The first worksheet as rows of {header: cell text}; empty cells are absent."""
    book = zipfile.ZipFile(BytesIO(data))
    shared = book.read("xl/sharedStrings.xml").decode("utf-8")
    strings = [re.sub(r"<[^>]+>", "", s) for s in re.findall(r"<si>(.*?)</si>", shared, flags=re.DOTALL)]
    sheet = book.read("xl/worksheets/sheet1.xml").decode("utf-8")
    rows = []
    for row in re.findall(r"<row [^>]*>(.*?)</row>", sheet, flags=re.DOTALL):
        cells = {}
        for col, attrs, body in re.findall(r'<c r="([A-Z]+)\d+"([^>]*?)(?:/>|>(.*?)</c>)', row, flags=re.DOTALL):
            value = re.search(r"<v>(.*?)</v>", body or "")
            if value is None:
                continue
            text = value.group(1)
            cells[col] = strings[int(text)] if 't="s"' in attrs else text
        rows.append(cells)
    header = rows[0]
    return [{header[col]: text for col, text in row.items() if col in header} for row in rows[1:]]


def number(cell: str | None, decimals: int) -> float | int | None:
    """The cell as a number, 0 for a TACO zero marker, None when the table does not know."""
    if cell is None:
        return None
    text = cell.strip()
    if text in ZERO:
        return 0
    try:
        value = float(text)
    except ValueError:
        return None
    if value < 0:
        return None
    return round(value) if decimals == 0 else round(value, decimals)


def build(rows: list[dict[str, str]]) -> tuple[list[dict], list[str]]:
    foods, left_out, seen = [], [], set()
    for row in rows:
        name = " ".join((row.get("descricao") or "").split())
        if not name:
            continue
        values = {key: number(row.get(col), dec) for col, (key, dec) in COLUMNS.items()}
        unknown = [key for key, value in values.items() if value is None]
        if unknown:
            left_out.append(f"{name} (sem {', '.join(unknown)})")
            continue
        if name.lower() in seen:
            raise SystemExit(f"duplicate food name in TACO: {name}")
        seen.add(name.lower())
        foods.append({"name": name, **values})
    return foods, left_out


def main() -> None:
    if sys.argv[1:] == ["--names-only"]:
        table = json.loads(PAGE_FILE.read_text(encoding="utf-8"))
        write_names([row[0] for row in table["foods"]])
        print(f"{len(table['foods'])} package names written")
        return
    if len(sys.argv) > 1:
        data = Path(sys.argv[1]).read_bytes()
    else:
        with urllib.request.urlopen(URL, timeout=60) as response:
            data = response.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != SHA256:
        raise SystemExit(f"unexpected file: sha256 {digest}, wanted {SHA256}")

    foods, left_out = build(read_sheet(data))
    keys = ["name", "kcal", "protein", "carbs", "fat", "fiber"]
    page = {
        "table": "taco4",
        "source": REFERENCE,
        "per": "100 g",
        "columns": keys,
        "foods": [[food[k] for k in keys] for food in foods],
    }
    PAGE_FILE.parent.mkdir(parents=True, exist_ok=True)
    PAGE_FILE.write_text(json.dumps(page, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    write_names([food["name"] for food in foods])

    print(f"{len(foods)} foods written, {len(left_out)} left out")
    for line in left_out:
        print("  left out:", line)


if __name__ == "__main__":
    main()
