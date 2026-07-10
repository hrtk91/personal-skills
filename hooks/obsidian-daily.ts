#!/usr/bin/env npx ts-node

import { existsSync, mkdirSync, readFileSync, copyFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// 環境変数で設定可能
const vaultPath = process.env.OBSIDIAN_VAULT || join(homedir(), 'obsidian-vault')
const dailyNoteSubdir = process.env.OBSIDIAN_DAILY_SUBDIR || 'デイリーノート'
const templateName = process.env.OBSIDIAN_TEMPLATE || 'templates/daily-notes.md'

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']
const SESSIONS_FILE = join(homedir(), '.claude', 'sessions', 'active.json')
const PROFILE_FILE = join(homedir(), '.claude', 'retlaude', 'user-profile.json')
const SKILL_USAGE_FILE = join(homedir(), '.claude', 'sessions', 'skill-usage.json')

const today = new Date()
const dateStr = today.toISOString().split('T')[0]
const weekday = WEEKDAYS[today.getDay()]
const year = String(today.getFullYear())
const month = String(today.getMonth() + 1).padStart(2, '0')

const dailyNoteDir = join(vaultPath, dailyNoteSubdir, year, month)
const dailyNotePath = join(dailyNoteDir, `${dateStr}.md`)
const templatePath = join(vaultPath, templateName)

function relativeTime(isoStr: string): string {
  const diffMs = Date.now() - new Date(isoStr).getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return 'たった今'
  if (mins < 60) return `${mins}分前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}時間前`
  return `${Math.floor(hours / 24)}日前`
}

// デイリーノートがなければ作成
if (!existsSync(dailyNotePath)) {
  mkdirSync(dailyNoteDir, { recursive: true })
  if (existsSync(templatePath)) {
    copyFileSync(templatePath, dailyNotePath)
  }
}

// TODOセクションだけ抽出して表示
if (existsSync(dailyNotePath)) {
  const content = readFileSync(dailyNotePath, 'utf-8')
  const lines = content.split('\n')

  let inTodoSection = false
  const todos: string[] = []

  for (const line of lines) {
    if (line.startsWith('# 今日やること') || line.startsWith('# TODO')) {
      inTodoSection = true
      continue
    }
    if (line.startsWith('# ') && inTodoSection) break
    if (inTodoSection && line.includes('[ ]')) {
      todos.push(line.trim())
    }
  }

  if (todos.length > 0) {
    console.log(`[Obsidian] 📅 ${dateStr} (${weekday}) - 未完了タスク: ${todos.length}件`)
    todos.slice(0, 3).forEach((t) => console.log(`  ${t}`))
    if (todos.length > 3) console.log(`  ... 他${todos.length - 3}件`)
  } else {
    console.log(`[Obsidian] 📅 ${dateStr} (${weekday}) - タスクなし`)
  }
}

// active.json から直近のタスク履歴を表示
if (existsSync(SESSIONS_FILE)) {
  try {
    const data = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'))
    const allTasks: { task: string; at: string }[] = []

    for (const session of Object.values(data.sessions) as any[]) {
      if (Array.isArray(session.task_history)) {
        allTasks.push(...session.task_history)
      }
    }

    // 時刻順にソートして直近5件を取得
    const recent = allTasks
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 5)

    if (recent.length > 0) {
      console.log('[直近の作業]')
      for (const entry of recent) {
        const time = relativeTime(entry.at)
        const task = entry.task.length > 140 ? entry.task.slice(0, 140) + '…' : entry.task
        console.log(`  - ${task} (${time})`)
      }
    }
  } catch {
    // active.json が壊れていても無視
  }
}

// skill-usage.json からスキル使用ランキングを表示
if (existsSync(SKILL_USAGE_FILE)) {
  try {
    const usage = JSON.parse(readFileSync(SKILL_USAGE_FILE, 'utf-8'))
    const totals: Record<string, number> = usage.totals ?? {}
    const today = new Date().toISOString().split('T')[0]
    const todayUsage: Record<string, number> = usage.daily?.[today] ?? {}

    const ranked = Object.entries(totals)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)

    if (ranked.length > 0) {
      console.log('[スキル使用ランキング(累計)]')
      for (const [skill, count] of ranked) {
        const todayCount = todayUsage[skill] ? ` (+${todayUsage[skill]}今日)` : ''
        console.log(`  ${count}回 ${skill}${todayCount}`)
      }
    }
  } catch {
    // 壊れていても無視
  }
}

// user-profile.json からプロフィールを表示
if (existsSync(PROFILE_FILE)) {
  try {
    const profile = JSON.parse(readFileSync(PROFILE_FILE, 'utf-8'))

    const recentTopics: string[] = (profile.recent_sessions ?? [])
      .slice(0, 3)
      .flatMap((s: { topics: string[] }) => s.topics)
      .slice(0, 6)

    const interests: string[] = (profile.accumulated_interests ?? []).slice(0, 5)

    const observations: { date: string; note: string }[] = profile.personality_observations ?? []
    const latestObservation = observations[0] ?? null

    if (recentTopics.length > 0 || interests.length > 0 || latestObservation) {
      console.log('[あなたについて]')
      if (recentTopics.length > 0) {
        console.log(`  最近の話題: ${recentTopics.join(', ')}`)
      }
      if (interests.length > 0) {
        console.log(`  よく話すテーマ: ${interests.join(', ')}`)
      }
      if (latestObservation) {
        console.log(`  観察メモ(${latestObservation.date}): ${latestObservation.note}`)
      }
    }
  } catch {
    // user-profile.json が壊れていても無視
  }
}

process.exit(0)
