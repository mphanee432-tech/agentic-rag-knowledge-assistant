#!/usr/bin/env python3
"""Install an automatic 50-case gate report into the *existing* Enterprise evaluator.

Non-destructive: inserts a hook immediately before the evaluator's __main__ block,
backs up the original, preserves main(), flags, 429 retries and resume logic.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import re

MARKER = '# === ENTERPRISE_AUTO_REPORT_V1 ==='

# Inserted without changing the evaluator's existing main() or its CLI parser.
HOOK = r'''
# === ENTERPRISE_AUTO_REPORT_V1 ===
# Added by install_enterprise_eval_auto_report.py. Your existing main() and CLI remain unchanged.
def _enterprise_autoreport_arg(name, default):
    import sys
    args = sys.argv[1:]
    for position, value in enumerate(args):
        if value == name and position + 1 < len(args):
            return args[position + 1]
        if value.startswith(name + '='):
            return value.split('=', 1)[1]
    return default


def _enterprise_autoreport_fingerprint(path):
    import hashlib
    try:
        info = path.stat()
        return (info.st_mtime_ns, info.st_size, hashlib.sha256(path.read_bytes()).digest())
    except OSError:
        return None


_enterprise_autoreport_original_main = main

def main(*args, **kwargs):
    import json
    import sys
    from pathlib import Path

    # A validation/help command should never report old evaluation results.
    if '--validate' in sys.argv[1:] or '--help' in sys.argv[1:] or '-h' in sys.argv[1:]:
        return _enterprise_autoreport_original_main(*args, **kwargs)

    result_file = Path(_enterprise_autoreport_arg('--output', 'enterprise_eval_results.json'))
    before = _enterprise_autoreport_fingerprint(result_file)
    try:
        return _enterprise_autoreport_original_main(*args, **kwargs)
    finally:
        after = _enterprise_autoreport_fingerprint(result_file)
        if after is None or after == before:
            print('[Enterprise gate report] No fresh result file; skipping to avoid a stale report.', flush=True)
        else:
            try:
                from enterprise_eval_release_gates import build_report, print_report
                suite_file = Path(_enterprise_autoreport_arg('--suite', str(Path(__file__).with_name('enterprise_golden_50.json'))))
                result_data = json.loads(result_file.read_text(encoding='utf-8'))
                suite_data = json.loads(suite_file.read_text(encoding='utf-8')) if suite_file.is_file() else None
                report = build_report(result_data, suite_data, result_file)
                report_file = result_file.with_name('enterprise_eval_release_report.json')
                report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
                print_report(report)
                print('Saved:', report_file, flush=True)
                # The original evaluator's exit status is intentionally preserved.
            except Exception as report_error:
                print(f'[Enterprise gate report] Unable to create report: {type(report_error).__name__}: {report_error}', file=sys.stderr, flush=True)
# === END ENTERPRISE_AUTO_REPORT_V1 ===
'''.strip('\n')


def install(script: Path) -> str:
    if not script.is_file():
        raise FileNotFoundError(f'Evaluator not found: {script}')
    raw = script.read_bytes()
    newline = '\r\n' if b'\r\n' in raw else '\n'
    had_bom = raw.startswith(b'\xef\xbb\xbf')
    source = raw.decode('utf-8-sig').replace('\r\n', '\n')
    if MARKER in source:
        return f'Already installed: {script}'
    if re.search(r'(?m)^\s*(?:async\s+)?def\s+main\s*\(', source) is None:
        raise ValueError('No main() function; refusing to modify an unfamiliar evaluator')
    matches = list(re.finditer(r'(?m)^if\s+__name__\s*==\s*[\'\"]__main__[\'\"]\s*:', source))
    if len(matches) != 1:
        raise ValueError('Expected one top-level __main__ block; refusing to modify this evaluator')
    boundary = matches[0].start()
    patched = source[:boundary].rstrip() + '\n\n' + HOOK + '\n\n' + source[boundary:]
    # Do not overwrite an existing backup from an earlier version.
    backup = script.with_name(script.name + '.before_auto_report.bak')
    if backup.exists():
        raise FileExistsError(f'Backup already exists but hook is absent: {backup}. Review before retrying.')
    backup.write_bytes(raw)
    try:
        compile(patched, str(script), 'exec')
        encoded = patched.replace('\n', newline).encode('utf-8')
        if had_bom:
            encoded = b'\xef\xbb\xbf' + encoded
        script.write_bytes(encoded)
    except Exception:
        script.write_bytes(raw)
        raise
    return f'Installed automatic release report in {script}\nBackup: {backup}'


def main():
    parser = argparse.ArgumentParser(description='Add automatic portfolio benchmark report to your existing evaluator')
    parser.add_argument('--script', type=Path, default=Path(__file__).resolve().parent / 'run_enterprise_decisions_eval.py')
    args = parser.parse_args()
    try:
        print(install(args.script))
    except (OSError, UnicodeError, ValueError, SyntaxError) as exc:
        parser.exit(2, f'Installation stopped: {exc}\n')


if __name__ == '__main__':
    main()
