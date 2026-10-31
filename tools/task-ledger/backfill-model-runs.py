#!/usr/bin/env python3
"""Read-only inventory of Pi session records that can be joined to ledger worktrees."""
import argparse, json, sqlite3
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('--db', default=str(Path.home()/'.local/share/task-ledger/ledger.sqlite'))
p.add_argument('--sessions', default=str(Path.home()/'.local/share/herdr/pi-sessions'))
p.add_argument('--before', help='include only sessions whose session timestamp is at or before this ISO-8601 time')
a = p.parse_args()
before = __import__('datetime').datetime.fromisoformat(a.before.replace('Z', '+00:00')) if a.before else None
db = sqlite3.connect(f'file:{Path(a.db).resolve()}?mode=ro', uri=True)
db.row_factory = sqlite3.Row
rows = db.execute("SELECT id,workdir FROM tasks WHERE workdir IS NOT NULL").fetchall()
by_cwd = {str(Path(r['workdir']).resolve()): r['id'] for r in rows}
matched = {}
for path in Path(a.sessions).rglob('*.jsonl'):
    try:
        records = [json.loads(line) for line in path.read_text(errors='replace').splitlines() if line.strip()]
    except (OSError, ValueError):
        continue
    session = next((x for x in records if x.get('type') == 'session'), {})
    if before:
        try:
            timestamp = __import__('datetime').datetime.fromisoformat(session['timestamp'].replace('Z', '+00:00'))
            if timestamp > before: continue
        except (KeyError, ValueError, TypeError):
            continue
    cwd = session.get('cwd')
    task = by_cwd.get(str(Path(cwd).resolve())) if cwd else None
    if not task: continue
    model = next((x for x in records if x.get('type') == 'model_change'), None)
    thinking = next((x for x in records if x.get('type') == 'thinking_level_change'), None)
    if model and thinking:
        matched.setdefault(task, []).append({'task':task,'session':str(path),'provider':model.get('provider'),'model':model.get('modelId'),'effort':thinking.get('thinkingLevel')})
print(json.dumps({'matchedRuns':sum(map(len,matched.values())),'matchedTasks':len(matched),'runs':sum(matched.values(),[])},ensure_ascii=False,indent=2))
