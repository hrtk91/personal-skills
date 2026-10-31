import { test } from 'node:test';
import assert from 'node:assert/strict';
import { briefParts } from './brief.ts';

test('the three parts come from their headings, and a heading inside a code block does not start a part', () => {
  const md = '# 題\n\n## 困りごと\n同じことを 2 回聞かれる。\n\n## やること\n- 直す\n```\n## 終わりの条件\n```\n\n## やってよいこと\n- 上のファイル\n\n## 終わりの条件\n- npm test が通る。\n';
  assert.deepEqual(briefParts(md), { problem: '同じことを 2 回聞かれる。', todo: '- 直す\n```\n## 終わりの条件\n```', done: '- npm test が通る。' });
});

test('an old brief without the headings gives nothing rather than guessing', () => {
  assert.deepEqual(briefParts('# 古い依頼\n本文だけ'), { problem: null, todo: null, done: null });
});
