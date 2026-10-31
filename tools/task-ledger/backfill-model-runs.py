#!/usr/bin/env python3
"""過去の作業役の起動値を、Pi の会話の記録から数える（読むだけ。台帳にも記録にも書かない）。

Pi の会話の記録（~/.local/share/herdr/pi-sessions/**/*.jsonl）の cwd が、台帳の仕事の作業用コピー（tasks.workdir）と
一致し、model_change と thinking_level_change の両方が残っている会話を 1 回として数える。
合わない会話・値が残っていない会話は数えず、既定の値で推測して埋めない。fast の有無は会話の記録に残らないので null。
台帳への書き込みは、取り込み後に Claude が結果を見て行う。
"""
import argparse, json, sqlite3
from datetime import datetime
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('--db', default=str(Path.home() / '.local/share/task-ledger/ledger.sqlite'))
p.add_argument('--sessions', default=str(Path.home() / '.local/share/herdr/pi-sessions'))
p.add_argument('--before', help='この時刻（ISO-8601）以前に始まった会話だけを数える')
a = p.parse_args()

before = datetime.fromisoformat(a.before.replace('Z', '+00:00')) if a.before else None
db = sqlite3.connect(f'file:{Path(a.db).resolve()}?mode=ro', uri=True)
by_cwd = {str(Path(workdir).resolve()): task for task, workdir in db.execute('SELECT id, workdir FROM tasks WHERE workdir IS NOT NULL')}
db.close()

runs = []
for path in sorted(Path(a.sessions).rglob('*.jsonl')):
    try:
        records = [json.loads(line) for line in path.read_text(errors='replace').splitlines() if line.strip()]
    except (OSError, ValueError):
        continue
    session = next((x for x in records if x.get('type') == 'session'), {})
    if before:
        try:
            if datetime.fromisoformat(session['timestamp'].replace('Z', '+00:00')) > before:
                continue
        except (KeyError, ValueError, TypeError):
            continue
    cwd = session.get('cwd')
    task = by_cwd.get(str(Path(cwd).resolve())) if cwd else None
    model = next((x for x in records if x.get('type') == 'model_change'), None)
    thinking = next((x for x in records if x.get('type') == 'thinking_level_change'), None)
    if task and model and thinking:
        runs.append({'task': task, 'session': str(path), 'startedAt': session.get('timestamp'), 'provider': model.get('provider'),
                     'model': model.get('modelId'), 'effort': thinking.get('thinkingLevel'), 'fast': None})

print(json.dumps({'matchedRuns': len(runs), 'matchedTasks': len({r['task'] for r in runs}), 'runs': runs}, ensure_ascii=False, indent=2))
