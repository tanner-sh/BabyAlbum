import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeAge } from '../src/age.ts';

const label = (birthday: string, takenAt: string) => computeAge(birthday, takenAt).label;

test('出生前后与新生儿期', () => {
  assert.equal(label('2024-03-15', '2024-03-14T23:59:00.000Z'), '出生前');
  assert.equal(label('2024-03-15', '2024-03-15T08:00:00.000Z'), '出生当天');
  assert.equal(label('2024-03-15', '2024-03-20T08:00:00.000Z'), '出生第 5 天');
  assert.equal(computeAge('2024-03-15', '2024-04-14').groupLabel, '新生儿（0–1 个月）');
});

test('月龄与岁数', () => {
  assert.equal(label('2024-03-15', '2024-04-15'), '1 个月');
  assert.equal(label('2024-03-15', '2024-06-27'), '3 个月 12 天');
  assert.equal(label('2024-03-15', '2025-03-15'), '1 岁');
  assert.equal(label('2024-03-15', '2025-05-20'), '1 岁 2 个月');
  assert.equal(computeAge('2024-03-15', '2025-05-20').groupLabel, '1 岁 2 个月');
});

test('月末生日', () => {
  // 1 月 31 日出生：2 月 29 日（闰年）满 1 个月，3 月 1 日是 1 个月 1 天
  assert.equal(label('2024-01-31', '2024-02-28'), '出生第 28 天');
  assert.equal(label('2024-01-31', '2024-02-29'), '1 个月');
  assert.equal(label('2024-01-31', '2024-03-01'), '1 个月 1 天');
  assert.equal(label('2024-01-31', '2024-03-31'), '2 个月');
});

test('只看日期部分，忽略时区后缀', () => {
  // Immich 的 localDateTime 是本地时间，只是带了 Z 后缀
  assert.equal(label('2024-03-15', '2024-04-14T23:30:00.000Z'), '出生第 30 天');
});

test('月龄日期与日期加减', async () => {
  const { monthDate, shiftDays, currentMonths } = await import('../src/age.ts');
  assert.equal(monthDate('2024-01-31', 1), '2024-02-29');
  assert.equal(monthDate('2024-03-15', 12), '2025-03-15');
  assert.equal(shiftDays('2024-03-01', -1), '2024-02-29');
  assert.equal(shiftDays('2024-12-31', 1), '2025-01-01');
  assert.equal(currentMonths('2024-03-15', '2025-03-14'), 11);
});
