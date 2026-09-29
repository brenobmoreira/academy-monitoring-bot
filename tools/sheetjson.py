"""Shared helpers for the xlsx <-> JSON fixture tools.

The JSON shape is documented in tools/README.md and mirrored by the Node fakes
(apps/sheet4/test/fakes.js: loadFixture / snapshot). Both sides use the same
canonical encodings so that fixture -> fake -> snapshot and
xlsx -> json -> xlsx -> json are stable.
"""
import re

# Google Sheets exports widths as px / (100 / 12.63): the default 100 px column is 12.63.
PX_PER_WIDTH_UNIT = 100 / 12.63
PX_PER_POINT = 4 / 3

APPS_SCRIPT_DEFAULTS = {
    'fontFamily': 'Arial',
    'fontSize': 10,
    'fontColor': '#000000',
    'background': '#ffffff',
    'numberFormat': 'General',
}


def col_letters(n):
    s = ''
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def col_index(letters):
    n = 0
    for ch in letters.upper():
        n = n * 26 + ord(ch) - 64
    return n


def a1(r1, c1, r2=None, c2=None):
    start = f'{col_letters(c1)}{r1}'
    if r2 is None or (r1 == r2 and c1 == c2):
        return start
    return f'{start}:{col_letters(c2)}{r2}'


_A1 = re.compile(r'^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$', re.I)


def parse_a1(ref):
    m = _A1.match(ref)
    if not m:
        raise ValueError(f'bad A1 ref {ref!r}')
    r1, c1 = int(m.group(2)), col_index(m.group(1))
    if m.group(3):
        return r1, c1, int(m.group(4)), col_index(m.group(3))
    return r1, c1, r1, c1


def cells_to_ranges(cells):
    """Canonical rectangle cover of a set of (row, col): row runs, then vertical merge.

    Must stay identical to rectsFromCells() in apps/sheet4/test/fakes.js.
    """
    by_row = {}
    for r, c in cells:
        by_row.setdefault(r, []).append(c)
    open_rects = {}  # (c1, c2) -> [r1, r2]
    done = []
    for r in sorted(by_row):
        cols = sorted(set(by_row[r]))
        runs = []
        start = prev = cols[0]
        for c in cols[1:]:
            if c == prev + 1:
                prev = c
                continue
            runs.append((start, prev))
            start = prev = c
        runs.append((start, prev))
        next_open = {}
        for run in runs:
            rect = open_rects.pop(run, None)
            if rect is not None and rect[1] == r - 1:
                rect[1] = r
            else:
                if rect is not None:
                    done.append((rect[0], run[0], rect[1], run[1]))
                rect = [r, r]
            next_open[run] = rect
        for run, rect in open_rects.items():
            done.append((rect[0], run[0], rect[1], run[1]))
        open_rects = next_open
    for run, rect in open_rects.items():
        done.append((rect[0], run[0], rect[1], run[1]))
    done.sort()
    return [a1(r1, c1, r2, c2) for r1, c1, r2, c2 in done]


def range_cells(ref):
    r1, c1, r2, c2 = parse_a1(ref)
    return [(r, c) for r in range(r1, r2 + 1) for c in range(c1, c2 + 1)]


def first_cell_key(ranges):
    r1, c1, _, _ = parse_a1(ranges[0])
    return (r1, c1)


def runs(sorted_items):
    """[(index, value)] sorted by index -> [[start, end, value]] for consecutive equal values."""
    out = []
    for i, v in sorted_items:
        if out and out[-1][1] == i - 1 and out[-1][2] == v:
            out[-1][1] = i
        else:
            out.append([i, i, v])
    return out


def norm_number(v):
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def quote_sheet(name):
    if re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', name):
        return name
    return "'" + name.replace("'", "''") + "'"
