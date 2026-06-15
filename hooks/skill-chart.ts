#!/usr/bin/env npx ts-node

/**
 * スキル使用率をCLIグラフで表示する
 *
 * 使い方:
 *   npx ts-node ~/.claude/hooks/skill-chart.ts          # 全スキル
 *   npx ts-node ~/.claude/hooks/skill-chart.ts --days 7 # 過去7日
 *   npx ts-node ~/.claude/hooks/skill-chart.ts --top 5  # 上位5件
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const USAGE_FILE = join(homedir(), '.claude', 'sessions', 'skill-usage.json')
const SPARKS = ' ▁▂▃▄▅▆▇█'

// オプション解析
const args = process.argv.slice(2)
const daysArg = args.indexOf('--days')
const topArg = args.indexOf('--top')
const DAYS = daysArg >= 0 ? parseInt(args[daysArg + 1]) || 14 : 14
const TOP = topArg >= 0 ? parseInt(args[topArg + 1]) || 10 : 10

function sparkline(values: number[]): string {
  const max = Math.max(...values, 1)
  return values.map(v => SPARKS[Math.round((v / max) * 8)]).join('')
}

function getDates(days: number): string[] {
  const dates: string[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
    dates.push(d.toISOString().split('T')[0])
  }
  return dates
}

function padEnd(str: string, len: number): string {
  const visible = [...str].length  // 絵文字・マルチバイト対応
  return str + ' '.repeat(Math.max(0, len - visible))
}

if (!existsSync(USAGE_FILE)) {
  console.log('まだ使用データがありません。スキルを使うと蓄積されます。')
  process.exit(0)
}

const data = JSON.parse(readFileSync(USAGE_FILE, 'utf-8'))
const totals: Record<string, number> = data.totals ?? {}
const daily: Record<string, Record<string, number>> = data.daily ?? {}
const lastUsed: Record<string, string> = data.last_used ?? {}

const dates = getDates(DAYS)
const today = dates[dates.length - 1]

// 全スキル名を totals から取得、使用回数でソート
const allSkills = Object.entries(totals)
  .sort(([, a], [, b]) => b - a)
  .slice(0, TOP)

if (allSkills.length === 0) {
  console.log('まだ使用データがありません。')
  process.exit(0)
}

// 最長スキル名の長さ
const maxNameLen = Math.max(...allSkills.map(([name]) => name.length), 10)

// ヘッダー
const dateLabels = dates
  .filter((_, i) => i % 7 === 0 || i === dates.length - 1)
  .map(d => d.slice(5)) // MM-DD
console.log('')
console.log(`  スキル使用ランキング (過去${DAYS}日)`)
console.log(`  ${'─'.repeat(maxNameLen + 2 + DAYS + 10)}`)
console.log(`  ${'スキル名'.padEnd(maxNameLen)}  ${'過去' + DAYS + '日'.padEnd(DAYS - 4)}  合計  最終使用`)
console.log(`  ${'─'.repeat(maxNameLen + 2 + DAYS + 10)}`)

for (const [skill, total] of allSkills) {
  const values = dates.map(date => daily[date]?.[skill] ?? 0)
  const graph = sparkline(values)
  const todayCount = daily[today]?.[skill] ?? 0
  const todayStr = todayCount > 0 ? `+${todayCount}` : '  '
  const last = lastUsed[skill]
    ? new Date(lastUsed[skill]).toISOString().split('T')[0].slice(5)
    : '------'

  const nameCol = padEnd(skill, maxNameLen)
  const totalStr = String(total).padStart(3)
  console.log(`  ${nameCol}  ${graph}  ${totalStr}回  ${last} ${todayStr}`)
}

console.log(`  ${'─'.repeat(maxNameLen + 2 + DAYS + 10)}`)

// 未使用スキル（totalに出てこないもの）
const unusedCount = Object.keys(data.totals ?? {}).filter(s => !allSkills.find(([n]) => n === s)).length
if (unusedCount > 0) {
  console.log(`  ※ 他${unusedCount}件は未使用 or TOP${TOP}外`)
}
console.log('')
