import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayApiClient } from '../src/gateway-api.mjs';

const app = { id: '00000000-0000-4000-8000-000000000002', appId: 'example-app', displayName: 'Example App', status: 'ACTIVATED' };

function response(data) {
  return new Response(JSON.stringify({ isSuccess: true, data }), { status: 200 });
}

function fixture(byPath, calls) {
  return new GatewayApiClient({
    accessTokenProvider: { getAccessToken: async () => 'test-token' },
    baseUrl: 'https://gateway.example.test/api/v1',
    fetchImpl: async (url, options) => {
      assert.equal(options.method, 'GET');
      calls.push(url.pathname);
      if (url.pathname === '/api/v1/applications') return response([app]);
      if (!(url.pathname in byPath)) throw new Error(`unexpected GET ${url.pathname}`);
      return response(byPath[url.pathname]);
    },
  });
}

test('reads application health and profiles through the panel routes after ownership checks', async () => {
  const calls = [];
  const client = fixture({
    '/api/v1/channels/whatsapp/applications/example-app/health': { state: 'ok' },
    '/api/v1/channels/whatsapp/applications/example-app/profile': { about: 'Example' },
    '/api/v1/channels/instagram/applications/example-app/health': { state: 'ok' },
    '/api/v1/channels/instagram/applications/example-app/profile': { username: 'example' },
  }, calls);
  assert.deepEqual(await client.getWhatsappHealth(app.appId), { state: 'ok' });
  assert.deepEqual(await client.getWhatsappBusinessProfile(app.appId), { configured: true, profile: { about: 'Example' } });
  assert.deepEqual(await client.getInstagramHealth(app.appId), { state: 'ok' });
  assert.deepEqual(await client.getInstagramProfile(app.appId), { configured: true, profile: { username: 'example' } });
  assert.equal(calls.length, 8);
  await assert.rejects(client.getWhatsappHealth('foreign-app'), /Application not found/);
  assert.equal(calls.at(-1), '/api/v1/applications');
});

test('application and template mappers retain non-secret review and category fields with null fallbacks', async () => {
  const client = new GatewayApiClient({
    accessTokenProvider: { getAccessToken: async () => 'test-token' },
    baseUrl: 'https://gateway.example.test/api/v1',
    fetchImpl: async (url, options) => {
      assert.equal(options.method, 'GET');
      if (url.pathname === '/api/v1/applications') return response([app]);
      if (url.pathname === '/api/v1/applications/example-app') {
        return response({ ...app, channel: {
          platform: 'whatsapp', accountReviewStatus: 'APPROVED', currency: 'USD',
          timezone: { iana_id: 'Europe/Istanbul' }, businessUsernameStatus: 'RESERVED',
          accessToken: 'hidden',
        } });
      }
      if (url.pathname.endsWith('/templates')) {
        return response([{ sourceId: 'template-1', name: 'Welcome', language: 'en_US', category: 'UTILITY',
          status: 'APPROVED', correctCategory: 'UTILITY', previousCategory: 'MARKETING', secret: 'hidden' },
        { sourceId: 'template-2', name: 'Empty', language: 'en_US', category: 'UTILITY', status: 'PENDING' }]);
      }
      if (url.pathname.endsWith('/templates/template-1')) {
        return response({ sourceId: 'template-1', name: 'Welcome', language: 'en_US', category: 'UTILITY',
          status: 'APPROVED', correctCategory: 'UTILITY', previousCategory: 'MARKETING', secret: 'hidden' });
      }
      throw new Error(`unexpected GET ${url.pathname}`);
    },
  });
  const detail = await client.getApplication(app.appId);
  assert.equal(detail.channel.accountReviewStatus, 'APPROVED');
  assert.equal(detail.channel.currency, 'USD');
  assert.deepEqual(detail.channel.timezone, { iana_id: 'Europe/Istanbul' });
  assert.equal(detail.channel.businessUsernameStatus, 'RESERVED');
  assert.equal(detail.channel.accessToken, undefined);
  const templates = await client.listWhatsappTemplates(app.appId);
  assert.equal(templates.items[0].previousCategory, 'MARKETING');
  assert.equal(templates.items[0].correctCategory, 'UTILITY');
  assert.equal(templates.items[1].previousCategory, null);
  assert.equal(templates.items[1].correctCategory, null);
  const template = await client.getWhatsappTemplate(app.appId, 'template-1');
  assert.equal(template.correctCategory, 'UTILITY');
  assert.equal(template.previousCategory, 'MARKETING');
  assert.doesNotMatch(JSON.stringify({ detail, templates, template }), /hidden/);
});

test('missing application review fields and template detail categories are explicit nulls', async () => {
  const client = new GatewayApiClient({
    accessTokenProvider: { getAccessToken: async () => 'test-token' },
    baseUrl: 'https://gateway.example.test/api/v1',
    fetchImpl: async (url, options) => {
      assert.equal(options.method, 'GET');
      if (url.pathname === '/api/v1/applications') return response([app]);
      if (url.pathname === '/api/v1/applications/example-app') return response({ ...app, channel: { platform: 'whatsapp' } });
      if (url.pathname.endsWith('/templates/template-2')) {
        return response({ sourceId: 'template-2', name: 'Empty', language: 'en_US', category: 'UTILITY', status: 'PENDING' });
      }
      throw new Error(`unexpected GET ${url.pathname}`);
    },
  });
  const application = await client.getApplication(app.appId);
  for (const field of ['accountReviewStatus', 'currency', 'timezone', 'businessUsernameStatus']) {
    assert.equal(application.channel[field], null);
  }
  const template = await client.getWhatsappTemplate(app.appId, 'template-2');
  assert.equal(template.correctCategory, null);
  assert.equal(template.previousCategory, null);
});

test('reads organization, wallet and billing without exposing payment credentials', async () => {
  const calls = [];
  const client = fixture({
    '/api/v1/users/me/organizations': [{ id: 'org-1', name: 'Example' }],
    '/api/v1/organizations/contact': { firstName: 'Example' },
    '/api/v1/organizations/allowed-origins': { origins: ['https://example.test'] },
    '/api/v1/wallet/balance': { balance: '12.34', currency: 'USD', secret: 'not-returned' },
    '/api/v1/billing/account': { companyName: 'Example Ltd' },
    '/api/v1/billing/payment-method': {
      stripePaymentMethodId: 'pm_private', type: 'card', cardBrand: 'visa', cardLast4: '4242',
      cardExpirationMonth: 12, cardExpirationYear: 2030, isDefault: true, clientSecret: 'not-returned',
    },
    '/api/v1/billing/invoices': [{ stripeInvoiceId: 'in_1', amountPaid: 10 }],
  }, calls);
  assert.deepEqual(await client.listMyOrganizations(), [{ id: 'org-1', name: 'Example' }]);
  assert.deepEqual(await client.getOrganizationContact(), { configured: true, contact: { firstName: 'Example' } });
  assert.deepEqual(await client.getAllowedOrigins(), { origins: ['https://example.test'] });
  assert.deepEqual(await client.getWalletBalance(), { available: true, balance: '12.34', currency: 'USD' });
  assert.deepEqual(await client.getBillingAccount(), { configured: true, account: { companyName: 'Example Ltd' } });
  const paymentMethod = await client.getPaymentMethodMetadata();
  assert.equal(paymentMethod.cardLast4, '4242');
  assert.doesNotMatch(JSON.stringify(paymentMethod), /pm_private|not-returned/);
  assert.deepEqual(await client.listInvoices(), [{ stripeInvoiceId: 'in_1', amountPaid: 10 }]);
  assert.equal(calls.length, 7);
});

test('empty optional records are represented as MCP-safe objects', async () => {
  const calls = [];
  const client = fixture({
    '/api/v1/organizations/contact': null,
    '/api/v1/wallet/balance': null,
    '/api/v1/billing/account': null,
    '/api/v1/billing/payment-method': null,
  }, calls);
  assert.deepEqual(await client.getOrganizationContact(), { configured: false });
  assert.deepEqual(await client.getWalletBalance(), { available: false });
  assert.deepEqual(await client.getBillingAccount(), { configured: false });
  assert.deepEqual(await client.getPaymentMethodMetadata(), { configured: false });
});

test('organization secret list strips every key value', async () => {
  const calls = [];
  const client = fixture({
    '/api/v1/organization-secrets': [
      { id: 'secret-1', name: 'public', type: 'PUBLISHABLE', status: 'ACTIVE', key: 'pk_live_value' },
      { id: 'secret-2', name: 'private', type: 'SECRET', status: 'ACTIVE', key: 'sk_live_value' },
    ],
  }, calls);
  const entries = await client.listOrganizationSecretsMetadata();
  assert.equal(entries.length, 2);
  assert.doesNotMatch(JSON.stringify(entries), /pk_live_value|sk_live_value/);
});

test('insights report validates ownership and date filters and preserves pagination', async () => {
  const urls = [];
  const client = new GatewayApiClient({
    accessTokenProvider: { getAccessToken: async () => 'test-token' },
    baseUrl: 'https://gateway.example.test/api/v1',
    fetchImpl: async (url, options) => {
      assert.equal(options.method, 'GET');
      urls.push(url);
      if (url.pathname === '/api/v1/applications') return response([app]);
      if (url.pathname.endsWith('/messages/breakup')) {
        return new Response(JSON.stringify({ isSuccess: true, data: [{ sent: 1 }], pagingMetadata: { hasNext: true } }), { status: 200 });
      }
      throw new Error(`unexpected GET ${url.pathname}`);
    },
  });
  const report = await client.getInsightsReport({ report: 'messagesBreakup', appId: app.appId, startDate: '2026-10-01', endDate: '2026-10-06', granularity: 'daily', pageNumber: 2, pageSize: 5 });
  assert.deepEqual(report, { report: 'messagesBreakup', data: [{ sent: 1 }], pagingMetadata: { hasNext: true } });
  assert.equal(urls[1].searchParams.get('appId'), app.appId);
  assert.equal(urls[1].searchParams.get('pageNumber'), '2');
  assert.equal(urls[1].searchParams.get('pageSize'), '5');
  await assert.rejects(client.getInsightsReport({ report: 'summary', startDate: '2026-10-07', endDate: '2026-10-06' }), /startDate must not/);
  await assert.rejects(client.getInsightsReport({ report: 'summary', appId: 'foreign-app' }), /Application not found/);
  assert.equal(urls.at(-1).pathname, '/api/v1/applications');
});

test('template library reads are scoped and cursor-safe', async () => {
  const urls = [];
  const client = new GatewayApiClient({
    accessTokenProvider: { getAccessToken: async () => 'test-token' },
    baseUrl: 'https://gateway.example.test/api/v1',
    fetchImpl: async (url, options) => {
      assert.equal(options.method, 'GET');
      urls.push(url);
      if (url.pathname === '/api/v1/applications') return response([app]);
      if (url.pathname.endsWith('/template-library')) {
        return new Response(JSON.stringify({ isSuccess: true, data: [{ name: 'example' }], pagingMetadata: { nextCursor: 'next' } }), { status: 200 });
      }
      if (url.pathname.endsWith('/template-library/filters')) return response({ topics: ['orders'] });
      if (url.pathname.endsWith('/template-library/templates/example')) return response({ name: 'example', language: 'en_US' });
      throw new Error(`unexpected GET ${url.pathname}`);
    },
  });
  const filters = { category: 'UTILITY', language: 'en_US' };
  assert.deepEqual(await client.listTemplateLibrary(app.appId, { ...filters, after: 'cursor-token' }), {
    items: [{ name: 'example' }], pagingMetadata: { nextCursor: 'next' },
  });
  assert.equal(urls[1].searchParams.get('after'), 'cursor-token');
  assert.deepEqual(await client.getTemplateLibraryFilters(app.appId, filters), { topics: ['orders'] });
  assert.deepEqual(await client.getTemplateLibraryDetail(app.appId, 'example', 'en_US'), { name: 'example', language: 'en_US' });
  await assert.rejects(client.listTemplateLibrary(app.appId, { ...filters, after: 'a', before: 'b' }), /either after or before/);
});

test('username suggestions, full export rows and coupon validation are GET-only', async () => {
  const calls = [];
  const client = new GatewayApiClient({
    accessTokenProvider: { getAccessToken: async () => 'test-token' },
    baseUrl: 'https://gateway.example.test/api/v1',
    fetchImpl: async (url, options) => {
      assert.equal(options.method, 'GET');
      calls.push(url);
      if (url.pathname === '/api/v1/applications') return response([app]);
      if (url.pathname.endsWith('/username/suggestions')) return response({ suggestions: ['example_business'] });
      if (url.pathname.endsWith('/insights/export')) return response([{ date: '2026-10-01', templateSentMessages: 2 }]);
      if (url.pathname.endsWith('/wallet/coupon/validate')) return response({ couponCode: 'SAVE5', chargeAmountUsd: '5.00' });
      throw new Error(`unexpected GET ${url.pathname}`);
    },
  });
  assert.deepEqual(await client.getWhatsappUsernameSuggestions(app.appId), { suggestions: ['example_business'] });
  const exportRows = await client.getInsightsExport({ startDate: '2026-10-01', endDate: '2026-10-06', appId: app.appId });
  assert.equal(exportRows.rowCount, 1);
  assert.equal(exportRows.rows[0].templateSentMessages, 2);
  assert.deepEqual(await client.validateWalletCoupon({ amountUsd: '10.00', couponCode: 'SAVE5' }), { couponCode: 'SAVE5', chargeAmountUsd: '5.00' });
  assert.equal(calls.at(-1).searchParams.get('couponCode'), 'SAVE5');
  await assert.rejects(client.validateWalletCoupon({ amountUsd: '-1', couponCode: 'SAVE5' }), /positive amount/);
});
