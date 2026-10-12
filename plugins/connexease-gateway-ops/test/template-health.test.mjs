import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayApiClient } from '../src/gateway-api.mjs';
import { getTemplateHealthSummary } from '../src/template-health.mjs';

const appId = 'example-app';
const app = { id: 'app-1', appId, displayName: 'Example', status: 'ACTIVATED' };

function clientFor(pages) {
  const requested = [];
  const client = new GatewayApiClient({
    accessTokenProvider: { getAccessToken: async () => 'test-token' },
    baseUrl: 'https://gateway.example.test/api/v1',
    fetchImpl: async (url, options) => {
      assert.equal(options.method, 'GET');
      if (url.pathname === '/api/v1/applications') return new Response(JSON.stringify({ isSuccess: true, data: [app] }));
      assert.equal(url.pathname, `/api/v1/channels/whatsapp/applications/${appId}/templates`);
      assert.equal(url.searchParams.get('pageSize'), '100');
      const pageNumber = Number(url.searchParams.get('pageNumber'));
      requested.push(pageNumber);
      const page = pages[pageNumber - 1];
      if (!page) throw new Error(`unexpected page ${pageNumber}`);
      return new Response(JSON.stringify({ isSuccess: true, data: page.items, pagingMetadata: page.pagingMetadata }));
    },
  });
  return { client, requested };
}

test('template health reads every page and summarizes filters, quality, rejection and category changes', async () => {
  const { client, requested } = clientFor([
    { items: [
      { sourceId: 'a', name: 'Approved', language: 'en_US', category: 'UTILITY', status: 'APPROVED', qualityScore: 'GREEN' },
      { sourceId: 'b', name: 'Rejected', language: 'tr_TR', category: 'MARKETING', status: 'REJECTED', qualityScore: 'RED', rejectedReason: 'Policy', previousCategory: 'UTILITY', correctCategory: 'MARKETING' },
    ], pagingMetadata: { hasNext: true } },
    { items: [
      { sourceId: 'c', name: 'Warning', language: 'tr_TR', category: 'MARKETING', status: 'PAUSED', qualityScore: 'YELLOW' },
    ], pagingMetadata: { hasNext: false } },
  ]);
  const result = await getTemplateHealthSummary(client, { appId });
  assert.deepEqual(requested, [1, 2]);
  assert.equal(result.scannedCount, 3);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.statusCounts, { APPROVED: 1, PENDING: 0, REJECTED: 1, PAUSED: 1, DISABLED: 0 });
  assert.deepEqual(result.qualityDistribution, { GREEN: 1, RED: 1, YELLOW: 1 });
  assert.equal(result.qualityNote, null);
  assert.deepEqual(result.lowQualityTemplates.map(({ sourceId }) => sourceId), ['b', 'c']);
  assert.equal(result.rejectedTemplates[0].rejectedReason, 'Policy');
  assert.deepEqual(result.categoryChanges, [
    { sourceId: 'b', name: 'Rejected', language: 'tr_TR', change: 'applied', from: 'UTILITY', to: 'MARKETING' },
  ]);
  assert.deepEqual(result.categoryDistribution, { UTILITY: 1, MARKETING: 2 });
  assert.deepEqual(result.languageDistribution, { en_US: 1, tr_TR: 2 });
  assert.match(result.note, /gönderilme, okunma veya tıklanma metriklerini içermez/);
  const filtered = await getTemplateHealthSummary(client, { appId, status: 'REJECTED', category: 'MARKETING' });
  assert.equal(filtered.scannedCount, 3);
  assert.equal(filtered.matchedCount, 1);
  assert.equal(filtered.statusCounts.REJECTED, 1);
  assert.equal(filtered.statusCounts.APPROVED, 0);
});

test('category changes compare previousCategory and correctCategory with the current category separately', async () => {
  const template = (sourceId, category, extra) => ({ sourceId, name: sourceId, language: 'en_US', category, status: 'APPROVED', ...extra });
  const { client } = clientFor([{ items: [
    template('applied', 'MARKETING', { previousCategory: 'UTILITY', correctCategory: null }),
    template('pending', 'UTILITY', { previousCategory: null, correctCategory: 'MARKETING' }),
    template('both', 'MARKETING', { previousCategory: 'UTILITY', correctCategory: 'AUTHENTICATION' }),
    template('settled', 'MARKETING', { previousCategory: 'MARKETING', correctCategory: 'MARKETING' }),
    template('untouched', 'UTILITY', { previousCategory: null, correctCategory: null }),
  ], pagingMetadata: { hasNext: false } }]);
  const result = await getTemplateHealthSummary(client, { appId });
  assert.deepEqual(result.categoryChanges.map(({ sourceId, change, from, to }) => [sourceId, change, from, to]), [
    ['applied', 'applied', 'UTILITY', 'MARKETING'],
    ['pending', 'pending', 'UTILITY', 'MARKETING'],
    ['both', 'applied', 'UTILITY', 'MARKETING'],
    ['both', 'pending', 'MARKETING', 'AUTHENTICATION'],
  ]);
});

test('empty template list returns a useful zero summary', async () => {
  const { client } = clientFor([{ items: [], pagingMetadata: { hasNext: false } }]);
  const result = await getTemplateHealthSummary(client, { appId });
  assert.equal(result.scannedCount, 0);
  assert.equal(result.matchedCount, 0);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.qualityDistribution, {});
  assert.deepEqual(result.rejectedTemplates, []);
  assert.deepEqual(result.categoryChanges, []);
  assert.equal(result.qualityNote, null);
});

test('missing list quality scores are flagged instead of reading as no low-quality templates', async () => {
  const { client } = clientFor([{ items: [
    { sourceId: 'a', name: 'A', language: 'en_US', category: 'UTILITY', status: 'APPROVED', qualityScore: null },
    { sourceId: 'b', name: 'B', language: 'en_US', category: 'MARKETING', status: 'APPROVED' },
  ], pagingMetadata: { hasNext: false } }]);
  const result = await getTemplateHealthSummary(client, { appId });
  assert.deepEqual(result.qualityDistribution, { UNKNOWN: 2 });
  assert.deepEqual(result.lowQualityTemplates, []);
  assert.match(result.qualityNote, /Kalite skoru Gateway liste API'sinden gelmiyor/);
});

test('1000-template safety cap marks a longer list as truncated', async () => {
  const pages = Array.from({ length: 10 }, (_, index) => ({
    items: Array.from({ length: 100 }, (_, item) => ({ sourceId: `t-${index}-${item}`, name: 'Example', language: 'en_US', category: 'UTILITY', status: 'APPROVED' })),
    pagingMetadata: { hasNext: true },
  }));
  const { client, requested } = clientFor(pages);
  const result = await getTemplateHealthSummary(client, { appId });
  assert.equal(result.scannedCount, 1000);
  assert.equal(result.truncated, true);
  assert.deepEqual(requested, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('broken pagination fails instead of presenting a partial summary', async () => {
  const { client } = clientFor([
    { items: [{ sourceId: 'a', name: 'A', language: 'en_US', category: 'UTILITY', status: 'APPROVED' }], pagingMetadata: { hasNext: true } },
    { items: [], pagingMetadata: { hasNext: false } },
  ]);
  await assert.rejects(getTemplateHealthSummary(client, { appId }), /pagination ended unexpectedly/);
});
