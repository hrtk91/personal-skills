#!/usr/bin/env node
"use strict";
/**
 * tmux Log CLI
 * tmuxログを範囲指定で取得・作業単位でまとめるツール
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
// ============================================================
// Constants
// ============================================================
const LOG_DIR = path.join(os.homedir(), "tmux-logs");
const WORK_UNIT_GAP_MINUTES = 3; // この分数以上空いたら別の作業単位
// ============================================================
// Utilities
// ============================================================
function getTodayLogs() {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    try {
        const files = fs.readdirSync(LOG_DIR);
        return files
            .filter((f) => f.includes(today) && f.endsWith(".log"))
            .map((f) => path.join(LOG_DIR, f))
            .sort();
    }
    catch {
        return [];
    }
}
function getLogsByDate(dateStr) {
    // dateStr: YYYY-MM-DD or YYYYMMDD
    const normalized = dateStr.replace(/-/g, "");
    try {
        const files = fs.readdirSync(LOG_DIR);
        return files
            .filter((f) => f.includes(normalized) && f.endsWith(".log"))
            .map((f) => path.join(LOG_DIR, f))
            .sort();
    }
    catch {
        return [];
    }
}
function readLogs(logFiles) {
    return logFiles.map((f) => fs.readFileSync(f, "utf-8")).join("\n");
}
function parseTimestamp(line) {
    // [2026-01-20 14:30:45] 形式を検出
    const match = line.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
    return match ? match[1] : null;
}
function extractTimeFromLine(line) {
    // HH:MM:SS または HH:MM 形式を検出
    const match = line.match(/(\d{2}:\d{2}(?::\d{2})?)/);
    return match ? match[1] : null;
}
function isCommandPrompt(line) {
    // 一般的なプロンプトパターン
    return /^[$%#>❯›»→]\s/.test(line.trim()) || /^\s*\$\s/.test(line);
}
function cleanLogContent(content) {
    // UIノイズを除去（Claude CodeのUI要素など）
    return content
        .split("\n")
        .filter((line) => {
        // 空行は保持
        if (!line.trim())
            return true;
        // 罫線は除去
        if (/^[─━═]+$/.test(line.trim()))
            return false;
        // トークン情報行は除去
        if (/tokens\s*$/.test(line))
            return false;
        // ステータスバー的なものは除去
        if (/🤖.*Opus.*│/.test(line))
            return false;
        if (/files\s+\+\d+\s+-\d+/.test(line))
            return false;
        // Waiting/Thinking系は除去
        if (/^[✳✢·⏺]?\s*(Waiting|Thinking|Running|Spelunking|Percolating|Pouncing|Osmosing)/i.test(line.trim()))
            return false;
        return true;
    })
        .join("\n");
}
// ============================================================
// Work Unit Detection
// ============================================================
function parseLogsToWorkUnits(content) {
    const lines = content.split("\n");
    const workUnits = [];
    let currentUnit = {
        startTime: null,
        endTime: null,
        lines: [],
        commands: [],
    };
    let lastTimestamp = null;
    for (const line of lines) {
        const timestamp = parseTimestamp(line);
        if (timestamp) {
            const currentTime = new Date(timestamp);
            // 前回から一定時間空いたら新しい作業単位
            if (lastTimestamp) {
                const gapMinutes = (currentTime.getTime() - lastTimestamp.getTime()) / 1000 / 60;
                if (gapMinutes >= WORK_UNIT_GAP_MINUTES && currentUnit.lines.length > 0) {
                    // 現在の作業単位を保存
                    workUnits.push(finalizeWorkUnit(currentUnit));
                    currentUnit = {
                        startTime: null,
                        endTime: null,
                        lines: [],
                        commands: [],
                    };
                }
            }
            if (!currentUnit.startTime) {
                currentUnit.startTime = timestamp;
            }
            currentUnit.endTime = timestamp;
            lastTimestamp = currentTime;
        }
        // コマンド検出
        if (isCommandPrompt(line)) {
            const cmd = line.replace(/^[$%#>❯›»→]\s*/, "").trim();
            if (cmd && !cmd.startsWith("(") && cmd.length < 200) {
                currentUnit.commands.push(cmd);
            }
        }
        currentUnit.lines.push(line);
    }
    // 最後の作業単位を保存
    if (currentUnit.lines.length > 0) {
        workUnits.push(finalizeWorkUnit(currentUnit));
    }
    return workUnits;
}
function finalizeWorkUnit(unit) {
    const rawContent = unit.lines.join("\n");
    const cleanContent = cleanLogContent(rawContent);
    // 作業時間計算
    let duration = "不明";
    if (unit.startTime && unit.endTime) {
        const start = new Date(unit.startTime);
        const end = new Date(unit.endTime);
        const diffMs = end.getTime() - start.getTime();
        const diffMin = Math.round(diffMs / 1000 / 60);
        duration = diffMin < 60 ? `${diffMin}分` : `${Math.floor(diffMin / 60)}時間${diffMin % 60}分`;
    }
    // サマリー生成（ユニークなコマンドを抽出）
    const uniqueCommands = [...new Set(unit.commands)].slice(0, 5);
    const summary = uniqueCommands.length > 0
        ? uniqueCommands.join(", ")
        : "（コマンド検出なし）";
    return {
        startTime: unit.startTime || "不明",
        endTime: unit.endTime || "不明",
        duration,
        commands: unit.commands,
        summary,
        rawContent: cleanContent,
    };
}
// ============================================================
// Commands
// ============================================================
function cmdList() {
    const logs = getTodayLogs();
    if (logs.length === 0) {
        console.log("今日のログファイルがありません");
        return;
    }
    console.log("今日のログファイル:");
    for (const log of logs) {
        const stat = fs.statSync(log);
        const size = (stat.size / 1024).toFixed(1);
        console.log(`  ${path.basename(log)} (${size}KB)`);
    }
}
function cmdRaw(args) {
    const opts = parseArgs(args);
    const logs = opts.date ? getLogsByDate(opts.date) : getTodayLogs();
    if (logs.length === 0) {
        console.error("ログファイルが見つかりません");
        process.exit(1);
    }
    let content = readLogs(logs);
    // --last N: 最新N行
    if (opts.last) {
        const lines = content.split("\n");
        content = lines.slice(-parseInt(opts.last)).join("\n");
    }
    // --since HH:MM: 指定時刻以降
    if (opts.since) {
        const lines = content.split("\n");
        let printing = false;
        const filtered = [];
        for (const line of lines) {
            const time = extractTimeFromLine(line);
            if (time && time >= opts.since) {
                printing = true;
            }
            if (printing) {
                filtered.push(line);
            }
        }
        content = filtered.join("\n");
    }
    // --clean: UIノイズ除去
    if (opts.clean === "true") {
        content = cleanLogContent(content);
    }
    console.log(content);
}
function cmdUnits(args) {
    const opts = parseArgs(args);
    const logs = opts.date ? getLogsByDate(opts.date) : getTodayLogs();
    if (logs.length === 0) {
        console.error("ログファイルが見つかりません");
        process.exit(1);
    }
    const content = readLogs(logs);
    const workUnits = parseLogsToWorkUnits(content);
    if (opts.format === "json") {
        console.log(JSON.stringify(workUnits, null, 2));
        return;
    }
    // テキスト形式で出力
    console.log(`\n📋 作業単位: ${workUnits.length}件\n`);
    for (let i = 0; i < workUnits.length; i++) {
        const unit = workUnits[i];
        console.log(`━━━ #${i + 1} [${unit.startTime} 〜 ${unit.endTime}] (${unit.duration}) ━━━`);
        console.log(`📝 ${unit.summary}`);
        if (opts.verbose === "true") {
            console.log("\n--- 詳細 ---");
            console.log(unit.rawContent.slice(0, 1000));
            if (unit.rawContent.length > 1000) {
                console.log("... (省略)");
            }
        }
        console.log("");
    }
}
function cmdSummary(args) {
    const opts = parseArgs(args);
    const logs = opts.date ? getLogsByDate(opts.date) : getTodayLogs();
    if (logs.length === 0) {
        console.error("ログファイルが見つかりません");
        process.exit(1);
    }
    const content = readLogs(logs);
    const workUnits = parseLogsToWorkUnits(content);
    // 作業ログ形式で出力（obsidianに追記しやすい形式）
    console.log("# 作業ログ\n");
    for (const unit of workUnits) {
        const time = unit.startTime.split(" ")[1]?.slice(0, 5) || "??:??";
        console.log(`- ${time} ${unit.summary}`);
    }
}
// ============================================================
// Argument Parser
// ============================================================
function parseArgs(args) {
    const opts = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith("--")) {
            const key = args[i].replace(/^--/, "");
            const nextArg = args[i + 1];
            if (nextArg && !nextArg.startsWith("--")) {
                opts[key] = nextArg;
                i++;
            }
            else {
                opts[key] = "true";
            }
        }
    }
    return opts;
}
// ============================================================
// Main
// ============================================================
const [, , command, ...args] = process.argv;
switch (command) {
    case "list":
        cmdList();
        break;
    case "raw":
        cmdRaw(args);
        break;
    case "units":
        cmdUnits(args);
        break;
    case "summary":
        cmdSummary(args);
        break;
    default:
        console.log(`tmux Log CLI

Commands:
  list              今日のログファイル一覧
  raw               生ログ出力
  units             作業単位でまとめて表示
  summary           作業ログ形式で出力（obsidian追記用）

Options (raw/units/summary):
  --date YYYY-MM-DD   指定日のログ
  --last N            最新N行（rawのみ）
  --since HH:MM       指定時刻以降（rawのみ）
  --clean             UIノイズ除去（rawのみ）
  --format json       JSON形式で出力（unitsのみ）
  --verbose           詳細表示（unitsのみ）

Examples:
  tmux-log list
  tmux-log raw --last 100
  tmux-log raw --since 14:00 --clean
  tmux-log units
  tmux-log units --format json
  tmux-log summary
`);
}
