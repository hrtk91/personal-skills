#!/usr/bin/env node
import { append, lastId, logPath, read, wait as waitFor, type Filter, type Kind } from './channel.ts';

function usage(message: string): never { console.error(message); process.exitCode = 2; throw new Error('usage'); }
function args(argv: string[]): { positionals: string[]; options: Map<string, string[]>; flags: Set<string> } {
  const positionals: string[] = [], options = new Map<string, string[]>(), flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) { positionals.push(token); continue; }
    if (token === '--follow') { flags.add(token); continue; }
    const value = argv[++i];
    if (!value || value.startsWith('--')) usage(`不足している引数: ${token}`);
    options.set(token, [...(options.get(token) ?? []), value]);
  }
  return { positionals, options, flags };
}
function get(o: Map<string, string[]>, key: string): string | undefined { return o.get(key)?.at(-1); }
function run(): void {
  const parsed = args(process.argv.slice(2));
  const command = parsed.positionals.shift();
  const log = get(parsed.options, '--log') ?? logPath();
  const from = get(parsed.options, '--from') ?? process.env.AGENT_CHANNEL_NAME;
  if (!command) usage('コマンドが必要です');
  if (command === 'last-id') {
    if (!log) usage('AGENT_CHANNEL または --log が必要です');
    const id = lastId(log); if (id) console.log(id); return;
  }
  if (!log) usage('AGENT_CHANNEL または --log が必要です');
  if (command === 'post' || command === 'say' || command === 'finish') {
    if (!from) usage('AGENT_CHANNEL_NAME または --from が必要です');
    const body = command === 'finish' ? get(parsed.options, '--summary') : parsed.positionals.join(' ');
    if (!body) usage(command === 'finish' ? '--summary が必要です' : '本文が必要です');
    const to = get(parsed.options, '--to');
    if (command === 'say' && !to) usage('say には --to が必要です');
    const facts = (parsed.options.get('--fact') ?? []).map((f) => {
      const split = f.indexOf('::'); if (split < 0) usage('--fact は「何が正しいか::どう確かめたか」形式です');
      return { claim: f.slice(0, split), how: f.slice(split + 2) };
    });
    const row = append(log, { kind: command, from, ...(to ? { to } : {}), body, ...(command === 'finish' ? { facts } : {}) });
    console.log(JSON.stringify(row)); return;
  }
  const filter: Filter = {
    ...(get(parsed.options, '--kind') ? { kind: get(parsed.options, '--kind') as Kind } : {}),
    ...(get(parsed.options, '--from') ? { from: get(parsed.options, '--from') } : {}),
    ...(get(parsed.options, '--to') ? { to: get(parsed.options, '--to') } : {}),
    ...(get(parsed.options, '--after') ? { after: get(parsed.options, '--after') } : {}),
  };
  if (command === 'wait') {
    const seconds = get(parsed.options, '--timeout');
    const timeoutMs = seconds === undefined ? undefined : Number(seconds) * 1000;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) usage('--timeout は 0 以上の秒数です');
    void waitFor(log, filter, { timeoutMs }).then((row) => { if (row) console.log(JSON.stringify(row)); else process.exitCode = 124; });
    return;
  }
  if (command === 'tail') {
    const emit = () => { const result = read(log, filter); for (const row of result.rows) console.log(JSON.stringify(row)); if (result.skipped) console.error(`不正な行を ${result.skipped} 行スキップしました`); };
    if (parsed.flags.has('--follow')) {
      let cursor = filter.after;
      const print = (row: { id: string }) => { console.log(JSON.stringify(row)); cursor = row.id; };
      let reportedSkipped = 0;
      const stop = follow(log, filter, print, {
        after: cursor,
        onSkipped: (count) => {
          if (count > reportedSkipped) console.error(`不正な行を ${count - reportedSkipped} 行スキップしました`);
          reportedSkipped = count;
        },
      });
      process.on('SIGINT', () => { stop(); process.exit(0); });
    } else emit();
    return;
  }
  usage(`未知のコマンド: ${command}`);
}
import { follow } from './channel.ts';
try { run(); } catch (error) { if (!(error instanceof Error && error.message === 'usage')) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; } }
