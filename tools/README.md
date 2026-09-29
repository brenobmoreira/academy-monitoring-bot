# tools

Python 3 + `openpyxl` (`pip install openpyxl`) helpers that move the spreadsheets between `.xlsx`
and the JSON fixtures used by the sheet 4.0 fakes (`apps/sheet4/test/fakes.js`).

| Command | What it does |
|---------|--------------|
| `python3 tools/xlsx_to_fixture.py --all` | Regenerates `apps/sheet4/test/fixtures/breno_3_0.json` and `zoio_3_0.json` from `sheets/*.xlsx` |
| `python3 tools/xlsx_to_fixture.py IN.xlsx OUT.json` | Converts any export |
| `python3 tools/fixture_to_xlsx.py IN.json OUT.xlsx` | Writes a fixture or a fake `snapshot()` back to `.xlsx`, e.g. `sheets/preview/breno_4_0.xlsx` |
| `python3 tools/check_roundtrip.py` | Checks that xlsx → json → xlsx → json is stable for `sheets/*.xlsx` |
| `node tools/migrate_preview.js [breno\|zoio\|all] [--now 2026-09-29]` | Runs the 3.0 → 4.0 migration on the fixture with `clients/<name>.json` and writes `sheets/preview/<name>_4_0.xlsx` |

To preview a migrated fake spreadsheet, dump `snapshot(ctx)` to a JSON file in a test or script
and run `fixture_to_xlsx.py` on it.

## JSON shape

```jsonc
{
  "source": "Projeto Breno — Google Sheets.xlsx",   // fixtures only; snapshot() omits it
  "namedRanges": [{"name": "X", "sheet": "Tab", "range": "A6:A44"}],
  "sheets": [{                                       // tab order
    "name": "Hoje", "hidden": false, "tabColor": "#4c356b",   // colours: lowercase #rrggbb or null
    "maxRows": 1000, "maxColumns": 32,               // grid size (getMaxRows/getMaxColumns)
    "frozenRows": 5, "frozenColumns": 0, "hiddenGridlines": true,
    "columnWidths": {"A": 261},                      // px, explicit widths only
    "rowHeights": [[1, 13, 30]],                     // [firstRow, lastRow, px] runs
    "hiddenColumns": [[14, 18]], "hiddenRows": [],   // [first, last] runs
    "columnGroups": [], "rowGroups": [],             // [first, last, depth] runs
    "values": [[], ["title"], …],                    // row-major from row 1, trailing empties trimmed, empty = null
    "merges": ["E5:L5"],
    "notes": {"B4": "text"},
    "formats": [{"ranges": ["A2"], "format": {…}}],
    "dataValidations": [{"ranges": ["B6:B1000"], "criteria": "VALUE_IN_LIST", "values": ["Sim", "Não"],
                         "allowInvalid": true, "helpText": "…", "showDropdown": false}],
    "conditionalFormats": [{"ranges": ["D44:E46"], "condition": "CUSTOM_FORMULA",
                            "values": ["=$E44=\"Na faixa\""], "format": {"background": "#dcfce7"}}],
    "protections": [{"type": "RANGE", "range": "Q6:Z1000", "description": "", "warningOnly": true,
                     "unprotectedRanges": []}],     // always [] from xlsx
    "charts": [{"type": "LINE", "position": {"row": 5, "column": 5, "offsetX": 0, "offsetY": 0},
                "ranges": ["Semanas!A5:A60"], "options": {"title": "…", "width": 1024, "height": 570}}],
    "filter": "A5:AG1000",                           // basic filter range or null
    "tables": [{"name": "RotinaDiaria", "range": "A5:AG1000"}]  // passthrough, not written to xlsx
  }]
}
```

Cell values: strings, numbers, booleans, `{"$date": "2026-09-28"}` (midnight in the spreadsheet
time zone), `{"$datetime": "2026-09-28T14:05:00"}`, `{"$time": "08:30:00"}`, and formulas
`{"$formula": "=…", "$value": <cached value from the export>}`. Array formulas are stored as
`=ARRAYFORMULA(…)` (as Apps Script's `getFormula` shows them) and written back as array formulas.

Format keys (only non-default values): `background`, `fontColor`, `fontWeight: "bold"`,
`fontStyle: "italic"`, `fontSize`, `fontFamily`, `underline`, `strikethrough`,
`horizontalAlignment` (`left|center|right`), `verticalAlignment` (`top|middle`), `wrap`,
`wrapStrategy: "CLIP"`, `numberFormat`, `borders` (`{top|left|bottom|right: {style, color}}`).
Criteria and conditions use the Apps Script enum names (`DataValidationCriteria`, `BooleanCriteria`,
`Charts.ChartType`); `VALUE_IN_RANGE` values hold the source reference (`Favoritas!$A$6:$A$1000`).

`ranges` lists are a canonical cover (row runs merged vertically, sorted by row then column),
produced the same way by `tools/sheetjson.py` and the fakes' `snapshot()`, so
`snapshot(loadFixture(x))` equals `x` minus `source`.

Not round-tripped through `.xlsx`: cached formula values, tables, protections; charts from Google
exports carry no series ranges (Sheets does not export them).
