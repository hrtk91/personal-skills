import { parentPort, workerData } from 'node:worker_threads';
import { getClaudeUsage } from './claude-usage.ts';

try {
  const result = getClaudeUsage(7, workerData.now);
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) });
}
