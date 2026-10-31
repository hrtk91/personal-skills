import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseReviewModel } from './review-model.ts';

test('review model selects the larger quota and Claude wins ties', () => {
  assert.equal(chooseReviewModel({ claudeRemaining: 40, codexRemaining: 60 }).model, 'gpt-6.1-terra');
  assert.equal(chooseReviewModel({ claudeRemaining: 60, codexRemaining: 40 }).model, 'sonnet');
  assert.equal(chooseReviewModel({ claudeRemaining: 50, codexRemaining: 50 }).model, 'sonnet');
});
test('review model falls back to whichever quota can be read, then sonnet', () => {
  assert.equal(chooseReviewModel({ claudeRemaining: 70, codexRemaining: null }).model, 'sonnet');
  assert.equal(chooseReviewModel({ claudeRemaining: null, codexRemaining: 70 }).model, 'gpt-6.1-terra');
  assert.equal(chooseReviewModel({ claudeRemaining: null, codexRemaining: null }).model, 'sonnet');
  assert.equal(chooseReviewModel({ claudeRemaining: Number.NaN, codexRemaining: Infinity }).model, 'sonnet');
});
