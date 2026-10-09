import { writeFile } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { selectGatewayCsvDestination } from './native-file.mjs';

export const INSIGHTS_CSV_FIELDS = [
  'date', 'templateSentMessages', 'sessionSentMessages', 'sessionReceivedMessages',
  'marketingTemplates', 'marketingTemplatesMmLite', 'utilityTemplates',
  'authenticationTemplates', 'marketingConversations', 'authenticationConversations',
  'utilityConversations', 'serviceConversations', 'totalFreeConversations',
  'totalPaidConversations',
];

export function buildInsightsCsv(rows) {
  if (!Array.isArray(rows)) throw new Error('Insights export rows are invalid');
  const lines = [INSIGHTS_CSV_FIELDS.join(',')];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
      throw new Error('Insights export contains an invalid date');
    }
    const values = INSIGHTS_CSV_FIELDS.map((field) => {
      const value = row[field];
      if (field === 'date') return value;
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Insights export contains an invalid ${field} value`);
      return String(value);
    });
    lines.push(values.join(','));
  }
  return `\uFEFF${lines.join('\n')}`;
}

export async function saveInsightsCsv(gateway, args, pickDestination = selectGatewayCsvDestination, write = writeFile) {
  const exportData = await gateway.getInsightsExport(args);
  const csv = buildInsightsCsv(exportData.rows);
  const destination = await pickDestination(`insights_${args.startDate}_${args.endDate}.csv`);
  if (!destination) return { status: 'cancelled', saved: false };
  if (typeof destination !== 'string' || !isAbsolute(destination) || !destination.endsWith('.csv')) throw new Error('Select an absolute CSV destination');
  try {
    // Even if the native dialog has its own replacement prompt, never replace
    // an existing file implicitly. The developer can choose a new name.
    await write(destination, csv, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('That CSV file already exists; choose a new name to avoid overwriting it');
    throw new Error('Could not save the insights CSV file');
  }
  return { status: 'saved', saved: true, fileName: basename(destination), rowCount: exportData.rowCount };
}
