import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension, { createChannelExtension } from '../extension.ts';
import { read } from '../../engine/channel.ts';

function setup(log: string, name = 'worker', supervisor?: string) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const messages: any[] = [];
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (event: string, handler: Function) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    sendMessage: async (...args: any[]) => { messages.push(args); },
  };
  createChannelExtension({ log, name, supervisor })(pi);
  return { tools, handlers, messages };
}

test('tools append required channel rows and errors explain a missing configured name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'channel-pi-'));
  try {
    const log = join(dir, 'records.jsonl');
    const { tools } = setup(log, 'worker', 'claude-42');
    const finish = await tools.get('channel_finish').execute('id', { summary: '完了', facts: [{ claim: '検査', how: '実行' }] });
    const post = await tools.get('channel_post').execute('id', { text: '途中' });
    assert.deepEqual(JSON.parse(finish.content[0].text), { id: finish.details.id });
    const rows = read(log).rows;
    assert.deepEqual(rows.map(({ from, to, kind, body }) => ({ from, to, kind, body })), [
      { from: 'worker', to: 'claude-42', kind: 'finish', body: '完了' },
      { from: 'worker', to: 'claude-42', kind: 'post', body: '途中' },
    ]);
    assert.deepEqual(rows[0]?.fields.facts, [{ claim: '検査', how: '実行' }]);
    const unconfigured = new Map<string, any>();
    createChannelExtension({ log: join(dir, 'other.jsonl'), name: '' })({ registerTool: (t: any) => unconfigured.set(t.name, t), on() {}, sendMessage() {} });
    const failure = await unconfigured.get('channel_post').execute('id', { text: 'x' });
    assert.equal(failure.isError, true);
    assert.match(failure.content[0].text, /AGENT_CHANNEL_NAME が無いので使えない/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('only messages addressed to self or wildcard are delivered, not own rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'channel-pi-'));
  try {
    const log = join(dir, 'records.jsonl');
    const { handlers, messages } = setup(log);
    handlers.get('session_start')?.[0]?.({});
    const tool = setup(log);
    await tool.tools.get('channel_post').execute('id', { text: 'own', to: '*' });
    // follow() polls immediately; permit its queued callback to run.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(messages.length, 0);
    const { append } = await import('../../engine/channel.ts');
    append(log, { kind: 'say', from: 'claude', to: 'worker', body: 'private' });
    append(log, { kind: 'say', from: 'other', to: '*', body: 'broadcast' });
    append(log, { kind: 'say', from: 'other', to: 'someone', body: 'not for me' });
    await new Promise((resolve) => setTimeout(resolve, 600));
    // 1 通目で番が始まるので、2 通目は番が終わってから届く
    assert.equal(messages.length, 1);
    handlers.get('agent_settled')?.[0]?.({ aborted: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(messages.map((args) => args[0]), [
      { customType: 'agent-channel', content: '【連絡チャンネル】claude から（say）:\nprivate', display: true, details: read(log).rows[1] },
      { customType: 'agent-channel', content: '【連絡チャンネル】other から（say）:\nbroadcast', display: true, details: read(log).rows[2] },
    ]);
    assert.deepEqual(messages.map((args) => args[1]), [
      { triggerTurn: true, deliverAs: 'followUp' },
      { triggerTurn: true, deliverAs: 'followUp' },
    ]);
    handlers.get('session_shutdown')?.[0]?.({});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stopped is once per user start; custom starts do not reset the start marker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'channel-pi-'));
  try {
    const log = join(dir, 'records.jsonl');
    const { handlers } = setup(log, 'worker', 'claude-88');
    const before = handlers.get('before_agent_start')?.[0];
    const settled = handlers.get('agent_settled')?.[0];
    before?.({ messageType: 'user' });
    settled?.({ aborted: true });
    settled?.({ aborted: false });
    before?.({ messageType: 'custom' });
    settled?.({ aborted: false });
    const stopped = read(log).rows.filter((row) => row.kind === 'stopped');
    assert.equal(stopped.length, 1);
    assert.deepEqual({ to: stopped[0]?.to, body: stopped[0]?.body, aborted: stopped[0]?.fields.aborted }, {
      to: 'claude-88', body: 'finish を呼ばずに止まりました', aborted: true,
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('default export resolves environment when invoked, not when module is loaded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'channel-pi-'));
  const oldLog = process.env.AGENT_CHANNEL;
  const oldName = process.env.AGENT_CHANNEL_NAME;
  const oldSupervisor = process.env.AGENT_CHANNEL_SUPERVISOR;
  try {
    const log = join(dir, 'deferred.jsonl');
    process.env.AGENT_CHANNEL = log;
    process.env.AGENT_CHANNEL_NAME = 'late-name';
    process.env.AGENT_CHANNEL_SUPERVISOR = 'claude-77';
    const tools = new Map<string, any>();
    extension({ registerTool: (tool: any) => tools.set(tool.name, tool), on() {}, sendMessage() {} });
    await tools.get('channel_post').execute('id', { text: 'late' });
    const row = JSON.parse(readFileSync(log, 'utf8'));
    assert.equal(row.from, 'late-name');
    assert.equal(row.to, 'claude-77');
  } finally {
    if (oldLog === undefined) delete process.env.AGENT_CHANNEL; else process.env.AGENT_CHANNEL = oldLog;
    if (oldName === undefined) delete process.env.AGENT_CHANNEL_NAME; else process.env.AGENT_CHANNEL_NAME = oldName;
    if (oldSupervisor === undefined) delete process.env.AGENT_CHANNEL_SUPERVISOR; else process.env.AGENT_CHANNEL_SUPERVISOR = oldSupervisor;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('messages that arrive during a turn are held, superseded ones are dropped, and the rest arrive as one message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'channel-pi-'));
  try {
    const log = join(dir, 'records.jsonl');
    const { handlers, messages } = setup(log);
    handlers.get('session_start')?.[0]?.({});
    handlers.get('before_agent_start')?.[0]?.({ messageType: 'user' });
    const { append } = await import('../../engine/channel.ts');
    const ask = append(log, { kind: 'say', from: 'claude', to: 'worker', body: 'ログも作って' });
    append(log, { kind: 'say', from: 'claude', to: 'worker', body: 'やっぱり作らないで', fields: { supersedes: [ask.id] } });
    append(log, { kind: 'say', from: 'claude', to: 'worker', body: '急いで' });
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(messages.length, 0);
    handlers.get('agent_settled')?.[0]?.({ aborted: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(messages.length, 1);
    const content = messages[0][0].content as string;
    assert.doesNotMatch(content, /ログも作って/);
    assert.match(content, /番の間に 2 通届いた[\s\S]*やっぱり作らないで[\s\S]*急いで/);
    // 渡した後は次の番が終わるまで、また持っておく
    append(log, { kind: 'say', from: 'claude', to: 'worker', body: '次' });
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(messages.length, 1);
    handlers.get('agent_settled')?.[0]?.({ aborted: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(messages.length, 2);
    handlers.get('session_shutdown')?.[0]?.({});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
