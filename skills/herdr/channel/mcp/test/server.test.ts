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
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('channel/mcp/server.ts')], env: { ...process.env, AGENT_CHANNEL: log, AGENT_CHANNEL_NAME: 'claude' } });
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
    assert.equal(sayRow.kind, 'say'); assert.equal(sayRow.from, 'claude'); assert.equal(sayRow.to, 'impl-test'); assert.equal(sayRow.reply_to, 'parent');
    assert.equal(say.content?.[0]?.text, sayRow.id);
    append(log, { kind: 'post', from: 'claude', body: 'self' });
    append(log, { kind: 'finish', from: 'impl-test', body: 'できました', refs: ['a', 'b'], facts: [{ claim: '検査成功', how: 'テスト' }] });
    const received = await notification;
    assert.deepEqual(received, { content: 'できました\n確かめた事実:\n- 検査成功（テスト）', meta: { from: 'impl-test', kind: 'finish', row_id: read(log).rows.at(-1)!.id, to: 'claude', refs: 'a, b' } });
    const rows = await client.callTool({ name: 'channel_read', arguments: { limit: 1 } });
    assert.equal(JSON.parse(rows.content?.[0]?.text ?? '[]')[0].kind, 'finish');
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
