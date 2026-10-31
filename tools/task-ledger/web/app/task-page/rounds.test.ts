import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Event, Span } from '../../../ledger.ts';
import { leftoversIn, roundsFor } from './rounds.ts';

let clock = 0;
const ev = (from: Event['from_status'], to: Event['to_status'], note: string | null = null): Event =>
  ({ task_id: 't', at: new Date(Date.UTC(2026, 9, 31, 0, clock++)).toISOString(), from_status: from, to_status: to, note, kind: null });
const span = (at: string, role: string, agent: string, model: string, effort: string): Span =>
  ({ task_id: 't', attempt: 1, name: role, start: at, end: at, ok: true, attributes: { 'model.role': role, 'model.agent': agent, 'model.model': model, 'model.effort': effort } });

test('a send-back ends the round with the reason written on the next start', () => {
  clock = 0;
  const events = [
    ev(null, '待ち'), ev('待ち', '判断待ち', '先に済むはずの仕事が止まった'), ev('判断待ち', '待ち', 'Claude: 前の仕事が済んだので再開'),
    ev('待ち', '走行中', 'ハーネスが出した'), ev('走行中', '確かめ中', '作業役が終わった'), ev('確かめ中', 'レビュー中', '確かめが通った'),
    ev('レビュー中', '走行中', '差し戻し: どうでもいいの重みが残る'), ev('走行中', '確かめ中'), ev('確かめ中', 'レビュー中'),
    ev('レビュー中', '取り込み中', 'レビュー通過: 確認済み。残りにした指摘: ["写真が混ざっている"]'),
    ev('取り込み中', '済', '取り込んだ。本番に出した。残りにした指摘: ["写真が混ざっている","文言が違う"]'),
  ];
  const spans = [span(events[3]!.at, '作業役', 'Pi', 'gpt-6-luna', 'high'), span(events[5]!.at, 'レビュー役', 'Claude', 'opus', '既定'), span(events[7]!.at, '作業役', 'Claude', 'sonnet', 'high')];
  const rounds = roundsFor(events, spans);
  assert.equal(rounds.length, 2);
  assert.deepEqual([rounds[0]!.steps, rounds[0]!.end, rounds[0]!.reason], [['作る', '確かめ', 'レビュー'], '差し戻し', 'どうでもいいの重みが残る']);
  assert.deepEqual([rounds[0]!.worker?.model, rounds[0]!.reviewer?.model], ['gpt-6-luna', 'opus']);
  assert.deepEqual([rounds[1]!.steps, rounds[1]!.end, rounds[1]!.deployed, rounds[1]!.leftovers], [['直す', '確かめ', 'レビュー', '取り込み', '本番'], '取り込んだ', true, ['写真が混ざっている', '文言が違う']]);
  assert.deepEqual([rounds[1]!.worker?.agent, rounds[1]!.worker?.model], ['Claude', 'sonnet']);
});

test('a stop for a decision keeps the reason and the answer that let it go on', () => {
  clock = 0;
  const events = [
    ev('待ち', '走行中'), ev('走行中', '確かめ中'), ev('確かめ中', 'レビュー中'),
    ev('レビュー中', '判断待ち', '3 回やって通らなかった'), ev('判断待ち', '待ち', '答え: Claude: Sonnet で作り直す'),
    ev('待ち', '走行中', 'ハーネスが出した'),
  ];
  const rounds = roundsFor(events, []);
  assert.deepEqual([rounds[0]!.end, rounds[0]!.stops], ['判断待ち', [{ reason: '3 回やって通らなかった', answer: 'Claude: Sonnet で作り直す' }]]);
  assert.deepEqual([rounds[1]!.end, rounds[1]!.steps, rounds[1]!.worker], ['進行中', ['直す'], null]);
});

test('an answer that sends the task straight to merging leaves the round open until it is merged', () => {
  clock = 0;
  const events = [ev('待ち', '走行中'), ev('走行中', '確かめ中'), ev('確かめ中', 'レビュー中'), ev('レビュー中', '取り込み中'), ev('取り込み中', '判断待ち', '本体に入れられなかった'), ev('判断待ち', '取り込み中', '答え: Claude: 写真を戻した'), ev('取り込み中', '済', '取り込んだ')];
  const [round] = roundsFor(events, []);
  assert.deepEqual([round!.end, round!.stops, round!.deployed, round!.steps.at(-1)], ['取り込んだ', [{ reason: '本体に入れられなかった', answer: 'Claude: 写真を戻した' }], false, '済']);
});

test('leftovers are read only from a well-formed list', () => {
  assert.deepEqual(leftoversIn('取り込んだ。残りにした指摘: ["a","b"]'), ['a', 'b']);
  assert.deepEqual(leftoversIn('取り込んだ。残りにした指摘: ["a", 途中で切れた'), []);
  assert.deepEqual(leftoversIn(null), []);
});
