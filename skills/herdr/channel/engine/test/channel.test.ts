import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { append, follow, hasFinished, lastId, read, wait } from '../channel.ts';

function temp() { return mkdtempSync(join(tmpdir(), 'channel-test-')); }
test('row defaults, filters, malformed and incomplete lines, ordered ids, finish check', () => {
  const dir = temp(), log = join(dir, 'x.jsonl');
  try {
    const a = append(log, { kind: 'post', from: 'a', body: 'one' });
    const b = append(log, { kind: 'say', from: 'b', to: 'a', body: 'two' });
    append(log, { kind: 'post', from: 'c', to: '*', body: 'three' });
    const fin = append(log, { kind: 'finish', from: 'a', body: 'done', facts: [{ claim: 'x', how: 'y' }] });
    assert.equal(a.to, 'claude'); assert.equal(b.to, 'a'); assert.deepEqual(fin.fields.facts, [{ claim: 'x', how: 'y' }]);
    assert.ok(a.id < b.id && b.id < fin.id); assert.equal(lastId(log), fin.id);
    assert.deepEqual(read(log, { after: a.id, to: 'a' }).rows.map((r) => r.from), ['b', 'c']);
    assert.deepEqual(read(log, { after: 'missing-anchor' }).rows.map((r) => r.id), [a.id, b.id, read(log).rows[2]!.id, fin.id]);
    assert.equal(hasFinished(log, 'a', a.id), true); assert.equal(hasFinished(log, 'b', a.id), false);
    const originalNow = Date.now;
    try {
      Date.now = () => 1234567890000;
      const sameTimeA = append(log, { kind: 'post', from: 'a', body: 'same-time-a' });
      const sameTimeB = append(log, { kind: 'post', from: 'a', body: 'same-time-b' });
      assert.ok(sameTimeA.id < sameTimeB.id);
    } finally { Date.now = originalNow; }
    appendFileSync(log, '{broken}\n{"id":"incomplete-schema"}\n{"id":"partial"');
    assert.equal(read(log).rows.length, 6); assert.equal(read(log).skipped, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('wait times out', async () => {
  const dir = temp();
  try { assert.equal(await wait(join(dir, 'missing'), { kind: 'finish' }, { timeoutMs: 35 }), null); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real CLI processes wait/finish, timeout, and concurrent append integrity', async () => {
  const dir = temp(), log = join(dir, 'events.jsonl');
  const bin = resolve('channel/bin/channel');
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) => new Promise<{ code: number | null; out: string }>((resolvePromise) => {
    const child = spawn(bin, args, { env: { ...process.env, AGENT_CHANNEL: log, AGENT_CHANNEL_NAME: 'impl-x', ...env } });
    let out = ''; child.stdout.setEncoding('utf8').on('data', (s) => out += s);
    child.on('close', (code) => resolvePromise({ code, out }));
  });
  try {
    const before = await run(['last-id']);
    const waiting = run(['wait', '--kind', 'finish', '--from', 'impl-x', ...(before.out.trim() ? ['--after', before.out.trim()] : []), '--timeout', '10']);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await run(['finish', '--summary', 'ok'])).code, 0);
    const received = await waiting; assert.equal(received.code, 0); assert.match(received.out, /"kind":"finish"/);
    assert.equal((await run(['wait', '--kind', 'say', '--timeout', '0.05'])).code, 124);
    const moduleUrl = new URL('../channel.ts', import.meta.url).href;
    const anchor = lastId(log)!;
    let stopFollowing = () => {};
    let delivered = 0;
    const allFollowed = new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error(`follow delivered only ${delivered}/400 rows`)), 5000);
      stopFollowing = follow(log, {}, () => {
        delivered++;
        if (delivered === 400) { clearTimeout(timeout); resolvePromise(); }
      }, { after: anchor });
    });
    const writerScript = `const { append } = await import(${JSON.stringify(moduleUrl)}); Date.now = () => 4102444800000; for (let i = 0; i < 200; i++) append(${JSON.stringify(log)}, { kind: 'post', from: process.argv[1], body: String(i) });`;
    const workers = ['writer-a', 'writer-b'].map((name) => new Promise<void>((resolvePromise, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', writerScript, name]);
      child.on('error', reject); child.on('close', (code) => code === 0 ? resolvePromise() : reject(new Error(`writer exit ${code}`)));
    }));
    try { await Promise.all(workers); await allFollowed; }
    finally { stopFollowing(); }
    const result = read(log); assert.equal(result.skipped, 0); assert.equal(result.rows.length, 401);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
