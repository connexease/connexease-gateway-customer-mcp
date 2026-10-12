import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { GatewayApiClient } from './gateway-api.mjs';
import { saveInsightsCsv } from './insights-csv.mjs';
import { compareInsightsPeriods } from './insights-compare.mjs';
import { getInsightsView, INSIGHT_VIEWS, listInsightsViews } from './insights-view.mjs';
import { confirmGatewayAction, showGatewaySecret } from './native-confirm.mjs';
import { selectGatewayUploadFile } from './native-file.mjs';
import { NativeSession, promptForGatewayCredentials, promptForGatewayOtp, promptForGatewayRegistration, promptForNewPassword, promptForPasswordChange, promptForWebhookHeaderValue } from './native-session.mjs';
import { createApiKey, createOrganizationSecret, performPanelAction } from './panel-workflow.mjs';
import { addSandboxTestNumber, sendSandboxTemplate, sendSandboxText } from './sandbox-workflow.mjs';
import { getTemplateHealthSummary } from './template-health.mjs';
import { toolResult } from './tool-result.mjs';
import { checkWhatsappAccountReadiness } from './whatsapp-readiness.mjs';

const supportsNativeAccount = process.platform === 'darwin' || process.platform === 'win32';
const accessTokenProvider = supportsNativeAccount
  ? new NativeSession()
  : { getAccessToken: async () => { throw new Error('Local account connection requires macOS or Windows'); } };
const gateway = new GatewayApiClient({ accessTokenProvider });
const server = new McpServer({ name: 'connexease-gateway-ops', version: '0.13.0' });
let signInInProgress = false;
let accountWriteInProgress = false;

const templateParametersSchema = z.object({
  headerText: z.array(z.string().min(1)).optional(),
  headerMedia: z.object({
    type: z.enum(['IMAGE', 'VIDEO', 'DOCUMENT']),
    link: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    filename: z.string().min(1).optional(),
  }).strict().optional(),
  body: z.array(z.string().min(1)).optional(),
  buttons: z.array(z.object({
    index: z.number().int().min(0),
    subType: z.enum(['URL', 'COPY_CODE', 'QUICK_REPLY']),
    value: z.string().min(1),
  }).strict()).optional(),
}).strict();

const templateHeaderSchema = z.object({
  format: z.enum(['NONE', 'TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION', 'PRODUCT']).optional(),
  text: z.string().nullable().optional(),
  examples: z.union([z.string(), z.array(z.string())]).nullable().optional(),
}).strict();

const templateBodySchema = z.object({
  text: z.string().nullable().optional(),
  examples: z.array(z.string()).nullable().optional(),
  addSecurityRecommendation: z.boolean().nullable().optional(),
}).strict();

const templateFooterSchema = z.object({
  text: z.string().nullable().optional(),
  codeExpirationMinutes: z.number().int().min(1).max(90).nullable().optional(),
}).strict();

const templateButtonSchema = z.object({
  type: z.enum(['QUICK_REPLY', 'URL', 'PHONE_NUMBER', 'COPY_CODE', 'OTP', 'FLOW', 'REQUEST_CONTACT_INFO', 'SPM', 'MPM']),
  text: z.string().nullable().optional(), url: z.string().nullable().optional(), phoneNumber: z.string().nullable().optional(),
  example: z.array(z.string()).nullable().optional(), otpType: z.enum(['COPY_CODE', 'ONE_TAP', 'ZERO_TAP']).nullable().optional(),
  autofillText: z.string().nullable().optional(), packageName: z.string().nullable().optional(), signatureHash: z.string().nullable().optional(),
  zeroTapTermsAccepted: z.boolean().nullable().optional(), flowId: z.string().nullable().optional(),
  flowAction: z.enum(['navigate', 'data_exchange']).nullable().optional(), navigateScreen: z.string().nullable().optional(),
}).strict();

const limitedTimeOfferSchema = z.object({ text: z.string().min(1).max(16), hasExpiration: z.boolean() }).strict();

const templateContentSchema = z.object({
  header: templateHeaderSchema.nullable().optional(),
  body: templateBodySchema,
  footer: templateFooterSchema.nullable().optional(),
  buttons: z.array(templateButtonSchema).nullable().optional(),
  limitedTimeOffer: limitedTimeOfferSchema.nullable().optional(),
}).strict();

const createTemplateSchema = templateContentSchema.extend({
  name: z.string().min(1).max(100),
  language: z.string().min(2).max(20),
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']),
  allowCategoryChange: z.boolean().nullable().optional(),
  messageSendTtlSeconds: z.number().int().min(1).nullable().optional(),
  carousel: z.array(z.object({ header: templateHeaderSchema, body: templateBodySchema, buttons: z.array(templateButtonSchema) }).strict()).nullable().optional(),
}).strict();

async function oneAccountWrite(operation) {
  if (accountWriteInProgress) throw new Error('Another Gateway account write is already in progress');
  accountWriteInProgress = true;
  try {
    return await operation();
  } finally {
    accountWriteInProgress = false;
  }
}

function guarded(operation) {
  return async (args) => {
    try {
      return toolResult(await operation(args));
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : 'Request failed' }],
      };
    }
  };
}

function guardedTerminal(operation) {
  return async (args) => {
    try {
      const value = await operation(args);
      return { content: [{ type: 'text', text: value.terminalDisplay }], structuredContent: value };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Request failed' }] };
    }
  };
}

server.registerTool('get_my_profile', {
  description: 'Read the profile of the currently signed-in Connexease Gateway user.',
  annotations: { readOnlyHint: true },
}, guarded(() => gateway.getMyProfile()));

server.registerTool('connect_gateway_account', {
  description: 'Open native macOS or Windows email/password dialogs to sign in to a Gateway account chosen by the user. Do not compare its email with a computer or repository identity. Never ask for credentials in chat or tool arguments. Only call after the user explicitly requests or accepts account connection.',
  annotations: { readOnlyHint: false, destructiveHint: false },
}, guarded(async () => {
  if (!supportsNativeAccount) throw new Error('In-session sign-in requires macOS or Windows');
  if (signInInProgress) throw new Error('Gateway sign-in is already in progress');
  signInInProgress = true;
  try {
    const credentials = await promptForGatewayCredentials();
    const profile = await accessTokenProvider.connectWithCredentials(credentials);
    return {
      status: 'connected',
      id: profile.id,
      email: profile.email,
      sessionPersistence: profile.sessionPersistence,
      ...(!['keychain', 'windows_dpapi'].includes(profile.sessionPersistence)
        ? { warning: profile.sessionPersistence === 'memory_only_stale_secure_store_possible'
          ? 'Secure session storage and old-token cleanup failed. This Gateway session works only in memory; an older account may return after restart. Clear the old Connexease Gateway item from the local OS secure store before restarting.'
          : 'Secure session storage failed. This Gateway session works only while this AI client session remains open.' }
        : {}),
    };
  } finally {
    signInInProgress = false;
  }
}));

server.registerTool('disconnect_gateway_account', {
  description: 'Sign out of the current Gateway account and clear its local secure session. Requires explicit user request and native confirmation. If local cleanup or server revocation fails, reports that separately.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
}, guarded(() => oneAccountWrite(async () => {
  if (!supportsNativeAccount) throw new Error('Local account disconnection requires macOS or Windows');
  const approved = await confirmGatewayAction({ kind: 'panel_action', preview: { action: 'disconnect_gateway_account', details: { scope: 'current Gateway session and local secure-store item' } } });
  if (!approved) return { status: 'cancelled', disconnected: false };
  return accessTokenProvider.disconnect();
})));

server.registerTool('register_gateway_account', {
  description: 'Create a new Gateway account only after explicit user request. Collect name, email and password in native desktop dialogs, then require a separate native creation confirmation. Credentials never enter AI tool arguments or results.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
}, guarded(() => oneAccountWrite(async () => {
  if (!supportsNativeAccount) throw new Error('Native registration requires macOS or Windows');
  if (signInInProgress) throw new Error('Gateway sign-in or registration is already in progress');
  signInInProgress = true;
  try {
    const registration = await promptForGatewayRegistration();
    const approved = await confirmGatewayAction({ kind: 'panel_action', preview: {
      action: 'register_gateway_account', details: { firstName: registration.firstName, lastName: registration.lastName, email: registration.email, password: 'entered locally and hidden' },
    } });
    if (!approved) return { status: 'cancelled', accountCreated: false };
    const profile = await accessTokenProvider.registerWithCredentials(registration);
    return { status: 'registered', id: profile.id, email: profile.email, sessionPersistence: profile.sessionPersistence };
  } finally {
    signInInProgress = false;
  }
})));

server.registerTool('change_gateway_password', {
  description: 'Change the signed-in Gateway password only after explicit user request and native desktop confirmation. Current and new passwords are collected in hidden native dialogs, never in AI tool arguments or results.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
}, guarded(() => oneAccountWrite(async () => {
  if (!supportsNativeAccount) throw new Error('Native password change requires macOS or Windows');
  const profile = await gateway.getMyProfile();
  const approved = await confirmGatewayAction({ kind: 'panel_action', preview: {
    action: 'change_gateway_password', details: { accountId: profile.id, email: profile.email, password: 'entered locally and hidden' },
  } });
  if (!approved) return { status: 'cancelled', passwordChanged: false };
  const credentials = await promptForPasswordChange();
  const updated = await accessTokenProvider.changePassword(credentials);
  return { status: 'changed', id: updated.id, email: updated.email, sessionPersistence: updated.sessionPersistence };
})));

server.registerTool('assign_gateway_organization', {
  description: 'Assign the signed-in Gateway user to a new organization during onboarding after explicit chat and native approval. The new session is verified and stored locally. Never retry an uncertain result automatically.',
  inputSchema: {
    organizationName: z.string().min(1).max(200),
    organizationWebsite: z.url().nullable().optional(),
    businessRole: z.string().min(1).max(100),
    accountType: z.string().min(1).max(100),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
}, guarded((details) => oneAccountWrite(async () => {
  const approved = await confirmGatewayAction({ kind: 'panel_action', preview: { action: 'assign_gateway_organization', details } });
  if (!approved) return { status: 'cancelled', organizationAssigned: false };
  const profile = await accessTokenProvider.assignOrganization(details);
  return { status: 'assigned', id: profile.id, email: profile.email, sessionPersistence: profile.sessionPersistence };
})));

server.registerTool('start_gateway_password_reset', {
  description: 'Request a real password-reset WhatsApp code for a phone number only after explicit user request and native confirmation. No password or reset token enters the AI client.',
  inputSchema: { target: z.string().min(8).max(16) },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
}, guarded(({ target }) => oneAccountWrite(async () => {
  const approved = await confirmGatewayAction({ kind: 'panel_action', preview: { action: 'start_gateway_password_reset', details: { target } } });
  if (!approved) return { status: 'cancelled', codeRequested: false };
  return accessTokenProvider.startPasswordReset(target);
})));

server.registerTool('verify_gateway_password_reset_code', {
  description: 'Verify the password-reset code in a hidden native desktop dialog. The code and single-use reset token are never returned to the AI client.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, guarded(() => oneAccountWrite(async () => accessTokenProvider.verifyPasswordResetCode(await promptForGatewayOtp()))));

server.registerTool('finish_gateway_password_reset', {
  description: 'Reset the password only after code verification and explicit chat/native approval. Collect the new password in hidden native desktop dialogs; no password or reset token enters the AI client.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
}, guarded(() => oneAccountWrite(async () => {
  const approved = await confirmGatewayAction({ kind: 'panel_action', preview: { action: 'finish_gateway_password_reset', details: { password: 'entered locally and hidden' } } });
  if (!approved) return { status: 'cancelled', passwordReset: false };
  return accessTokenProvider.finishPasswordReset(await promptForNewPassword());
})));

server.registerTool('send_gateway_account_verification_code', {
  description: 'Send one real WhatsApp phone-verification code to the signed-in user after explicit chat/native approval.',
  inputSchema: { target: z.string().min(8).max(16) },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
}, guarded(({ target }) => oneAccountWrite(async () => {
  const approved = await confirmGatewayAction({ kind: 'panel_action', preview: { action: 'send_gateway_account_verification_code', details: { target } } });
  if (!approved) return { status: 'cancelled', codeRequested: false };
  return accessTokenProvider.sendAccountVerificationCode(target);
})));

server.registerTool('verify_gateway_account_code', {
  description: 'Verify the signed-in user’s WhatsApp phone-verification code through a hidden native desktop dialog, without putting the code in the AI client.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, guarded(() => oneAccountWrite(async () => accessTokenProvider.verifyAccountCode(await promptForGatewayOtp()))));

server.registerTool('list_my_applications', {
  description: 'List applications in the signed-in Connexease Gateway account.',
  annotations: { readOnlyHint: true },
}, guarded(() => gateway.listApplications()));

server.registerTool('get_application', {
  description: 'Read basic metadata for an application in the signed-in Gateway account.',
  inputSchema: { appId: z.string().min(1).max(100) },
  annotations: { readOnlyHint: true },
}, guarded(({ appId }) => gateway.getApplication(appId)));

for (const [name, description, method] of [
  ['get_whatsapp_health', 'Read WhatsApp application health and connection metrics.', 'getWhatsappHealth'],
  ['get_whatsapp_business_profile', 'Read the WhatsApp business profile for an application.', 'getWhatsappBusinessProfile'],
  ['get_whatsapp_username_suggestions', 'Read available WhatsApp business username suggestions for an application.', 'getWhatsappUsernameSuggestions'],
  ['get_instagram_health', 'Read Instagram application health and connection metrics.', 'getInstagramHealth'],
  ['get_instagram_profile', 'Read the Instagram profile for an application.', 'getInstagramProfile'],
]) {
  server.registerTool(name, {
    description,
    inputSchema: { appId: z.string().min(1).max(100) },
    annotations: { readOnlyHint: true },
  }, guarded(({ appId }) => gateway[method](appId)));
}

server.registerTool('check_whatsapp_account_readiness', {
  description: 'Read available WhatsApp account, phone and business-profile checks for one owned application. Business verification cannot be read definitively; the 250 messaging limit is only a labeled inference. No account changes are made.',
  inputSchema: { appId: z.string().min(1).max(100) },
  annotations: { readOnlyHint: true },
}, guarded(({ appId }) => checkWhatsappAccountReadiness(gateway, appId)));

for (const [name, description, method] of [
  ['list_my_organizations', 'List organizations accessible to the signed-in user.', 'listMyOrganizations'],
  ['get_organization_contact', 'Read the current organization contact details.', 'getOrganizationContact'],
  ['get_allowed_origins', 'Read the current organization allowed-origin list.', 'getAllowedOrigins'],
  ['get_wallet_balance', 'Read the current organization wallet balance.', 'getWalletBalance'],
  ['get_billing_account', 'Read billing account details for the current organization.', 'getBillingAccount'],
  ['get_payment_method_metadata', 'Read only non-secret payment-card metadata; never expose payment credentials.', 'getPaymentMethodMetadata'],
  ['list_invoices', 'List billing invoices for the current organization.', 'listInvoices'],
  ['list_organization_secrets_metadata', 'List organization secret names and status without exposing any secret or publishable key value.', 'listOrganizationSecretsMetadata'],
]) {
  server.registerTool(name, {
    description,
    annotations: { readOnlyHint: true },
  }, guarded(() => gateway[method]()));
}

server.registerTool('list_whatsapp_templates', {
  description: 'Read one paginated page of WhatsApp template metadata for an application.',
  inputSchema: { appId: z.string().min(1).max(100), pageNumber: z.number().int().min(1).optional(), pageSize: z.number().int().min(1).max(100).optional() },
  annotations: { readOnlyHint: true },
}, guarded(({ appId, pageNumber, pageSize }) => gateway.listWhatsappTemplates(appId, pageNumber, pageSize)));

server.registerTool('get_whatsapp_template', {
  description: 'Read one WhatsApp template and its components by source ID.',
  inputSchema: { appId: z.string().min(1).max(100), sourceId: z.string().min(1).max(100) },
  annotations: { readOnlyHint: true },
}, guarded(({ appId, sourceId }) => gateway.getWhatsappTemplate(appId, sourceId)));

server.registerTool('get_template_health_summary', {
  description: 'Read up to 1000 templates across pages for one owned application and summarize status, quality, rejection reasons, category changes, languages and categories. This does not provide per-template sent, delivered, read or click metrics.',
  inputSchema: {
    appId: z.string().min(1).max(100),
    status: z.enum(['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED']).optional(),
    category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']).optional(),
  },
  annotations: { readOnlyHint: true },
}, guarded((args) => getTemplateHealthSummary(gateway, args)));

server.registerTool('upload_whatsapp_template_media', {
  description: 'Open a native desktop file picker; upload only the file selected by the developer to their owned WhatsApp application after exact native approval. The AI never chooses a filesystem path. Makes one request, with no automatic retry.',
  inputSchema: { appId: z.string().min(1).max(100) },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
}, guarded(({ appId }) => oneAccountWrite(async () => {
  const filePath = await selectGatewayUploadFile();
  if (!filePath) return { status: 'cancelled', uploaded: false };
  const prepared = await gateway.prepareWhatsappMediaUpload(appId, filePath);
  const approved = await confirmGatewayAction({ kind: 'panel_action', preview: { action: 'upload_whatsapp_template_media', details: prepared.preview } });
  if (!approved) return { status: 'cancelled', uploaded: false };
  return gateway.uploadWhatsappMedia(prepared);
})));

server.registerTool('get_insights_report', {
  description: 'Low-level raw WhatsApp insights report. When the user names one visible Insight table or chart, use get_insights_view instead; never fetch unrelated reports.',
  inputSchema: {
    report: z.enum(['summary', 'messages', 'categories', 'messagingCost', 'messagingCostApps', 'messagesBreakup']),
    startDate: z.iso.date().optional(),
    endDate: z.iso.date().optional(),
    appId: z.string().min(1).max(100).optional(),
    granularity: z.enum(['hourly', 'daily', 'weekly', 'monthly']).optional(),
    pageNumber: z.number().int().min(1).optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
  },
  annotations: { readOnlyHint: true },
}, guarded((args) => gateway.getInsightsReport(args)));

server.registerTool('list_insights_views', {
  description: 'List exact Insight page widget names in English and Turkish, including unavailable Coming Soon widgets. Does not call Gateway.',
  annotations: { readOnlyHint: true },
}, guarded(() => listInsightsViews()));

server.registerTool('get_insights_view', {
  description: 'Fetch exactly ONE named Insight page widget, then return only that widget as a terminal-ready table and, when appropriate, a monochrome Unicode line chart or bar chart. Use this when the user names a single table/chart. Never call several reports for one requested view. Apps Overview is marked unavailable rather than using mock data.',
  inputSchema: {
    view: z.enum(Object.keys(INSIGHT_VIEWS)),
    startDate: z.iso.date().optional(), endDate: z.iso.date().optional(),
    appId: z.string().min(1).max(100).optional(),
    granularity: z.enum(['hourly', 'daily', 'weekly', 'monthly']).optional(),
    pageNumber: z.number().int().min(1).optional(), pageSize: z.number().int().min(1).max(100).optional(),
    metric: z.string().min(1).max(40).optional(),
  },
  annotations: { readOnlyHint: true },
}, guardedTerminal((args) => getInsightsView(gateway, args)));

server.registerTool('compare_insights_periods', {
  description: 'Compare the SAME named Insight widget across two explicit date ranges. Returns period A, period B, B-minus-A and percentage changes, plus shared-scale monochrome Unicode line charts for time series. Breakup table totals include all pages; no unrelated widgets are fetched. Read-only.',
  inputSchema: {
    view: z.enum(Object.keys(INSIGHT_VIEWS)),
    periodA: z.object({ startDate: z.iso.date(), endDate: z.iso.date() }),
    periodB: z.object({ startDate: z.iso.date(), endDate: z.iso.date() }),
    appId: z.string().min(1).max(100).optional(),
    granularity: z.enum(['hourly', 'daily', 'weekly', 'monthly']).optional(),
    metric: z.string().min(1).max(40).optional(),
  },
  annotations: { readOnlyHint: true },
}, guardedTerminal((args) => compareInsightsPeriods(gateway, args)));

server.registerTool('get_insights_export_rows', {
  description: 'Read the full row data that the panel exports as a WhatsApp insights CSV. This may be large; it does not save a local file.',
  inputSchema: {
    startDate: z.iso.date(), endDate: z.iso.date(), appId: z.string().min(1).max(100).optional(),
  },
  annotations: { readOnlyHint: true },
}, guarded((args) => gateway.getInsightsExport(args)));

server.registerTool('save_insights_csv', {
  description: 'Save the panel-format WhatsApp insights CSV after explicit user request. A native desktop save dialog chooses the destination; the AI never supplies a path. Existing files are not overwritten.',
  inputSchema: { startDate: z.iso.date(), endDate: z.iso.date(), appId: z.string().min(1).max(100).optional() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, guarded((args) => saveInsightsCsv(gateway, args)));

server.registerTool('validate_wallet_coupon', {
  description: 'Read the discount and charge amount for a proposed wallet top-up coupon. This does not initiate a payment.',
  inputSchema: { amountUsd: z.union([z.number().positive(), z.string().min(1)]), couponCode: z.string().min(1).max(100) },
  annotations: { readOnlyHint: true },
}, guarded((args) => gateway.validateWalletCoupon(args)));

const libraryFiltersSchema = {
  appId: z.string().min(1).max(100),
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']),
  language: z.string().min(2).max(20),
  topic: z.string().max(200).optional(),
  useCase: z.string().max(200).optional(),
  industry: z.string().max(200).optional(),
  search: z.string().max(200).optional(),
};

server.registerTool('list_template_library', {
  description: 'Search the WhatsApp template library for an application, with cursor pagination.',
  inputSchema: {
    ...libraryFiltersSchema,
    limit: z.number().int().min(1).max(100).optional(),
    after: z.string().max(200).optional(),
    before: z.string().max(200).optional(),
  },
  annotations: { readOnlyHint: true },
}, guarded(({ appId, ...filters }) => gateway.listTemplateLibrary(appId, filters)));

server.registerTool('get_template_library_filters', {
  description: 'Read available WhatsApp template-library filters for an application.',
  inputSchema: libraryFiltersSchema,
  annotations: { readOnlyHint: true },
}, guarded(({ appId, ...filters }) => gateway.getTemplateLibraryFilters(appId, filters)));

server.registerTool('get_template_library_detail', {
  description: 'Read one WhatsApp template-library design by name and language.',
  inputSchema: { appId: z.string().min(1).max(100), templateName: z.string().min(1).max(100), language: z.string().min(2).max(20) },
  annotations: { readOnlyHint: true },
}, guarded(({ appId, templateName, language }) => gateway.getTemplateLibraryDetail(appId, templateName, language)));

server.registerTool('get_webhook_status', {
  description: 'Read webhook status and URL. Secret webhook headers are never returned.',
  inputSchema: { appId: z.string().min(1).max(100) },
  annotations: { readOnlyHint: true },
}, guarded(({ appId }) => gateway.getWebhookStatus(appId)));

server.registerTool('set_webhook_header', {
  description: 'Set one custom header on an existing application webhook. The header value is collected in a hidden native desktop dialog, never in chat or tool arguments; existing headers are preserved. Requires explicit chat approval and native confirmation.',
  inputSchema: { appId: z.string().min(1).max(100), headerName: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,99}$/) },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
}, guarded(({ appId, headerName }) => oneAccountWrite(async () => {
  if (!supportsNativeAccount) throw new Error('Native webhook header entry requires macOS or Windows');
  const prepared = await gateway.prepareWebhookHeaderUpdate(appId, headerName);
  const approved = await confirmGatewayAction({ kind: 'panel_action', preview: { action: 'set_webhook_header', details: prepared.preview } });
  if (!approved) return { status: 'cancelled', changed: false };
  const value = await promptForWebhookHeaderValue();
  return gateway.updateWebhookHeader(prepared, value);
})));

server.registerTool('list_api_key_metadata', {
  description: 'List API key names, status, and limits. Raw keys are never returned.',
  inputSchema: { appId: z.string().min(1).max(100), pageNumber: z.number().int().min(1).optional(), pageSize: z.number().int().min(1).max(100).optional() },
  annotations: { readOnlyHint: true },
}, guarded(({ appId, pageNumber, pageSize }) => gateway.listApiKeyMetadata(appId, pageNumber, pageSize)));

server.registerTool('list_sandbox_test_numbers', {
  description: 'List sandbox test numbers for an application in the signed-in Gateway account.',
  inputSchema: { appId: z.string().min(1).max(100) },
  annotations: { readOnlyHint: true },
}, guarded(({ appId }) => gateway.listTestNumbers(appId)));

server.registerTool('prepare_sandbox_text', {
  description: 'Use live account data to validate and preview a sandbox text. Does NOT send any message.',
  inputSchema: {
    appId: z.string().min(1).max(100),
    testNumberId: z.uuid(),
    message: z.string().min(1).max(4096),
  },
  annotations: { readOnlyHint: true },
}, guarded((args) => gateway.prepareSandboxText(args)));

server.registerTool('add_sandbox_test_number', {
  description: 'Add an E.164 sandbox test number to a selected application after an exact native desktop confirmation. The user must explicitly request adding it. Never use this tool for a different account or application.',
  inputSchema: {
    appId: z.string().min(1).max(100),
    phoneNumber: z.string().min(7).max(16),
    title: z.string().min(1).max(50).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, guarded((args) => oneAccountWrite(() => addSandboxTestNumber(gateway, confirmGatewayAction, args))));

server.registerTool('send_sandbox_text', {
  description: 'Make one real sandbox WhatsApp text send to a registered test number in the selected application, only after explicit user request and exact native desktop confirmation. Never retry automatically; an error may mean the outcome is unknown.',
  inputSchema: {
    appId: z.string().min(1).max(100),
    testNumberId: z.uuid(),
    message: z.string().min(1).max(4096),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
}, guarded((args) => oneAccountWrite(() => sendSandboxText(gateway, confirmGatewayAction, args))));

server.registerTool('prepare_sandbox_template', {
  description: 'Read an APPROVED WhatsApp template, verify the selected test number belongs to the application, validate template parameters and preview the real template send. Does NOT send.',
  inputSchema: {
    appId: z.string().min(1).max(100),
    testNumberId: z.uuid(),
    sourceId: z.string().min(1).max(100),
    parameters: templateParametersSchema.optional(),
  },
  annotations: { readOnlyHint: true },
}, guarded((args) => gateway.prepareSandboxTemplate(args)));

server.registerTool('send_sandbox_template', {
  description: 'Make one real sandbox WhatsApp TEMPLATE send to a registered test number, only after explicit user approval of the preview and exact native desktop confirmation. Unsupported template components are blocked. Never retry automatically.',
  inputSchema: {
    appId: z.string().min(1).max(100),
    testNumberId: z.uuid(),
    sourceId: z.string().min(1).max(100),
    parameters: templateParametersSchema.optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
}, guarded((args) => oneAccountWrite(() => sendSandboxTemplate(gateway, confirmGatewayAction, args))));

const panelActionTools = [
  ['rename_application', 'Rename one owned WhatsApp or Instagram application.', { appId: z.string().min(1).max(100), applicationName: z.string().min(1).max(100) }, false],
  ['update_application_contact', 'Update only the provided contact fields on one owned application.', {
    appId: z.string().min(1).max(100),
    contact: z.object({ name: z.string().min(1).max(200).optional(), email: z.email().optional(), phoneNumber: z.string().min(7).max(16).optional() }).strict(),
  }, false],
  ['set_whatsapp_username', 'Assign, change or clear the business username of an owned WhatsApp application.', { appId: z.string().min(1).max(100), username: z.string().max(50) }, false],
  ['update_test_number', 'Rename a test number belonging to the selected application.', { appId: z.string().min(1).max(100), testNumberId: z.uuid(), title: z.string().min(1).max(50) }, false],
  ['delete_test_number', 'Delete a test number belonging to the selected application.', { appId: z.string().min(1).max(100), testNumberId: z.uuid() }, true],
  ['add_allowed_origin', 'Add one exact origin to the organization allowlist.', { origin: z.string().url().max(200) }, false],
  ['delete_allowed_origin', 'Delete one exact origin from the organization allowlist.', { origin: z.string().url().max(200) }, true],
  ['delete_whatsapp_template', 'Delete one WhatsApp template from an owned application by source ID.', { appId: z.string().min(1).max(100), sourceId: z.string().min(1).max(100) }, true],
  ['create_whatsapp_template', 'Submit a new WhatsApp message template for an owned application; Meta approval is asynchronous.', {
    appId: z.string().min(1).max(100), template: createTemplateSchema,
  }, true],
  ['update_whatsapp_template', 'Submit a content update for a WhatsApp template. Name, language and category cannot change.', {
    appId: z.string().min(1).max(100), sourceId: z.string().min(1).max(100), template: templateContentSchema,
  }, true],
  ['upsert_webhook', 'Create or update a webhook URL and/or subscribed events. Custom secret headers are not accepted in AI tool arguments; existing headers remain unchanged.', {
    appId: z.string().min(1).max(100),
    url: z.url().optional(),
    subscribedEvents: z.object({
      messages: z.boolean().optional(), message_status: z.boolean().optional(), message_template_status: z.boolean().optional(), read: z.boolean().optional(), account: z.boolean().optional(),
    }).strict().optional(),
  }, false],
  ['delete_webhook', 'Delete an existing application webhook.', { appId: z.string().min(1).max(100) }, true],
  ['test_webhook', 'Send a real test event to the configured application webhook.', { appId: z.string().min(1).max(100) }, true],
  ['test_sandbox_webhook', 'Send a real sandbox webhook test payload to a selected HTTPS target.', {
    appId: z.string().min(1).max(100), targetUrl: z.url(), payload: z.string().min(1).max(10000),
  }, true],
  ['update_whatsapp_business_profile', 'Patch the WhatsApp business profile for an owned application.', {
    appId: z.string().min(1).max(100),
    profile: z.object({
      about: z.string().max(1000).nullable().optional(), address: z.string().max(1000).nullable().optional(),
      description: z.string().max(1000).nullable().optional(), email: z.string().max(1000).nullable().optional(),
      category: z.string().max(1000).nullable().optional(), websites: z.array(z.url()).max(2).nullable().optional(),
      profilePictureReference: z.string().max(1000).nullable().optional(),
    }).strict(),
  }, false],
  ['upsert_billing_account', 'Create or update the current organization billing account. Do not use this tool to make a payment.', {
    account: z.object({
      legalAddress: z.string().min(1).max(500), taxNumber: z.string().min(1).max(500), taxOffice: z.string().min(1).max(500),
      companyName: z.string().min(1).max(500), companyLegalTitle: z.string().min(1).max(500), vatNumber: z.string().min(1).max(500),
      additionalNote: z.string().max(500).nullable().optional(), city: z.string().max(500).nullable().optional(), country: z.string().max(500).nullable().optional(),
    }).strict(),
  }, false],
  ['delete_api_key', 'Revoke one API key belonging to the selected application. This is irreversible.', {
    appId: z.string().min(1).max(100), keyId: z.uuid(),
  }, true],
];

for (const [name, description, inputSchema, destructive] of panelActionTools) {
  server.registerTool(name, {
    description: `${description} The user must approve the exact action in chat, then in a native desktop confirmation. Never retry automatically.`,
    inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: destructive, idempotentHint: false },
  }, guarded((args) => oneAccountWrite(() => performPanelAction(gateway, confirmGatewayAction, name, args))));
}

server.registerTool('create_api_key', {
  description: 'Create one application API key after explicit chat and native desktop approval. The new key is displayed only in a local native dialog and is never returned to the AI client. Never retry automatically.',
  inputSchema: {
    appId: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    dailyLimit: z.number().int().min(1).max(1000000).optional(),
    concurrencyLimit: z.number().int().min(1).max(1000000).optional(),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
}, guarded((args) => oneAccountWrite(() => createApiKey(gateway, confirmGatewayAction, showGatewaySecret, args))));

server.registerTool('create_organization_secret', {
  description: 'Create one organization publishable or secret key after explicit chat and native approval. Plaintext is shown only in a local native dialog and never returned to the AI client. Never retry automatically.',
  inputSchema: {
    name: z.string().min(1).max(100),
    type: z.enum(['PUBLISHABLE', 'SECRET']),
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
}, guarded((args) => oneAccountWrite(() => createOrganizationSecret(gateway, confirmGatewayAction, showGatewaySecret, args))));

await server.connect(new StdioServerTransport());
