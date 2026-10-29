import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { Ledger } from '../../../ledger.ts';

const wait = async (fn: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('timed out waiting for dashboard server');
};

test('consult action accepts the configured relay Origin and rejects another Origin without mutation', async (t) => {
  const web = fileURLToPath(new URL('../..', import.meta.url));
  const serverBundle = join(web, 'build/server/index.js');
  if (!existsSync(serverBundle)) { t.skip('built dashboard server is unavailable; run web/check.sh first'); return; }
  const root = mkdtempSync(join(tmpdir(), 'task-consult-origin-'));
  const repo = join(root, 'origin-project');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const db = join(root, 'ledger.sqlite');
  const ledger = new Ledger(db);
  const task = ledger.add({ repo, title: 'Origin decision', why: 'test', brief: 'test' });
  ledger.setStatus(task.id, '判断待ち', 'question');
  ledger.close();
  const portServer = createServer();
  await new Promise<void>((resolve) => portServer.listen(0, '127.0.0.1', resolve));
  const address = portServer.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) => portServer.close((error) => error ? reject(error) : resolve()));
  const child = spawn(process.execPath, [join(web, 'node_modules/@react-router/serve/bin.cjs'), serverBundle], {
    cwd: web,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), TASK_LEDGER_DB: db, TASK_DASHBOARD_REPOS_DIR: root },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let stderr = '';
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const url = `http://127.0.0.1:${port}/p/origin-project/consult/${task.id}`;
  try {
    await wait(async () => {
      try { return (await fetch(url)).status === 200; } catch { return false; }
    });
    const body = (text: string) => new URLSearchParams({ intent: 'consult-decide', taskId: task.id, text, to: '待ち' });
    const accepted = await fetch(url, { method: 'POST', headers: { Origin: 'https://fedora.tail907624.ts.net:10000', 'Content-Type': 'application/x-www-form-urlencoded' }, body: body('accepted') });
    assert.equal(accepted.status, 200, await accepted.text());
    const afterAccepted = new Ledger(db);
    assert.match(afterAccepted.get(task.id)?.note ?? '', /答え: accepted/);
    afterAccepted.setStatus(task.id, '判断待ち', 'question again');
    afterAccepted.close();
    const goalTabAnswer = await fetch(url, { method: 'POST', headers: { Origin: 'https://fedora.tail907624.ts.net:10000', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ intent: 'answer', taskId: task.id, text: 'goal-tab-answer', to: '待ち' }) });
    assert.equal(goalTabAnswer.status, 200, await goalTabAnswer.text());
    const afterGoalTabAnswer = new Ledger(db);
    assert.equal(afterGoalTabAnswer.get(task.id)?.status, '待ち');
    assert.match(afterGoalTabAnswer.get(task.id)?.note ?? '', /答え: goal-tab-answer/);
    afterGoalTabAnswer.setStatus(task.id, '判断待ち', 'question before rejected Origin');
    afterGoalTabAnswer.close();
    const rejected = await fetch(url, { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: body('rejected') });
    assert.equal(rejected.status, 400, `unexpected response: ${rejected.status}; ${await rejected.text()}; server: ${stderr}`);
    const afterRejected = new Ledger(db);
    assert.equal(afterRejected.get(task.id)?.status, '判断待ち');
    assert.doesNotMatch(afterRejected.get(task.id)?.note ?? '', /答え: rejected/);
    afterRejected.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
});
