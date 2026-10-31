import { spawnSync } from 'node:child_process';

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Read the fresh primary Codex rate-limit window through app-server JSON-RPC. */
export function readCodexWeeklyRemaining(bin = process.env.TASK_CODEX_BIN ?? 'codex'): { usedPercent: number; windowDurationMins: number } | null {
  try {
    const requests = [
      JSON.stringify({ method: 'initialize', id: 1, params: { clientInfo: { name: 'task-ledger', title: 'task-ledger', version: '1' }, capabilities: {} } }),
      JSON.stringify({ method: 'initialized', params: {} }),
      JSON.stringify({ method: 'account/rateLimits/read', id: 2, params: {} }),
    ];
    // app-server may still be loading auth when its stdin reaches EOF; keep the request pipe open briefly.
    const command = `{ printf '%s\\n' ${requests.map(quote).join(' ')}; sleep 2; } | ${quote(bin)} app-server`;
    const result = spawnSync('bash', ['-c', command], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, TMPDIR: '/tmp' } });
    if (result.status !== 0) return null;
    const row = result.stdout.split(/\r?\n/).map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((item) => item?.id === 2);
    const primary = row?.result?.rateLimits?.primary;
    if (!primary || !Number.isFinite(primary.usedPercent) || !Number.isFinite(primary.windowDurationMins)) return null;
    return { usedPercent: primary.usedPercent, windowDurationMins: primary.windowDurationMins };
  } catch { return null; }
}
