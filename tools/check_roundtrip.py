#!/usr/bin/env python3
"""Round-trip check: xlsx -> json -> xlsx -> json must be stable for the 3.0 exports.

Usage: python3 tools/check_roundtrip.py [FILE.xlsx ...]   (defaults to sheets/*.xlsx)

Ignored on purpose (not written back by fixture_to_xlsx.py): cached formula values ($value),
tables and the `source` file name. Exit code 1 and a list of differences on failure.
"""
import glob
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fixture_to_xlsx  # noqa: E402
import xlsx_to_fixture  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def normalize(node):
    if isinstance(node, dict):
        return {k: normalize(v) for k, v in node.items() if k not in ('$value', 'tables', 'source')}
    if isinstance(node, list):
        return [normalize(v) for v in node]
    return node


def diff(a, b, path='', out=None):
    out = [] if out is None else out
    if len(out) > 40:
        return out
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                out.append(f'{path}.{k}: only in {"first" if k in a else "second"}')
            else:
                diff(a[k], b[k], f'{path}.{k}', out)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append(f'{path}: length {len(a)} != {len(b)}')
        for i, (x, y) in enumerate(zip(a, b)):
            diff(x, y, f'{path}[{i}]', out)
    elif a != b:
        out.append(f'{path}: {json.dumps(a, ensure_ascii=False)[:120]} != {json.dumps(b, ensure_ascii=False)[:120]}')
    return out


def check(path):
    first = normalize(xlsx_to_fixture.convert(path))
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, 'roundtrip.xlsx')
        fixture_to_xlsx.convert(first, out)
        second = normalize(xlsx_to_fixture.convert(out))
    return diff(first, second)


def main(argv):
    files = argv[1:] or sorted(glob.glob(os.path.join(ROOT, 'sheets', '*.xlsx')))
    failed = False
    for f in files:
        problems = check(f)
        print(f'{"OK  " if not problems else "FAIL"} {os.path.relpath(f, ROOT)}')
        for p in problems:
            print('   ', p)
        failed = failed or bool(problems)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
