import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildInsightsCsv, INSIGHTS_CSV_FIELDS, saveInsightsCsv } from '../src/insights-csv.mjs';

const oneRow = Object.fromEntries(INSIGHTS_CSV_FIELDS.map((field) => [field, field === 'date' ? '2026-10-01' : 1]));

test('insights CSV uses the panel field order, UTF-8 BOM and numeric cells', () => {
  const csv = buildInsightsCsv([oneRow]);
  assert.equal(csv, `\uFEFF${INSIGHTS_CSV_FIELDS.join(',')}\n2026-10-01,${Array(13).fill('1').join(',')}`);
  assert.throws(() => buildInsightsCsv([{ ...oneRow, totalPaidConversations: '=HYPERLINK("evil")' }]), /invalid totalPaidConversations/);
});

test('native CSV save never takes a model-supplied path or overwrites a file', async () => {
  const calls = [];
  const gateway = { getInsightsExport: async (args) => { calls.push(args); return { rows: [oneRow], rowCount: 1 }; } };
  const args = { startDate: '2026-10-01', endDate: '2026-10-07' };
  const chosenPath = join(tmpdir(), 'insights_2026-10-01_2026-10-07.csv');
  const saved = await saveInsightsCsv(gateway, args, async (filename) => {
    assert.equal(filename, 'insights_2026-10-01_2026-10-07.csv');
    return chosenPath;
  }, async (path, content, options) => {
    assert.equal(path, chosenPath);
    assert.equal(content, buildInsightsCsv([oneRow]));
    assert.equal(options.flag, 'wx');
  });
  assert.deepEqual(saved, { status: 'saved', saved: true, fileName: 'insights_2026-10-01_2026-10-07.csv', rowCount: 1 });
  assert.deepEqual(calls, [args]);
  const cancelled = await saveInsightsCsv(gateway, args, async () => null, async () => { throw new Error('should not write'); });
  assert.deepEqual(cancelled, { status: 'cancelled', saved: false });
});
