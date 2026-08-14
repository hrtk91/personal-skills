#!/usr/bin/env node

if (!process.argv.includes('exec') || !process.argv.includes('--ephemeral') || !process.argv.includes('--ignore-user-config') || !process.argv.includes('read-only')) {
  process.stderr.write(`unexpected analyzer arguments: ${process.argv.slice(2).join(' ')}\n`)
  process.exit(2)
}
if (!process.argv.some((value, index) => value === '-c' && process.argv[index + 1] === 'web_search="disabled"')) {
  process.stderr.write('web search was not disabled\n')
  process.exit(2)
}
for (const feature of ['shell_tool', 'unified_exec', 'code_mode_host', 'multi_agent', 'apps', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'image_generation', 'goals', 'view_image', 'tool_suggest']) {
  const disabled = process.argv.some((value, index) => value === '--disable' && process.argv[index + 1] === feature)
  if (!disabled) {
    process.stderr.write(`analyzer feature was not disabled: ${feature}\n`)
    process.exit(2)
  }
}
if (process.env.SKILL_OBSERVATION_ANALYZER_RUNNING !== '1') {
  process.stderr.write('missing recursion guard\n')
  process.exit(2)
}

let input = ''
for await (const chunk of process.stdin) input += chunk

const delayMs = Number(process.env.FAKE_CODEX_DELAY_MS ?? 0)
if (delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs)

if (process.env.FAKE_CODEX_RESPONSE) {
  process.stdout.write(process.env.FAKE_CODEX_RESPONSE)
  process.exit(0)
}
if (process.env.FAKE_CODEX_EXIT_CODE) process.exit(Number(process.env.FAKE_CODEX_EXIT_CODE))

if (input.includes('件数だけだと別イベントを保存しても通る') || input.includes('監査イベントの意味を確認しなかった')) {
  process.stdout.write(JSON.stringify([{
    title: '監査イベントの意味を確認しなかった',
    task: '監査イベント保存のテストを書く',
    expected: '種類、対象ID、実行者、payloadを確認する',
    actual: '保存件数だけを確認した',
    why_it_matters: '別のイベントを保存してもテストが通る',
    resolution: '主要項目をDBから読み戻して確認した',
    severity: 'medium',
    evidence: '件数だけでは別イベントでも通るという訂正',
  }]))
} else {
  process.stdout.write('[]')
}
