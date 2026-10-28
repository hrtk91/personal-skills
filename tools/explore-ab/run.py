#!/usr/bin/env python3
"""過去の仕事を、作業役のシステムプロンプト A（今のまま）と B（探索の 1 項を足す）で流し直して比べる。

- 作業用のコピーは ~/.cache/explore-ab/ws/<無作為の名前>/project に作る（名前に A・B を入れない）。
- 作業役のシステムプロンプトと Pi のセッションは作業用のコピーの外（results と ~/.cache/explore-ab/sessions）に置く。
- 確かめは台帳と同じく、落ちたら 1 回流し直す（tools/task-ledger/advance.ts の checkTwice）。
- レビューは台帳と同じ呼び方（advance.ts の reviewPrompt と realAdvanceDeps.review）。確かめが 2 回とも落ちた回は、
  台帳ならレビューに進まず差し戻すので「直す（確かめが落ちた）」と記録し、参考として同じレビューも呼ぶ（rubric の
  「すでに通っています」の 1 文だけ「落ちました」に替える）。
- 同じ仕事の A と B を同時に流す。実装と確かめは同時に 2 本まで。レビューは別の流れで、次の仕事と重なってよい。
- 新しい組を出す前に、1 分の負荷が LOAD_LIMIT を超えていれば待つ。作業役と確かめは nice で動かす。
"""
from __future__ import annotations
import argparse, concurrent.futures, datetime as dt, json, os, pathlib, secrets, shutil, sqlite3, subprocess, threading, time

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
ART = HERE / "results"
CACHE = pathlib.Path.home() / ".cache/explore-ab"
SOURCE = pathlib.Path.home() / "repos/random-image-genarator"
LEDGER = pathlib.Path.home() / ".local/share/task-ledger/ledger.sqlite"
PI_SYSTEM = ROOT / "skills/herdr/agents/pi-system.md"
RUBRIC = ROOT / "tools/task-ledger/review-prompt.md"
BULLET = "- 取り掛かる前に、依頼に関わる所を隅々まで読んで把握する。依頼文が挙げたファイルだけでなく、それを呼ぶ所・呼ばれる所・同じ名前や同じ役目の既存の部品・関係する検査と過去の報告を探し、何がどうつながっているかを設計の下見に書いてから、変更を始める"
PASSED_LINE = "確かめのコマンドはすでに通っています（出力の終わりを下に付けます）。通ったことを理由に「通す」にしないでください。"
FAILED_LINE = "確かめのコマンドは落ちました（出力の終わりを下に付けます）。"
LOAD_LIMIT = float(os.environ.get("LOAD_LIMIT", "19"))
NICE = os.environ.get("NICE", "10")
IMPL_TIMEOUT = int(os.environ.get("IMPL_TIMEOUT", "5400"))
CHECK_TIMEOUT = 60 * 60
REVIEW_TIMEOUT = 30 * 60
# 出発点 base は、その仕事の 1 回目の実装のコミットの親（git log -1 --format=%p）。依頼文 request は 1 回目に渡した版がある
# コミット（-2 は依頼文が本体に無く、1 回目の実装のコミットに入っている。ほかは base かその前に入っている）。
TASKS = {
 "2": {"id": "random-image-genarator-2", "slug": "e2e-flaky-under-load", "base": "9aa1336d19d9439bd09b3beeee5f1ce6a0d828a6", "request": "2cdfe2f6344acf1c34803c81e1eec543b4bf1ec0"},
 "6": {"id": "random-image-genarator-6", "slug": "taste-ask-wire", "base": "717c43351e32e734e9d79e822c0d0ee397a427c8", "request": "795540d0f01f24782c21779664559b889a0e1bf0"},
 "9": {"id": "random-image-genarator-9", "slug": "taste-hypotheses-zero", "base": "34759fda483ed6ce0b87fd5c947b201afff9742c", "request": "34759fda483ed6ce0b87fd5c947b201afff9742c"},
 "12": {"id": "random-image-genarator-12", "slug": "taste-hypotheses-visual", "base": "1107d26137f0b1d105016cb6723b5f5f3634257a", "request": "e1d5fc8357d7dfdec938d82d2f66c2fd0109d0eb"},
}
GIT_ID = ["-c", "user.name=Pi", "-c", "user.email=pi@noreply.invalid"]
print_lock = threading.Lock()


def say(*parts):
    with print_lock:
        print(dt.datetime.now().strftime("%H:%M:%S"), *parts, flush=True)


def run(cmd, cwd=None, env=None, timeout=None, log=None, stdin=None):
    start = time.monotonic()
    p = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
    timed_out = False
    try:
        out, _ = p.communicate(stdin, timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(p.pid, 15)
        try:
            out, _ = p.communicate(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, 9); out, _ = p.communicate()
    # 子が残した孫（e2e のサーバー、負荷の node -e など）も片付ける
    try: os.killpg(p.pid, 9)
    except ProcessLookupError: pass
    if log: pathlib.Path(log).write_text(out)
    return {"exit": 124 if timed_out else p.returncode, "seconds": round(time.monotonic() - start, 1), "output": out, "timed_out": timed_out}


def clean_env():
    env = os.environ.copy()
    for key in ("AGENT_CHANNEL_SUPERVISOR", "HERDR_RUN_SELF", "PI_SERVICE_TIER", "HERDR_PANE_ID", "HERDR_TAB_ID", "CLAUDECODE"):
        env.pop(key, None)
    env["TMPDIR"] = "/tmp"
    return env


def ledger_tasks():
    """台帳の題・なぜ・確かめのコマンド・依頼文の場所を読む（読むだけ）。"""
    db = sqlite3.connect(f"file:{LEDGER}?mode=ro", uri=True)
    out = {}
    for key, cfg in TASKS.items():
        title, why, check, brief = db.execute("select title, why, \"check\", brief from tasks where id=?", (cfg["id"],)).fetchone()
        out[key] = {**cfg, "title": title, "why": why, "check": check, "brief": brief}
    db.close()
    return out


def system_prompt(arm):
    text = PI_SYSTEM.read_text()
    if arm == "B":
        head = "## 基本方針\n\n"
        if text.count(head) != 1: raise RuntimeError("pi-system.md に「## 基本方針」が 1 つだけ無い")
        text = text.replace(head, head + BULLET + "\n", 1)
    return text


def git(repo, *args, timeout=600):
    r = run(["git", *GIT_ID, *args], cwd=repo, timeout=timeout)
    if r["exit"]: raise RuntimeError(f"git {' '.join(args)}: {r['output'][-1500:]}")
    return r["output"]


def setup(cfg, arm, dest):
    ws = CACHE / "ws" / secrets.token_hex(8); repo = ws / "project"; logs = ws / "logs"
    logs.mkdir(parents=True)
    git(ws, "clone", "--quiet", "--shared", "--no-checkout", str(SOURCE), str(repo))
    git(repo, "remote", "remove", "origin")
    git(repo, "checkout", "--quiet", "--detach", cfg["base"])
    brief = repo / cfg["brief"]
    original = subprocess.check_output(["git", "show", f"{cfg['request']}:{cfg['brief']}"], cwd=repo, text=True)
    if not brief.exists() or brief.read_text() != original:
        brief.parent.mkdir(parents=True, exist_ok=True); brief.write_text(original)
        git(repo, "add", "--", cfg["brief"]); git(repo, "commit", "--quiet", "-m", f"依頼文 {cfg['brief']}")
    start = git(repo, "rev-parse", "HEAD").strip()
    env = clean_env(); env["npm_config_cache"] = str(CACHE / "npm-cache")
    install = run(["nice", "-n", NICE, "npm", "ci", "--prefer-offline", "--no-audit", "--no-fund"], cwd=repo, env=env, timeout=1800, log=dest / "install.log")
    if install["exit"]: raise RuntimeError(f"npm ci が落ちた: {install['output'][-1500:]}")
    (dest / "pi-system.md").write_text(system_prompt(arm))
    return ws, repo, logs, start


def check_twice(cfg, repo, dest):
    """advance.ts の checkTwice と同じ: 落ちたら 1 回だけ流し直す。"""
    cmd = ["nice", "-n", NICE, "bash", "-c", cfg["check"]]
    first = run(cmd, cwd=repo, env=clean_env(), timeout=CHECK_TIMEOUT, log=dest / "check-1.log")
    if first["exit"] == 0: return first, [first]
    second = run(cmd, cwd=repo, env=clean_env(), timeout=CHECK_TIMEOUT, log=dest / "check-2.log")
    if second["exit"] == 0:
        second = {**second, "output": f"{second['output']}\n\n[1 回目は落ちた（終了コード {first['exit']}）]"}
    return second, [first, second]


def implement(key, cfg, arm):
    """作業用のコピーを作り、作業役を流し、変更をコミットし、確かめを流す。レビューに要るものを返す。"""
    dest = ART / key / arm; dest.mkdir(parents=True, exist_ok=True)
    ws, repo, logs, start_commit = setup(cfg, arm, dest)
    slug = cfg["slug"]; design = f"handoff/{slug}-design.md"; report = f"handoff/{slug}-report.md"
    # herdr-run.sh の実装の依頼と同じ形（台帳の仕事のときの文面）
    prompt = (f"{cfg['brief']} を読み、まず設計の下見を {design} に書いてから（10 行程度: 触るファイル・やり方・既存とかぶる所。"
              "最後に 1 行『結論: 続行』か『結論: STOP（理由）』。STOP は先に組み直さないと依頼が成り立たないときだけ。STOP ならそこで終える）、"
              f"その依頼どおりに作業し、報告を {report} に書いてください（結論 3 行／変えたファイル／流したテストと出力／確かめたことと推測／残った問題）。"
              f"作業場所はこの写し（{repo}）だけ。{SOURCE} 本体には一切書き込まない。自分ではコミットしない。")
    session = CACHE / "sessions" / f"{key}-{arm}-{ws.name}.jsonl"; session.parent.mkdir(parents=True, exist_ok=True)
    say(f"{key}{arm}: 作業役を起動（{ws.name}）")
    started = dt.datetime.now(dt.timezone.utc).isoformat()
    impl = run(["nice", "-n", NICE, "pi", "--provider", "openai", "--model", "gpt-6-luna", "--thinking", "high",
                "--system-prompt", str(dest / "pi-system.md"), "--session", str(session), "--print", prompt],
               cwd=repo, env=clean_env(), timeout=IMPL_TIMEOUT, log=dest / "impl.log")
    say(f"{key}{arm}: 作業役が終わった（終了コード {impl['exit']}、{impl['seconds']:.0f} 秒）")
    # herdr-run.sh の make_patch・commit_and_close と同じく、依頼文を除いた変更を Pi の名前でコミットする
    git(repo, "add", "-A", "--", ".", f":!{cfg['brief']}")
    if run(["git", "diff", "--cached", "--quiet"], cwd=repo)["exit"]:
        git(repo, "commit", "--quiet", "-m", f"{slug}（pi の実装）")
    diff = git(repo, "diff", start_commit, "HEAD")
    (dest / "diff.log").write_text(diff); (logs / "diff.log").write_text(diff)
    for name, rel in (("design.md", design), ("report.md", report)):
        if (repo / rel).is_file(): shutil.copy2(repo / rel, dest / name)
    stopped = (repo / design).is_file() and any(line.strip().startswith("結論: STOP") for line in (repo / design).read_text().splitlines())
    if impl["exit"] != 0 or stopped:
        check = {"exit": None, "seconds": 0, "output": "作業役が終わらなかった" if impl["exit"] else "設計の下見で STOP"}; checks = []
    else:
        say(f"{key}{arm}: 確かめを流す")
        check, checks = check_twice(cfg, repo, dest)
        say(f"{key}{arm}: 確かめ 終了コード {check['exit']}（{len(checks)} 回）")
    (logs / "check.log").write_text(check["output"])
    return {"key": key, "arm": arm, "cfg": cfg, "dest": dest, "ws": ws, "repo": repo, "logs": logs, "start_commit": start_commit,
            "started": started, "impl": impl, "check": check, "checks": checks, "stopped": stopped, "session": session}


def review_prompt(cfg, repo, diff_path, check_path, passed):
    """advance.ts の reviewPrompt と同じ文面。"""
    rubric = RUBRIC.read_text()
    if not passed: rubric = rubric.replace(PASSED_LINE, FAILED_LINE)
    report = cfg["brief"][:-3] + "-report.md"
    tail = "\n".join(check_path.read_text().split("\n")[-60:])
    return f"""{rubric}
## この仕事
- 題: {cfg['title']}
- なぜ: {cfg['why']}
- 確かめのコマンド: {cfg['check']}
- 作業用のコピー（いまの作業場所）: {repo}
- 差分: {diff_path}（読んでください）
- 作業役の報告: {report}（作業場所の中）
- 確かめの出力（全部）: {check_path}

## 依頼文（{cfg['brief']}）
{(repo / cfg['brief']).read_text()}

## 確かめの出力の終わり
```
{tail}
```
"""


def call_review(prompt, cwd, readable):
    """advance.ts の realAdvanceDeps.review と同じ呼び方。"""
    cmd = ["claude", "-p", "--model", "opus", "--output-format", "json", "--settings", json.dumps({"disableAllHooks": True}), "--strict-mcp-config",
           "--allowedTools", "Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git status:*)",
           "--disallowedTools", "Edit", "Write", "NotebookEdit"]
    for d in readable: cmd += ["--add-dir", str(d)]
    r = run(cmd, cwd=cwd, env=clean_env(), timeout=REVIEW_TIMEOUT, stdin=prompt)
    try:
        j = json.loads(r["output"])
        return {"answer": j.get("result", "") + ("" if r["exit"] == 0 else f"\n（レビュー役が終了コード {r['exit']} で終わった）"),
                "exit": r["exit"], "seconds": r["seconds"], "cost_usd": j.get("total_cost_usd"), "turns": j.get("num_turns"), "usage": j.get("usage")}
    except ValueError:
        return {"answer": r["output"] + f"\n（レビュー役が終了コード {r['exit']} で終わった）", "exit": r["exit"], "seconds": r["seconds"]}


def parse_verdict(answer):
    """advance.ts の parseVerdict と同じ: 決まった verdict を持つ最後の JSON。"""
    for s in [i for i, ch in enumerate(answer) if ch == "{"][::-1]:
        stop = answer.rfind("}")
        while stop > s:
            try:
                v = json.loads(answer[s:stop + 1])
            except ValueError:
                stop = answer.rfind("}", 0, stop); continue
            if not isinstance(v, dict) or v.get("verdict") not in ("通す", "直す", "判断"): break
            lst = lambda x: [str(i) for i in x] if isinstance(x, list) else []
            return {"verdict": v["verdict"], "reasons": lst(v.get("reasons")), "fixes": lst(v.get("fixes"))}
    return None


def finish(run_):
    key, arm, cfg, dest = run_["key"], run_["arm"], run_["cfg"], run_["dest"]
    check = run_["check"]; passed = check["exit"] == 0
    review = None
    if check["exit"] is not None:
        say(f"{key}{arm}: レビューを呼ぶ（確かめ {'通った' if passed else '落ちた'}）")
        prompt = review_prompt(cfg, run_["repo"], run_["logs"] / "diff.log", run_["logs"] / "check.log", passed)
        (dest / "review-prompt.txt").write_text(prompt)
        review = call_review(prompt, run_["repo"], [run_["logs"]])
        (dest / "review.txt").write_text(review["answer"])
        say(f"{key}{arm}: レビューが終わった（{review['seconds']:.0f} 秒）")
    verdict = parse_verdict(review["answer"]) if review else None
    if passed: ledger_verdict = verdict["verdict"] if verdict else "読めない"
    elif check["exit"] is None: ledger_verdict = "判断（STOP）" if run_["stopped"] else "直す（作業役が終わらなかった）"
    else: ledger_verdict = "直す（確かめが落ちた）"
    summary = {
        "task": key, "ledger_id": cfg["id"], "arm": arm, "workspace": run_["ws"].name, "base": cfg["base"], "request_commit": cfg["request"],
        "started": run_["started"], "impl_exit": run_["impl"]["exit"], "impl_seconds": run_["impl"]["seconds"], "impl_timed_out": run_["impl"]["timed_out"],
        "check_exit": check["exit"], "check_runs": [{"exit": c["exit"], "seconds": c["seconds"]} for c in run_["checks"]],
        "ledger_verdict": ledger_verdict, "review_verdict": verdict, "review_is_supplementary": bool(review) and not passed,
        "review_exit": review and review["exit"], "review_seconds": review and review["seconds"], "review_cost_usd": review and review.get("cost_usd"),
        "tokens": token_totals(run_["session"]), "session": str(run_["session"]), "diff_lines": len((dest / "diff.log").read_text().splitlines()),
        "design_lines": len((dest / "design.md").read_text().splitlines()) if (dest / "design.md").exists() else None,
        "report_chars": len((dest / "report.md").read_text()) if (dest / "report.md").exists() else None,
    }
    (dest / "result.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    shutil.rmtree(run_["ws"])
    say(f"{key}{arm}: 記録した（{ledger_verdict}）。作業用のコピーを消した")
    return summary


def token_totals(path):
    totals = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}; found = False
    try:
        for line in pathlib.Path(path).read_text().splitlines():
            row = json.loads(line); msg = row.get("message", {})
            usage = msg.get("usage", {}) if isinstance(msg, dict) else {}
            if usage:
                found = True
                for k, src in (("input", "input"), ("output", "output"), ("cache_read", "cacheRead"), ("cache_write", "cacheWrite")):
                    totals[k] += int(usage.get(src, 0) or 0)
    except (OSError, ValueError):
        pass
    return totals if found else None


def wait_for_load():
    while os.getloadavg()[0] > LOAD_LIMIT:
        say(f"負荷 {os.getloadavg()[0]:.1f} > {LOAD_LIMIT}: 新しい組を待つ"); time.sleep(60)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", nargs="+", choices=TASKS, default=["6", "12", "9", "2"])
    ap.add_argument("--resume", action="store_true", help="result.json がある回は飛ばす")
    args = ap.parse_args()
    tasks = ledger_tasks(); ART.mkdir(parents=True, exist_ok=True)
    (ART / "tasks.json").write_text(json.dumps(tasks, ensure_ascii=False, indent=2) + "\n")
    reviews = concurrent.futures.ThreadPoolExecutor(max_workers=2)
    pending = []
    for key in args.tasks:
        arms = [a for a in ("A", "B") if not (args.resume and (ART / key / a / "result.json").exists())]
        if not arms: continue
        wait_for_load()
        # 同じ仕事の A と B を同時に流す（負荷を揃える）。実装と確かめは 2 本まで
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futs = {pool.submit(implement, key, tasks[key], arm): arm for arm in arms}
            for f in concurrent.futures.as_completed(futs):
                try: pending.append(reviews.submit(finish, f.result()))
                except Exception as e:
                    say(f"{key}{futs[f]}: 失敗 {e!r}")
                    (ART / key / futs[f]).mkdir(parents=True, exist_ok=True)
                    (ART / key / futs[f] / "error.txt").write_text(repr(e))
    for f in pending:
        try: print(json.dumps(f.result(), ensure_ascii=False), flush=True)
        except Exception as e: say(f"記録に失敗 {e!r}")
    reviews.shutdown()


if __name__ == "__main__":
    main()
