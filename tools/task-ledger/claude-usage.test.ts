import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getClaudeUsage, renderClaudeUsage } from './claude-usage.ts';
import { main } from './cli.ts';

// Lines shaped like the real transcripts under ~/.claude/projects (checked 10/30): `claude -p` writes entrypoint
// "sdk-cli", the interactive session "cli"; one API call is written as one line per content block, every line
// with the same requestId and the same usage; the prompt of `claude -p` comes first as a queue-operation.
type U = { input?: number; cacheRead?: number; cacheCreation?: number; output?: number };
let seq = 0;
function call(at: string, usage: U, o: { entrypoint?: string; model?: string; requestId?: string; blocks?: number; sidechain?: boolean; session?: string } = {}): string[] {
  const requestId = o.requestId ?? `req_${++seq}`, blocks = o.blocks ?? 2;
  return Array.from({ length: blocks }, (_, i) => JSON.stringify({
    parentUuid: null, isSidechain: o.sidechain ?? false, userType: 'external', cwd: '/home/u/repos/example', sessionId: o.session ?? 's', version: '2.1', gitBranch: 'main',
    entrypoint: o.entrypoint ?? 'cli', requestId, type: 'assistant', uuid: `${requestId}-${i}`, timestamp: at,
    message: { model: o.model ?? 'claude-opus-4', id: `msg_${requestId}`, type: 'message', role: 'assistant', content: [{ type: i === blocks - 1 ? 'tool_use' : 'thinking' }],
      usage: { input_tokens: usage.input ?? 0, cache_read_input_tokens: usage.cacheRead ?? 0, cache_creation_input_tokens: usage.cacheCreation ?? 0, output_tokens: usage.output ?? 0 } },
  }));
}
const user = (content: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra });
const toolResult = () => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'out' }] }, toolUseResult: { stdout: 'out' } });
const enqueue = (content: string) => JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content });
const noise = () => JSON.stringify({ type: 'api-request-blob', body: { messages: [{ role: 'user', content: 'x' }] } });
const lines = (...parts: Array<string | string[]>) => parts.flat().join('\n') + '\n';

const REVIEW = 'あなたは、作業役（Pi など）が終えた仕事を、本体に取り込む前に見るレビュー役です。決めるのは「通す」「直す」「判断」のどれかだけです。';
const DECISION = 'あなたは、仕事の台帳の「判断待ち」を、背景を知らない持ち主が 30 秒で決められる形にまとめる係です。';
const RETRO = 'あなたは仕事台帳・ハーネスの振り返り見張り役です。入力された記録だけを根拠に、繰り返し起きている具体的な失敗を見つけてください。';
const WORKER = '## 作業役とモデル\n- worker: claude\n- model: haiku\n- effort: high\n\nhandoff/x.md を読んで進める。';
const CONSULT = 'この差し戻しは妥当？\n\n返答は読みやすい文章で、必要なら短い箇条書きにしてください。台帳やファイルの変更はしないでください。';
const iso = (ms: number) => new Date(ms).toISOString();

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-usage-')), proj = join(dir, 'projects', 'example'), usage = join(dir, 'usage');
  mkdirSync(proj, { recursive: true }); mkdirSync(usage);
  process.env.CLAUDE_PROJECTS_DIR = join(dir, 'projects'); process.env.CLAUDE_USAGE_DIR = usage;
  return { dir, proj, usage };
}
function cleanup(dir: string) { rmSync(dir, { recursive: true, force: true }); delete process.env.CLAUDE_PROJECTS_DIR; delete process.env.CLAUDE_USAGE_DIR; delete process.env.TASK_LEDGER_DB; }
const writeLimits = (usage: string, rows: Array<[number, number | null, number | null, number?, number?]>) =>
  writeFileSync(join(usage, 'limits.jsonl'), rows.map(([at, five, seven, fiveReset = 2e9, sevenReset = 2e9]) => JSON.stringify({ at: iso(at), five_hour: five, five_hour_resets_at: fiveReset, seven_day: seven, seven_day_resets_at: sevenReset })).join('\n') + '\n');

test('test execution refuses default Claude paths when either isolation variable is missing', () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'this guard test must run under node:test');
  const projects = process.env.CLAUDE_PROJECTS_DIR, usage = process.env.CLAUDE_USAGE_DIR;
  try {
    process.env.CLAUDE_USAGE_DIR = join(tmpdir(), 'guard-usage'); delete process.env.CLAUDE_PROJECTS_DIR;
    assert.throws(() => getClaudeUsage(), /must set CLAUDE_PROJECTS_DIR and CLAUDE_USAGE_DIR/);
    process.env.CLAUDE_PROJECTS_DIR = join(tmpdir(), 'guard-projects'); delete process.env.CLAUDE_USAGE_DIR;
    assert.throws(() => getClaudeUsage(), /must set CLAUDE_PROJECTS_DIR and CLAUDE_USAGE_DIR/);
  } finally {
    if (projects === undefined) delete process.env.CLAUDE_PROJECTS_DIR; else process.env.CLAUDE_PROJECTS_DIR = projects;
    if (usage === undefined) delete process.env.CLAUDE_USAGE_DIR; else process.env.CLAUDE_USAGE_DIR = usage;
  }
});

test('one API call written as several lines counts once, and a forked session does not count copied calls again', () => {
  const env = setup(), now = Date.now();
  try {
    writeFileSync(join(env.proj, 'review.jsonl'), lines(enqueue(REVIEW), user(REVIEW, { entrypoint: 'sdk-cli', timestamp: iso(now - 9000) }), noise(),
      call(iso(now - 8000), { input: 100, cacheRead: 20, cacheCreation: 10, output: 2 }, { entrypoint: 'sdk-cli', requestId: 'req_review', blocks: 3 })));
    // `--resume <review> --fork-session` copies the review's history into a new file, then adds the consult.
    writeFileSync(join(env.proj, 'consult-fork.jsonl'), lines(user(REVIEW, { entrypoint: 'sdk-cli', timestamp: iso(now - 9000 + 1) }),
      call(iso(now - 8000), { input: 100, cacheRead: 20, cacheCreation: 10, output: 2 }, { entrypoint: 'sdk-cli', requestId: 'req_review', blocks: 3 }),
      user(CONSULT), call(iso(now - 1000), { input: 7 }, { entrypoint: 'sdk-cli', requestId: 'req_consult' })));
    const got = getClaudeUsage(7, now);
    assert.equal(got.events.length, 2);
    assert.deepEqual(got.events.map(e => [e.id, e.caller]), [['req_review', 'レビュー'], ['req_consult', '相談']]);
    assert.equal(got.events[0]!.rawWeighted, 124.5); // 100 + 20×0.1 + 10×1.25 + 2×5, once
    assert.equal(got.rows.reduce((s, r) => s + r.input, 0), 107);
  } finally { cleanup(env.dir); }
});

test('claude -p sessions (entrypoint sdk-cli) are split by their first prompt; the interactive session is the supervisor', () => {
  const env = setup(), now = Date.now();
  try {
    const sessions: Array<[string, string, string[]]> = [
      ['review', 'レビュー', [enqueue(`触るファイルの外の変更: handoff/x.log（作業役の報告と照らすこと）\n\n${REVIEW}`), user(`触るファイルの外の変更: handoff/x.log（作業役の報告と照らすこと）\n\n${REVIEW}`)]],
      ['decision', '判断カード', [enqueue(DECISION), user(DECISION)]],
      ['retro', '夜の見張り役', [enqueue(RETRO), user(RETRO)]],
      ['worker', 'Claude の作業役', [enqueue(WORKER), user(WORKER)]],
      ['metrics', 'その他の claude -p', [enqueue('次のレビュー差し戻しを、許可語の中から各1〜3個に分類し、JSON配列だけ返してください。'), user('次のレビュー差し戻しを…')]],
    ];
    sessions.forEach(([name, , head], i) => writeFileSync(join(env.proj, `${name}.jsonl`), lines(head, call(iso(now - 5000 + i), { input: 1 }, { entrypoint: 'sdk-cli', model: 'claude-sonnet-4' }), toolResult(), call(iso(now - 4000 + i), { input: 1 }, { entrypoint: 'sdk-cli', model: 'claude-sonnet-4' }))));
    writeFileSync(join(env.proj, 'supervisor.jsonl'), lines(user(`${REVIEW}（ユーザーが貼った文）`, { origin: { kind: 'human' } }), call(iso(now - 3000), { input: 1 })));
    mkdirSync(join(env.proj, 'supervisor', 'subagents'), { recursive: true });
    writeFileSync(join(env.proj, 'supervisor', 'subagents', 'agent-a1.jsonl'), lines(user('Read the file and report.', { isSidechain: true }), call(iso(now - 2000), { input: 1 }, { sidechain: true })));
    const got = getClaudeUsage(7, now), byCaller = new Map<string, number>();
    for (const e of got.events) byCaller.set(e.caller, (byCaller.get(e.caller) ?? 0) + 1);
    assert.deepEqual(Object.fromEntries(byCaller), { 'レビュー': 2, '判断カード': 2, '夜の見張り役': 2, 'Claude の作業役': 2, 'その他の claude -p': 2, '司令塔': 1, 'サブエージェント': 1 });
    assert.equal(got.events.find(e => e.caller === 'レビュー')!.weighted, .6); // sonnet: 1 input × 0.6
  } finally { cleanup(env.dir); }
});

test('the supervisor is woken by notifications, the watcher, workers and you; tool results and Claude Code\'s own lines carry on', () => {
  const env = setup(), now = Date.now();
  try {
    let t = now - 100000; const c = () => call(iso(t += 1000), { input: 1 });
    writeFileSync(join(env.proj, 'supervisor.jsonl'), lines(
      user('台帳を見て', { origin: { kind: 'human' } }), c(), toolResult(), c(),
      user('<task-notification>\n<task-id>b1</task-id>\n<summary>Monitor event: "herdr の仕事が 40 分止まっていないか"</summary>\n<event>[Monitor expired after 30m with no events delivered.]</event>\n</task-notification>', { origin: { kind: 'task-notification' } }), c(),
      user('<task-notification>\n<task-id>b2</task-id>\n<summary>Monitor event: "Pi に依頼が届いたか"</summary>\n<event>届いた</event>\n</task-notification>', { origin: { kind: 'task-notification' } }), c(),
      user('<task-notification>\n<task-id>b3</task-id>\n<status>completed</status>\n<summary>Background command "Launch Pi" completed (exit code 0)</summary>\n</task-notification>', { origin: { kind: 'task-notification' } }), c(),
      user('<channel source="agent-channel" from="impl-x" kind="finish" row_id="9" to="claude-1">終わりました</channel>', { isMeta: true, origin: { kind: 'channel' } }), c(),
      user('Base directory for this skill: /x', { isMeta: true }), c(),
      user('<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>Stop hook blocking error from command "Stop": キャッシュ延命のための自動の起床です</system-reminder>'), c(),
      user('見回り（返事は要らない）: (1) 台帳を見る', { isMeta: true }), c(),
      user('夜の報告を作る'), c(),
    ));
    assert.deepEqual(getClaudeUsage(7, now).events.map(e => e.reason), ['あなたの発言', 'あなたの発言', '見張り（expired）', '見張り（Monitor）', '裏の命令の終わり', '作業役の連絡', '作業役の連絡', 'キャッシュ延命', '見回り', '朝夕の報告']);
  } finally { cleanup(env.dir); }
});

test('reading only the appended bytes classifies like a full read, keeps a call split across two reads once, and skips broken lines', () => {
  const env = setup(), now = Date.now(), review = join(env.proj, 'review.jsonl'), sup = join(env.proj, 'supervisor.jsonl');
  try {
    // First read: the review prompt has arrived, its answer not yet; the supervisor's last whole line is a
    // notification, two of the three lines of a call are in, and the third is half written.
    writeFileSync(review, lines(enqueue(REVIEW), user(REVIEW)));
    const [a, b, c] = call(iso(now - 3000), { input: 10, output: 1 }, { requestId: 'req_split', blocks: 3 });
    writeFileSync(sup, lines(user('やって', { origin: { kind: 'human' } }), call(iso(now - 5000), { input: 1 }), a!, b!, '{broken',
      user('<task-notification>\n<summary>Monitor event: "x"</summary>\n<event>y</event>\n</task-notification>', { origin: { kind: 'task-notification' } })) + c!.slice(0, 40));
    const first = getClaudeUsage(7, now);
    assert.equal(first.events.length, 2); assert.equal(first.malformedLines, 1);
    assert.equal(first.events.find(e => e.id === 'req_split')!.input, 10);
    appendFileSync(sup, c!.slice(40) + '\n' + lines(call(iso(now - 1000), { input: 3 })));
    appendFileSync(review, lines(call(iso(now - 2000), { input: 5 }, { entrypoint: 'sdk-cli' })));
    const second = getClaudeUsage(7, now);
    const shape = (r: ReturnType<typeof getClaudeUsage>) => r.events.map(e => [e.id, e.caller, e.reason, e.input]);
    assert.deepEqual(shape(second).map(x => x.slice(1)), [['司令塔', 'あなたの発言', 1], ['司令塔', 'あなたの発言', 10], ['レビュー', null, 5], ['司令塔', '見張り（Monitor）', 3]]);
    assert.equal(second.malformedLines, 1);
    // A read from scratch gives the same answer.
    rmSync(join(env.usage, 'transcript-usage.json'));
    assert.deepEqual(shape(getClaudeUsage(7, now)), shape(second));
    assert.match(renderClaudeUsage(second), /司令塔・見張り（Monitor）/);
  } finally { cleanup(env.dir); }
});

test('7-day capacity counts every call between two rises of the 7-day percentage, ignores 23→22→23 jitter and other windows', () => {
  const env = setup(), now = Date.now(), H = 3600000, t0 = now - 48 * H, file = join(env.proj, 's.jsonl');
  try {
    // 22% at t0. The 5-hour percentage moves on its own while the 7-day one stays; the 7-day one rises at t0+1h and t0+3h.
    writeLimits(env.usage, [
      [t0, 5, 22], [t0 + .5 * H, 6, 22], [t0 + 1 * H, 7, 23],
      [t0 + 1 * H + 1000, 6, 22], [t0 + 1 * H + 2000, 7, 23], // a session writing its older copy
      [t0 + 1.5 * H, 8, 23], [t0 + 2.5 * H, 9, 23], [t0 + 3 * H, 10, 24],
      [t0 + 30 * H, 1, 30, 3e9, 3e9], [t0 + 31 * H, 2, 31, 3e9, 3e9], // the next window: its first row is no rise
      [t0 + 31 * H + 1000, 40, 29, 2e9, 2e9], // a stale row from the earlier window
      [t0 + 32 * H, 3, 32, 3e9, 3e9],
    ]);
    writeFileSync(file, lines(user('x'),
      call(iso(t0 + .5 * H), { input: 999 }), // before the first rise: not in any 7-day interval
      call(iso(t0 + 1.2 * H), { input: 100 }), call(iso(t0 + 2 * H), { input: 200 }), call(iso(t0 + 2.9 * H), { input: 300, output: 10 }),
      call(iso(t0 + 31.5 * H), { input: 50 }, { model: 'claude-haiku-4' }),
    ));
    const got = getClaudeUsage(7, now).capacity;
    assert.equal(got.sevenDay.intervals, 2); // 23→24, and 31→32 in the next window (not 24→31 across the reset)
    assert.deepEqual(got.sevenDay.spans.map(s => [s.delta, s.tokens]), [[1, 650], [1, 10]]);
    assert.equal(got.sevenDay.perPercent, 330); assert.equal(got.sevenDay.weightedWithoutModelPrices, 350);
    assert.equal(got.sevenDay.capacity100, 33000);
    assert.equal(got.sevenDay.medianPerPercent, 330); assert.deepEqual(got.sevenDay.rangePerPercent, { low: 170, high: 490 });
    // The 5-hour estimate uses the same seven days (these rows are two days old), not just the last five hours.
    assert.ok(got.fiveHour.intervals >= 4);
    assert.equal(got.sevenDay.coefficients, null);
  } finally { cleanup(env.dir); }
});

test('capacity coefficients appear at twenty intervals and not at nineteen', () => {
  const env = setup(), now = Date.now(), H = 3600000;
  try {
    const run = (n: number) => {
      const limits: Array<[number, number, number]> = [], calls: string[][] = [];
      for (let i = 0; i <= n + 1; i++) {
        const at = now - (n + 2 - i) * H; limits.push([at, i, i]);
        const key = (['input', 'cacheRead', 'cacheCreation', 'output'] as const)[i % 4]!;
        calls.push(call(iso(at + H / 2), { [key]: i + 1, input: key === 'input' ? i + 1 : 1 }));
      }
      // Transcripts only grow; a rewritten file of another size would be read from the old offset, so use a new name.
      rmSync(join(env.proj, `many-${n - 1}.jsonl`), { force: true });
      writeLimits(env.usage, limits); writeFileSync(join(env.proj, `many-${n}.jsonl`), lines(...calls));
      return getClaudeUsage(7, now).capacity.sevenDay;
    };
    assert.equal(run(19).intervals, 19); assert.equal(run(19).coefficients, null);
    const twenty = run(20); assert.equal(twenty.intervals, 20); assert.notEqual(twenty.coefficients, null);
  } finally { cleanup(env.dir); }
});

test('remaining: the pace comes from rows after the reset, a stale latest row does not lower the value, no file gives null', () => {
  const env = setup(), now = Date.now(), H = 3600000, reset = Math.floor((now + 4 * 86400000) / 1000);
  try {
    writeFileSync(join(env.proj, 's.jsonl'), lines(user('x'), call(iso(now - H), { input: 1 })));
    // 20 hours ago the old window (98%); the window that resets in four days starts 10 hours ago.
    writeLimits(env.usage, [[now - 20 * H, 50, 98, 1, Math.floor((now - 11 * H) / 1000)], [now - 10 * H, 1, 0, 2e9, reset], [now - 2 * H, 1, 30, 2e9, reset], [now - 60000, 1, 29, 2e9, reset]]);
    const got = getClaudeUsage(7, now).remaining!;
    assert.equal(got.sevenDay, 30);
    assert.equal(got.paceSince, iso(now - 10 * H));
    assert.ok(Math.abs(got.pacePerHour! - 30 / (10 * H - 60000) * H) < 1e-9);
    assert.ok(got.exhaustAt && Date.parse(got.exhaustAt) < reset * 1000);
    // At a slow pace the window resets first.
    writeLimits(env.usage, [[now - 10 * H, 1, 0, 2e9, reset], [now - 60000, 1, 1, 2e9, reset]]);
    assert.equal(getClaudeUsage(7, now).remaining!.exhaustAt, null);
    rmSync(join(env.usage, 'limits.jsonl')); assert.equal(getClaudeUsage(7, now).remaining, null);
  } finally { cleanup(env.dir); }
});

test('CLI renders the table using temporary transcripts', () => {
  const env = setup();
  try {
    writeFileSync(join(env.proj, 'cli.jsonl'), lines(enqueue(REVIEW), user(REVIEW), call(new Date().toISOString(), { input: 5 }, { entrypoint: 'sdk-cli' })));
    process.env.TASK_LEDGER_DB = join(env.dir, 'ledger.sqlite'); const out: string[] = [];
    assert.equal(main(['claude-usage', '--days', '7'], s => out.push(s)), 0);
    assert.match(out.join('\n'), /日\t換算値/); assert.match(out.join('\n'), /レビュー・—\t5/); assert.match(out.join('\n'), /7 日の枠: 記録なし/);
  } finally { cleanup(env.dir); }
});
