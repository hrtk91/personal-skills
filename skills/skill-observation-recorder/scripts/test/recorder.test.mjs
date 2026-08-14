import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'

const scriptsDir = dirname(dirname(fileURLToPath(import.meta.url)))
const hook = join(scriptsDir, 'session-end-hook.mjs')
const worker = join(scriptsDir, 'worker.mjs')
const fakeCodex = join(dirname(fileURLToPath(import.meta.url)), 'fake-codex.mjs')

async function fixtureRoot(name) {
  return mkdtemp(join(tmpdir(), `skill-observation-recorder-${name}-`))
}

async function writeTranscript(root) {
  const path = join(root, 'transcript.jsonl')
  const events = [
    ['user', '監査イベント保存のテストを書いて。'],
    ['assistant', '保存件数が1件であることをassertしました。'],
    ['user', '件数だけだと別イベントを保存しても通る。種類、対象ID、実行者、payloadを確認して。'],
    ['assistant', '主要項目をDBから読み戻して確認するよう修正しました。'],
  ].map(([role, text]) => JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role, content: [{ type: 'text', text }] },
  })).join('\n')
  await writeFile(path, `${events}\n`)
  return path
}

async function writeLongTranscript(root) {
  const path = join(root, 'long-transcript.jsonl')
  const messages = []
  for (let index = 0; index < 8; index += 1) messages.push(['user', `先行メッセージ${index}:${'x'.repeat(10_000)}`])
  messages.push(
    ['user', '監査イベント保存のテストを書いて。'],
    ['assistant', '保存件数が1件であることをassertしました。'],
    ['user', '件数だけだと別イベントを保存しても通る。種類、対象ID、実行者、payloadを確認して。'],
    ['assistant', '主要項目をDBから読み戻して確認するよう修正しました。'],
  )
  for (let index = 0; index < 8; index += 1) messages.push(['user', `後続メッセージ${index}:${'x'.repeat(10_000)}`])
  const events = messages.map(([role, text]) => JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role, content: [{ type: 'text', text }] },
  })).join('\n')
  await writeFile(path, `${events}\n`)
  return path
}

function run(script, args, env, input) {
  return spawnSync(process.execPath, [script, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

function storageId(sessionId) {
  return Buffer.from(sessionId).toString('base64url')
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail('timed out waiting for condition')
}

function start(script, args, env) {
  return spawn(process.execPath, [script, ...args], {
    stdio: 'ignore',
    env: { ...process.env, ...env },
  })
}

test('manual backfill queues a transcript and the Codex analyzer saves its resolved observation', async () => {
  const root = await fixtureRoot('backfill')
  const transcript = await writeTranscript(root)
  await chmod(fakeCodex, 0o700)
  const env = {
    CODEX_SKILL_OBSERVATION_DATA_DIR: root,
    SKILL_OBSERVATION_ANALYZER: fakeCodex,
  }

  const result = run(hook, ['--transcript', transcript, '--session-id', 'enqu-pr-test'], env)
  assert.equal(result.status, 0, result.stderr)

  const observationsDir = join(root, 'observations', new Date().toISOString().slice(0, 10))
  let record
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const [name] = await readdir(observationsDir)
      record = JSON.parse(await readFile(join(observationsDir, name), 'utf8'))
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  assert.equal(record?.observations?.[0]?.actual, '保存件数だけを確認した')
  assert.equal(record?.observations?.[0]?.expected, '種類、対象ID、実行者、payloadを確認する')
})

test('analyzer child SessionEnd does not enqueue another job', async () => {
  const root = await fixtureRoot('recursive')
  const transcript = await writeTranscript(root)
  const input = JSON.stringify({
    hook_event_name: 'SessionEnd',
    session_id: 'analyzer-child',
    transcript_path: transcript,
  })
  const result = run(hook, [], {
    CODEX_SKILL_OBSERVATION_DATA_DIR: root,
    SKILL_OBSERVATION_ANALYZER_RUNNING: '1',
  }, input)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(await readdir(join(root, 'queue', 'pending')).catch(() => []), [])
})

test('long transcripts keep corrections from early chunks', async () => {
  const root = await fixtureRoot('chunks')
  const transcript = await writeLongTranscript(root)
  await mkdir(join(root, 'queue', 'pending'), { recursive: true })
  await writeFile(join(root, 'queue', 'pending', 'long.json'), `${JSON.stringify({
    schema_version: 1,
    session_id: 'long',
    storage_id: storageId('long'),
    job_id: 'long-job',
    transcript_path: transcript,
    cwd: null,
    ended_at: new Date().toISOString(),
  })}\n`)

  const result = run(worker, [], {
    CODEX_SKILL_OBSERVATION_DATA_DIR: root,
    SKILL_OBSERVATION_ANALYZER: fakeCodex,
  })
  assert.equal(result.status, 0, result.stderr)
  const log = await readFile(join(root, 'logs', 'worker.log'), 'utf8')
  assert.match(log, /[2-9][0-9]* chunk\(s\)/)
  assert.match(log, /[2-9][0-9]* candidate\(s\)/)
  const date = new Date().toISOString().slice(0, 10)
  const record = JSON.parse(await readFile(join(root, 'observations', date, `${storageId('long')}-long-job.json`), 'utf8'))
  assert.equal(record.observations.length, 1)
})

test('a job left in processing is recovered and analyzed on the next worker start', async () => {
  const root = await fixtureRoot('recover')
  const processing = join(root, 'queue', 'processing')
  await mkdir(processing, { recursive: true })
  const transcript = await writeTranscript(root)
  await writeFile(join(processing, 'recovered.json.99999999.processing'), `${JSON.stringify({
    schema_version: 1,
    session_id: 'recovered',
    storage_id: storageId('recovered'),
    job_id: 'recovered-job',
    transcript_path: transcript,
    cwd: null,
    ended_at: new Date().toISOString(),
  })}\n`)

  const result = run(worker, [], {
    CODEX_SKILL_OBSERVATION_DATA_DIR: root,
    SKILL_OBSERVATION_ANALYZER: fakeCodex,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(await readdir(processing), [])
  assert.deepEqual(await readdir(join(root, 'queue', 'done')), ['recovered.json'])
})

test('a claim owned by a live worker is not recovered', async () => {
  const root = await fixtureRoot('live-claim')
  const processing = join(root, 'queue', 'processing')
  await mkdir(processing, { recursive: true })
  const claim = `active.json.${process.pid}.processing`
  await writeFile(join(processing, claim), '{}\n')

  const result = run(worker, [], { CODEX_SKILL_OBSERVATION_DATA_DIR: root })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(await readdir(processing), [claim])
})

test('a stale claim is recovered even if its PID has been reused', async () => {
  const root = await fixtureRoot('stale-claim')
  const processing = join(root, 'queue', 'processing')
  await mkdir(processing, { recursive: true })
  const transcript = await writeTranscript(root)
  const claim = `stale.json.${process.pid}.processing`
  await writeFile(join(processing, claim), `${JSON.stringify({
    schema_version: 1,
    session_id: 'stale',
    storage_id: storageId('stale'),
    job_id: 'stale-job',
    transcript_path: transcript,
    ended_at: new Date().toISOString(),
  })}\n`)
  const old = new Date(Date.now() - 4 * 60 * 1000)
  await utimes(join(processing, claim), old, old)

  const result = run(worker, [], {
    CODEX_SKILL_OBSERVATION_DATA_DIR: root,
    SKILL_OBSERVATION_ANALYZER: fakeCodex,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(await readdir(processing), [])
  assert.deepEqual(await readdir(join(root, 'queue', 'done')), ['stale.json'])
})

test('concurrent workers recover one interrupted claim only once', async () => {
  const root = await fixtureRoot('concurrent-recovery')
  const processing = join(root, 'queue', 'processing')
  await mkdir(processing, { recursive: true })
  const transcript = await writeTranscript(root)
  await writeFile(join(processing, 'recover-once.json.99999999.processing'), `${JSON.stringify({
    schema_version: 1,
    session_id: 'recover-once',
    storage_id: storageId('recover-once'),
    job_id: 'recover-once-job',
    transcript_path: transcript,
    ended_at: new Date().toISOString(),
  })}\n`)
  const env = {
    CODEX_SKILL_OBSERVATION_DATA_DIR: root,
    SKILL_OBSERVATION_ANALYZER: fakeCodex,
    FAKE_CODEX_DELAY_MS: '100',
  }
  const first = start(worker, [], env)
  const second = start(worker, [], env)
  await Promise.all([
    new Promise((resolve) => first.once('exit', resolve)),
    new Promise((resolve) => second.once('exit', resolve)),
  ])
  assert.deepEqual(await readdir(processing), [])
  assert.deepEqual(await readdir(join(root, 'queue', 'done')), ['recover-once.json'])
  const date = new Date().toISOString().slice(0, 10)
  assert.deepEqual(await readdir(join(root, 'observations', date)), [`${storageId('recover-once')}-recover-once-job.json`])
})

test('invalid analyzer output moves the job to failed without saving an observation', async () => {
  const root = await fixtureRoot('invalid-output')
  const pending = join(root, 'queue', 'pending')
  await mkdir(pending, { recursive: true })
  const transcript = await writeTranscript(root)
  await writeFile(join(pending, 'invalid.json'), `${JSON.stringify({
    schema_version: 1,
    session_id: 'invalid',
    storage_id: storageId('invalid'),
    job_id: 'invalid-job',
    transcript_path: transcript,
    cwd: null,
    ended_at: new Date().toISOString(),
  })}\n`)

  const result = run(worker, [], {
    CODEX_SKILL_OBSERVATION_DATA_DIR: root,
    SKILL_OBSERVATION_ANALYZER: fakeCodex,
    FAKE_CODEX_RESPONSE: '[1]',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(await readdir(join(root, 'queue', 'failed')), ['invalid.json'])
  assert.deepEqual(await readdir(join(root, 'observations')).catch(() => []), [])
})

test('malformed job JSON is moved to failed and does not block later jobs', async () => {
  const root = await fixtureRoot('malformed-job')
  const pending = join(root, 'queue', 'pending')
  await mkdir(pending, { recursive: true })
  await writeFile(join(pending, 'a-malformed.json'), '{broken\n')
  const transcript = await writeTranscript(root)
  await writeFile(join(pending, 'b-valid.json'), `${JSON.stringify({
    schema_version: 1,
    session_id: 'valid-after-malformed',
    storage_id: storageId('valid-after-malformed'),
    job_id: 'valid-job',
    transcript_path: transcript,
    ended_at: new Date().toISOString(),
  })}\n`)

  const result = run(worker, [], {
    CODEX_SKILL_OBSERVATION_DATA_DIR: root,
    SKILL_OBSERVATION_ANALYZER: fakeCodex,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(await readdir(join(root, 'queue', 'failed')), ['a-malformed.json'])
  assert.deepEqual(await readdir(join(root, 'queue', 'done')), ['b-valid.json'])
})

test('manual backfill rejects missing transcript values', async () => {
  const root = await fixtureRoot('invalid-cli')
  const result = run(hook, ['--transcript', '--session-id', 'x'], {
    CODEX_SKILL_OBSERVATION_DATA_DIR: root,
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /--transcript requires a file path/)
})

test('analyzer nonzero exit moves the job to failed', async () => {
  const root = await fixtureRoot('nonzero')
  const pending = join(root, 'queue', 'pending')
  await mkdir(pending, { recursive: true })
  const transcript = await writeTranscript(root)
  await writeFile(join(pending, 'nonzero.json'), `${JSON.stringify({
    schema_version: 1,
    session_id: 'nonzero',
    storage_id: storageId('nonzero'),
    job_id: 'nonzero-job',
    transcript_path: transcript,
    ended_at: new Date().toISOString(),
  })}\n`)
  const result = run(worker, [], {
    CODEX_SKILL_OBSERVATION_DATA_DIR: root,
    SKILL_OBSERVATION_ANALYZER: fakeCodex,
    FAKE_CODEX_EXIT_CODE: '7',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(await readdir(join(root, 'queue', 'failed')), ['nonzero.json'])
})

test('analyzer timeout moves the job to failed', async () => {
  const root = await fixtureRoot('timeout')
  const pending = join(root, 'queue', 'pending')
  await mkdir(pending, { recursive: true })
  const transcript = await writeTranscript(root)
  await writeFile(join(pending, 'timeout.json'), `${JSON.stringify({
    schema_version: 1,
    session_id: 'timeout',
    storage_id: storageId('timeout'),
    job_id: 'timeout-job',
    transcript_path: transcript,
    ended_at: new Date().toISOString(),
  })}\n`)
  const result = run(worker, [], {
    CODEX_SKILL_OBSERVATION_DATA_DIR: root,
    SKILL_OBSERVATION_ANALYZER: fakeCodex,
    FAKE_CODEX_DELAY_MS: '100',
    SKILL_OBSERVATION_ANALYZER_TIMEOUT_MS: '10',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(await readdir(join(root, 'queue', 'failed')), ['timeout.json'])
})

test('a job enqueued while another worker is active is processed by its own worker', async () => {
  const root = await fixtureRoot('handoff')
  const pending = join(root, 'queue', 'pending')
  const processing = join(root, 'queue', 'processing')
  await mkdir(pending, { recursive: true })
  const transcript = await writeTranscript(root)
  const job = (sessionId) => JSON.stringify({
    schema_version: 1,
    session_id: sessionId,
    storage_id: storageId(sessionId),
    job_id: `${sessionId}-job`,
    transcript_path: transcript,
    cwd: null,
    ended_at: new Date().toISOString(),
  })
  await writeFile(join(pending, 'first.json'), `${job('first')}\n`)
  const env = {
    CODEX_SKILL_OBSERVATION_DATA_DIR: root,
    SKILL_OBSERVATION_ANALYZER: fakeCodex,
    FAKE_CODEX_DELAY_MS: '250',
  }
  const firstWorker = start(worker, [], env)
  await waitFor(async () => (await readdir(processing).catch(() => [])).length === 1)

  await writeFile(join(pending, 'second.json'), `${job('second')}\n`)
  const secondWorker = start(worker, [], env)
  await Promise.all([
    new Promise((resolve) => firstWorker.once('exit', resolve)),
    new Promise((resolve) => secondWorker.once('exit', resolve)),
  ])

  assert.deepEqual((await readdir(join(root, 'queue', 'done'))).sort(), ['first.json', 'second.json'])
  assert.deepEqual(await readdir(pending), [])
})

test('claiming an old pending job renews its lease before processing', async () => {
  const root = await fixtureRoot('old-pending')
  const pending = join(root, 'queue', 'pending')
  const processing = join(root, 'queue', 'processing')
  await mkdir(pending, { recursive: true })
  const transcript = await writeTranscript(root)
  const pendingJob = join(pending, 'old.json')
  await writeFile(pendingJob, `${JSON.stringify({
    schema_version: 1,
    session_id: 'old',
    storage_id: storageId('old'),
    job_id: 'old-job',
    transcript_path: transcript,
    ended_at: new Date().toISOString(),
  })}\n`)
  const old = new Date(Date.now() - 4 * 60 * 1000)
  await utimes(pendingJob, old, old)

  const child = start(worker, [], {
    CODEX_SKILL_OBSERVATION_DATA_DIR: root,
    SKILL_OBSERVATION_ANALYZER: fakeCodex,
    FAKE_CODEX_DELAY_MS: '250',
  })
  await waitFor(async () => (await readdir(processing).catch(() => [])).length === 1)
  const [claim] = await readdir(processing)
  assert.ok(Date.now() - (await stat(join(processing, claim))).mtimeMs < 10_000)
  await new Promise((resolve) => child.once('exit', resolve))
})
