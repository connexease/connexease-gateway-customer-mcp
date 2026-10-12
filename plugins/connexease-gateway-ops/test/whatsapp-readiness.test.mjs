import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayApiClient } from '../src/gateway-api.mjs';
import { checkWhatsappAccountReadiness } from '../src/whatsapp-readiness.mjs';

const appId = 'example-app';
const app = { id: 'app-1', appId, displayName: 'Example', status: 'ACTIVATED' };
const metric = (value, severity = 'success') => ({ value, display: value, severity });
const healthy = {
  accountStatus: metric('APPROVED'), messagingLimit: { tier: 'TIER_10K', display: '10K' },
  nameStatus: metric('APPROVED'), phoneQuality: metric('GREEN'), codeVerificationStatus: metric('VERIFIED'),
};
const completeProfile = { websites: ['https://example.test'], email: 'dev@example.test', address: 'Example', description: 'Example business' };

function clientFor({ review = 'APPROVED', health = healthy, profile = completeProfile, fail = null } = {}) {
  const calls = [];
  const client = new GatewayApiClient({
    accessTokenProvider: { getAccessToken: async () => 'test-token' },
    baseUrl: 'https://gateway.example.test/api/v1',
    fetchImpl: async (url, options) => {
      assert.equal(options.method, 'GET');
      calls.push(url.pathname);
      if (url.pathname === '/api/v1/applications') return new Response(JSON.stringify({ isSuccess: true, data: [app] }));
      if (url.pathname === fail) return new Response(null, { status: 503 });
      let data;
      if (url.pathname === `/api/v1/applications/${appId}`) data = { ...app, channel: { platform: 'whatsapp', accountReviewStatus: review } };
      else if (url.pathname.endsWith('/health')) data = health;
      else if (url.pathname.endsWith('/profile')) data = profile;
      else throw new Error(`unexpected GET ${url.pathname}`);
      return new Response(JSON.stringify({ isSuccess: true, data }));
    },
  });
  return { client, calls };
}

test('readiness uses three scoped HTTP reads and labels all healthy checks without claiming verification', async () => {
  const { client, calls } = clientFor();
  const result = await checkWhatsappAccountReadiness(client, appId);
  assert.equal(result.overallStatus, 'ok');
  assert.deepEqual(Object.values(result.checks).map(({ status }) => status), Array(7).fill('ok'));
  assert.equal(result.businessVerification.status, 'unknown');
  assert.match(result.businessVerification.note, /kesin olarak okunamıyor/);
  assert.match(result.businessVerification.securityCenterUrl, /^https:\/\/business\.facebook\.com\//);
  assert.equal(calls.filter((path) => path.endsWith('/health')).length, 1);
  assert.equal(calls.filter((path) => path.endsWith('/profile')).length, 1);
});

test('250 messaging limit is explicitly a warning and only an inference about verification', async () => {
  const { client } = clientFor({ health: { ...healthy, messagingLimit: { tier: 'TIER_250', display: '250' } } });
  const result = await checkWhatsappAccountReadiness(client, appId);
  assert.equal(result.overallStatus, 'warning');
  assert.equal(result.checks.messagingLimit.status, 'warning');
  assert.match(result.checks.messagingLimit.inference, /olabilir/);
  assert.equal(result.businessVerification.status, 'unknown');
  assert.ok(result.nextSteps.some((step) => step.includes('Security Center')));
});

test('incomplete profile and declined name are separately reported', async () => {
  const { client } = clientFor({
    health: { ...healthy, nameStatus: metric('DECLINED', 'danger') },
    profile: { websites: [], email: null, address: 'Example', description: '' },
  });
  const result = await checkWhatsappAccountReadiness(client, appId);
  assert.equal(result.overallStatus, 'action_required');
  assert.equal(result.checks.nameStatus.status, 'action_required');
  assert.equal(result.checks.businessProfile.status, 'warning');
  assert.deepEqual(result.checks.businessProfile.missing, ['websites', 'email', 'description']);
});

test('one unavailable subcall becomes unknown without discarding healthy checks', async () => {
  const { client } = clientFor({ fail: `/api/v1/channels/whatsapp/applications/${appId}/health` });
  const result = await checkWhatsappAccountReadiness(client, appId);
  assert.equal(result.checks.accountReviewStatus.status, 'ok');
  assert.equal(result.checks.businessProfile.status, 'ok');
  assert.equal(result.checks.accountStatus.status, 'unknown');
  assert.equal(result.overallStatus, 'unknown');
  assert.ok(result.nextSteps.some((step) => step.includes('Okunamayan')));
});
