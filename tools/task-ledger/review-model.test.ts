import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseReviewModel, weeklyRemaining } from './review-model.ts';

test('review model selects the larger quota and Claude wins ties', () => {
  assert.equal(chooseReviewModel({ claudeRemaining: 40, codexRemaining: 60 }).model, 'gpt-6.1-terra');
  assert.equal(chooseReviewModel({ claudeRemaining: 60, codexRemaining: 40 }).model, 'sonnet');
  assert.equal(chooseReviewModel({ claudeRemaining: 50, codexRemaining: 50 }).model, 'sonnet');
});
test('remaining percentages compare Claude and Codex, ignoring non-weekly Codex windows', () => {
  assert.deepEqual(weeklyRemaining({ claudePercent: 35, codexUsedPercent: 20, codexWindowDurationMins: 10080 }), { claudeRemaining: 65, codexRemaining: 80 });
  assert.deepEqual(weeklyRemaining({ claudePercent: null, codexUsedPercent: 20, codexWindowDurationMins: 300 }), { claudeRemaining: null, codexRemaining: null });
  assert.deepEqual(weeklyRemaining({ claudePercent: 101, codexUsedPercent: null, codexWindowDurationMins: 10080 }), { claudeRemaining: null, codexRemaining: null });
});
test('review model falls back to whichever quota can be read, then sonnet', () => {
  assert.equal(chooseReviewModel({ claudeRemaining: 70, codexRemaining: null }).model, 'sonnet');
  assert.equal(chooseReviewModel({ claudeRemaining: null, codexRemaining: 70 }).model, 'gpt-6.1-terra');
  assert.equal(chooseReviewModel({ claudeRemaining: null, codexRemaining: null }).model, 'sonnet');
  assert.equal(chooseReviewModel({ claudeRemaining: Number.NaN, codexRemaining: Infinity }).model, 'sonnet');
});
