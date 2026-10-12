import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverPath = process.argv[2]
  ? resolve(process.argv[2])
  : fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
const client = new Client({ name: 'gateway-ops-probe', version: '0.1.0' });

try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map(({ name }) => name);
  assert.deepEqual([...tools].sort(), [
    'get_my_profile',
    'connect_gateway_account',
    'disconnect_gateway_account',
    'register_gateway_account',
    'change_gateway_password',
    'assign_gateway_organization',
    'start_gateway_password_reset',
    'verify_gateway_password_reset_code',
    'finish_gateway_password_reset',
    'send_gateway_account_verification_code',
    'verify_gateway_account_code',
    'list_my_applications',
    'get_application',
    'get_whatsapp_health',
    'get_whatsapp_business_profile',
    'check_whatsapp_account_readiness',
    'get_whatsapp_username_suggestions',
    'get_instagram_health',
    'get_instagram_profile',
    'list_my_organizations',
    'get_organization_contact',
    'get_allowed_origins',
    'get_wallet_balance',
    'get_billing_account',
    'get_payment_method_metadata',
    'list_invoices',
    'list_organization_secrets_metadata',
    'list_whatsapp_templates',
    'get_whatsapp_template',
    'get_template_health_summary',
    'upload_whatsapp_template_media',
    'get_insights_report',
    'list_insights_views',
    'get_insights_view',
    'compare_insights_periods',
    'get_insights_export_rows',
    'save_insights_csv',
    'validate_wallet_coupon',
    'list_template_library',
    'get_template_library_filters',
    'get_template_library_detail',
    'get_webhook_status',
    'set_webhook_header',
    'list_api_key_metadata',
    'list_sandbox_test_numbers',
    'prepare_sandbox_text',
    'add_sandbox_test_number',
    'send_sandbox_text',
    'prepare_sandbox_template',
    'send_sandbox_template',
    'rename_application',
    'update_application_contact',
    'set_whatsapp_username',
    'update_test_number',
    'delete_test_number',
    'add_allowed_origin',
    'delete_allowed_origin',
    'delete_whatsapp_template',
    'create_whatsapp_template',
    'update_whatsapp_template',
    'upsert_webhook',
    'delete_webhook',
    'test_webhook',
    'test_sandbox_webhook',
    'update_whatsapp_business_profile',
    'upsert_billing_account',
    'delete_api_key',
    'create_api_key',
    'create_organization_secret',
  ].sort());
  const views = await client.callTool({ name: 'list_insights_views', arguments: {} });
  assert.equal(views.isError, undefined);
  assert.equal(views.structuredContent.views.some(({ id }) => id === 'messagesBreakup'), true);
  const unavailable = await client.callTool({ name: 'get_insights_view', arguments: { view: 'appsOverview' } });
  assert.equal(unavailable.isError, undefined);
  assert.equal(unavailable.structuredContent.status, 'unavailable');
  assert.match(unavailable.content[0].text, /mock\/Coming Soon/);
  const comparisonUnavailable = await client.callTool({ name: 'compare_insights_periods', arguments: {
    view: 'appsOverview', periodA: { startDate: '2026-10-01', endDate: '2026-10-02' },
    periodB: { startDate: '2026-10-03', endDate: '2026-10-04' },
  } });
  assert.equal(comparisonUnavailable.structuredContent.status, 'unavailable');
  console.log(JSON.stringify({
    tools,
    notice: 'Tool discovery and offline widget checks only. No Gateway request was sent.',
  }, null, 2));
} finally {
  await client.close();
}
