import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { append, read } from '../../engine/channel.ts';

test('real stdio MCP exposes tools, appends say, and delivers channel notifications', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'channel-mcp-'));
  const log = join(dir, 'events.jsonl');
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('channel/mcp/server.ts')], env: { ...process.env, AGENT_CHANNEL: log, AGENT_CHANNEL_NAME: 'claude-123' } });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  try {
    const notification = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('channel notification timed out')), 4000);
      client.setNotificationHandler(z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }) }), (message) => { clearTimeout(timeout); resolve(message.params); });
    });
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ['channel_read', 'channel_say']);
    const say = await client.callTool({ name: 'channel_say', arguments: { to: 'impl-test', text: '確認', reply_to: 'parent' } });
    const sayRow = read(log).rows[0]!;
    assert.equal(sayRow.kind, 'say'); assert.equal(sayRow.from, 'claude-123'); assert.equal(sayRow.to, 'impl-test'); assert.equal(sayRow.reply_to, 'parent');
    assert.equal(say.content?.[0]?.text, sayRow.id);
    append(log, { kind: 'post', from: 'claude-123', body: 'self' });
    append(log, { kind: 'finish', from: 'impl-test', to: 'claude-123', body: 'できました', refs: ['a', 'b'], facts: [{ claim: '検査成功', how: 'テスト' }] });
    const received = await notification;
    assert.deepEqual(received, { content: 'できました\n確かめた事実:\n- 検査成功（テスト）', meta: { from: 'impl-test', kind: 'finish', row_id: read(log).rows.at(-1)!.id, to: 'claude-123', refs: 'a, b' } });
    const rows = await client.callTool({ name: 'channel_read', arguments: { limit: 1 } });
    assert.equal(JSON.parse(rows.content?.[0]?.text ?? '[]')[0].kind, 'finish');
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real stdio MCP routes only its own and wildcard destinations, excluding other sessions and generic claude', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'channel-mcp-route-'));
  const log = join(dir, 'events.jsonl');
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('channel/mcp/server.ts')], env: { ...process.env, AGENT_CHANNEL: log, AGENT_CHANNEL_NAME: 'claude-456' } });
  const client = new Client({ name: 'routing-test', version: '1.0.0' });
  const received: string[] = [];
  try {
    const twoNotifications = new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error(`expected 2 notifications, got ${received.length}`)), 4000);
      client.setNotificationHandler(z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }) }), (message) => {
        received.push(message.params.content);
        if (received.length === 2) { clearTimeout(timeout); resolvePromise(); }
      });
    });
    await client.connect(transport);
    append(log, { kind: 'post', from: 'worker', to: 'claude-456', body: 'mine' });
    append(log, { kind: 'post', from: 'worker', to: '*', body: 'broadcast' });
    append(log, { kind: 'post', from: 'worker', to: 'claude-789', body: 'other session' });
    append(log, { kind: 'post', from: 'worker', to: 'claude', body: 'generic legacy' });
    await twoNotifications;
    assert.deepEqual(received, ['mine', 'broadcast']);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('channel_say supersedes only known says to the same worker, and channel_read open lists what is still asked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'channel-mcp-open-'));
  const log = join(dir, 'events.jsonl');
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('channel/mcp/server.ts')], env: { ...process.env, AGENT_CHANNEL: log, AGENT_CHANNEL_NAME: 'claude-321' } });
  const client = new Client({ name: 'open-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const first = await client.callTool({ name: 'channel_say', arguments: { to: 'impl-a', text: 'ログも作って' } });
    await client.callTool({ name: 'channel_say', arguments: { to: 'impl-b', text: '別の頼み' } });
    await assert.rejects(client.callTool({ name: 'channel_say', arguments: { to: 'impl-b', text: 'x', supersedes: [first.content?.[0]?.text] } }), /impl-b 宛ての知らせに無い/);
    await client.callTool({ name: 'channel_say', arguments: { to: 'impl-a', text: '作らないで', supersedes: [first.content?.[0]?.text] } });
    const open = await client.callTool({ name: 'channel_read', arguments: { open: true } });
    assert.deepEqual(JSON.parse(open.content?.[0]?.text ?? '[]').map((row: any) => `${row.to}:${row.body}`), ['impl-b:別の頼み', 'impl-a:作らないで']);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
