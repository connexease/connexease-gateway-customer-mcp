import { readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';
import { validateTemplateParameters } from './template-parameters.mjs';

export const DEFAULT_API_BASE_URL = 'https://api-gateway.connexease.com/api/v1';

function assertIdentifier(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) {
    throw new Error(`${name} must be a valid identifier`);
  }
  return value;
}

function assertUuid(value, name) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} must be a UUID`);
  }
  return value;
}

function requireArray(value, name) {
  if (!Array.isArray(value)) throw new Error(`Gateway returned an invalid ${name} response`);
  return value;
}

function requireRecord(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Gateway returned an invalid ${name} response`);
  }
  return value;
}

function assertPage(value, name, max) {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
}

function queryString(parameters) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  return query.size ? `?${query}` : '';
}

function assertNonEmptyString(value, name, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) {
    throw new Error(`${name} must contain 1-${max} characters without line breaks`);
  }
  return value.trim();
}

function assertOrigin(value) {
  if (typeof value !== 'string') throw new Error('origin must be an http(s) origin');
  let url;
  try { url = new URL(value); } catch { throw new Error('origin must be an http(s) origin'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin !== value.replace(/\/$/, '')) {
    throw new Error('origin must be an http(s) origin without a path, query or credentials');
  }
  return url.origin;
}

function assertHttpsUrl(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an HTTPS URL`); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${name} must be an HTTPS URL without credentials`);
  return url.href;
}

class GatewayHttpError extends Error {
  constructor(status) {
    super(`Gateway request failed (HTTP ${status})`);
    this.status = status;
  }
}

export class GatewayApiClient {
  #applicationRoute = '/applications';

  constructor({ accessTokenProvider, fetchImpl = fetch, baseUrl = DEFAULT_API_BASE_URL }) {
    if (!accessTokenProvider || typeof accessTokenProvider.getAccessToken !== 'function') {
      throw new Error('A per-user access token provider is required');
    }
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('Gateway API base URL must be a clean HTTPS URL');
    }
    this.baseUrl = url.href.replace(/\/+$/, '');
    this.accessTokenProvider = accessTokenProvider;
    this.fetchImpl = fetchImpl;
  }

  async #requestResponse(path, { method = 'GET', body } = {}) {
    const token = await this.accessTokenProvider.getAccessToken();
    if (typeof token !== 'string' || !token) throw new Error('Gateway login required');
    const url = new URL(`${this.baseUrl}${path}`);
    if (url.origin !== new URL(this.baseUrl).origin) throw new Error('Invalid Gateway URL');

    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(method === 'GET' ? 10000 : 20000),
      });
    } catch {
      throw new Error(method === 'GET'
        ? 'Gateway is unreachable; no account data was loaded'
        : 'Gateway write outcome is unknown. Check the panel before retrying.');
    }
    if (response.status === 401) throw new Error('Gateway session expired; sign in again');
    if (response.status === 403) throw new Error('Gateway account does not have access');
    if (method !== 'GET' && response.status >= 500) {
      throw new Error('Gateway write outcome is unknown. Check the panel before retrying.');
    }
    if (!response.ok) throw new GatewayHttpError(response.status);

    if (response.status === 204) return { isSuccess: true, data: null };

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(method === 'GET'
        ? 'Gateway returned an invalid JSON response'
        : 'Gateway write outcome is unknown. Check the panel before retrying.');
    }
    if (!payload || payload.isSuccess === false) {
      throw new Error(method === 'GET'
        ? 'Gateway request was not successful'
        : 'Gateway write outcome is unknown. Check the panel before retrying.');
    }
    return payload;
  }

  async #request(path) {
    return (await this.#requestResponse(path)).data;
  }

  async #post(path, body) {
    return (await this.#requestResponse(path, { method: 'POST', body })).data;
  }

  async #requestApplication(path = '') {
    try {
      return await this.#request(`${this.#applicationRoute}${path}`);
    } catch (error) {
      // Production still serves the older WhatsApp-scoped read endpoints.
      if (this.#applicationRoute !== '/applications' || !(error instanceof GatewayHttpError) || error.status !== 404) {
        throw error;
      }
      this.#applicationRoute = '/channels/whatsapp/applications';
      return this.#request(`${this.#applicationRoute}${path}`);
    }
  }

  async getMyProfile() {
    const data = await this.#request('/users/me');
    if (!data || typeof data.id !== 'string' || typeof data.email !== 'string') {
      throw new Error('Gateway returned an invalid profile response');
    }
    return {
      id: data.id, email: data.email, state: data.state,
      ...(typeof data.firstName === 'string' ? { firstName: data.firstName } : {}),
      ...(typeof data.lastName === 'string' ? { lastName: data.lastName } : {}),
      ...(typeof data.phoneNumber === 'string' ? { phoneNumber: data.phoneNumber } : {}),
    };
  }

  async listApplications() {
    const data = requireArray(await this.#requestApplication(), 'applications');
    return data.map((app) => ({
      id: app.id,
      appId: app.appId,
      displayName: app.displayName,
      status: app.status,
    }));
  }

  async #requireApplication(appId) {
    assertIdentifier(appId, 'appId');
    const apps = await this.listApplications();
    if (!apps.some((app) => app.appId === appId)) throw new Error('Application not found in this account');
  }

  async #getOwnedApplicationDetail(appId) {
    await this.#requireApplication(appId);
    const app = await this.#requestApplication(`/${encodeURIComponent(appId)}?expand=channel`);
    if (!app || app.appId !== appId) throw new Error('Gateway returned an invalid application response');
    return app;
  }

  async getApplication(appId) {
    await this.#requireApplication(appId);
    const app = await this.#requestApplication(`/${encodeURIComponent(appId)}?expand=channel`);
    if (!app || app.appId !== appId) throw new Error('Gateway returned an invalid application response');
    return {
      id: app.id,
      appId: app.appId,
      displayName: app.displayName,
      status: app.status,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
      contact: app.contact ? {
        name: app.contact.name, email: app.contact.email, phoneNumber: app.contact.phoneNumber,
      } : null,
      channel: app.channel ? {
        platform: app.channel.platform, id: app.channel.id,
        phoneNumber: app.channel.phoneNumber,
        phoneNumberId: app.channel.phoneNumberId,
        wabaId: app.channel.wabaId,
        businessUsername: app.channel.businessUsername,
        instagramAccountId: app.channel.instagramAccountId,
        instagramAccountName: app.channel.instagramAccountName,
        username: app.channel.username,
        handle: app.channel.handle,
        pageId: app.channel.pageId,
      } : null,
    };
  }

  async getWhatsappHealth(appId) {
    await this.#requireApplication(appId);
    return requireRecord(await this.#request(`/channels/whatsapp/applications/${encodeURIComponent(appId)}/health`), 'WhatsApp health');
  }

  async getWhatsappBusinessProfile(appId) {
    await this.#requireApplication(appId);
    const profile = await this.#request(`/channels/whatsapp/applications/${encodeURIComponent(appId)}/profile`);
    return profile === null ? { configured: false } : { configured: true, profile: requireRecord(profile, 'WhatsApp business profile') };
  }

  async getInstagramHealth(appId) {
    await this.#requireApplication(appId);
    return requireRecord(await this.#request(`/channels/instagram/applications/${encodeURIComponent(appId)}/health`), 'Instagram health');
  }

  async getInstagramProfile(appId) {
    await this.#requireApplication(appId);
    const profile = await this.#request(`/channels/instagram/applications/${encodeURIComponent(appId)}/profile`);
    return profile === null ? { configured: false } : { configured: true, profile: requireRecord(profile, 'Instagram profile') };
  }

  async getWhatsappUsernameSuggestions(appId) {
    await this.#requireApplication(appId);
    const data = requireRecord(await this.#request(`/channels/whatsapp/applications/${encodeURIComponent(appId)}/username/suggestions`), 'username suggestions');
    return { suggestions: requireArray(data.suggestions ?? [], 'username suggestions') };
  }

  async listMyOrganizations() {
    const data = await this.#request('/users/me/organizations');
    return requireArray(Array.isArray(data) ? data : data ? [data] : [], 'organizations');
  }

  async getOrganizationContact() {
    const contact = await this.#request('/organizations/contact');
    return contact === null ? { configured: false } : { configured: true, contact: requireRecord(contact, 'organization contact') };
  }

  async getAllowedOrigins() {
    const data = requireRecord(await this.#request('/organizations/allowed-origins'), 'allowed origins');
    return { origins: requireArray(data.origins ?? [], 'allowed origins') };
  }

  async getWalletBalance() {
    const balance = await this.#request('/wallet/balance');
    if (balance === null) return { available: false };
    const data = requireRecord(balance, 'wallet balance');
    return { available: true, balance: data.balance, currency: data.currency };
  }

  async getBillingAccount() {
    const account = await this.#request('/billing/account');
    return account === null ? { configured: false } : { configured: true, account: requireRecord(account, 'billing account') };
  }

  async getPaymentMethodMetadata() {
    const method = await this.#request('/billing/payment-method');
    if (method === null) return { configured: false };
    const data = requireRecord(method, 'payment method');
    const { type, cardBrand, cardLast4, cardExpirationMonth, cardExpirationYear, isDefault } = data;
    return { configured: true, type, cardBrand, cardLast4, cardExpirationMonth, cardExpirationYear, isDefault };
  }

  async listInvoices() {
    return requireArray(await this.#request('/billing/invoices'), 'invoices');
  }

  async listOrganizationSecretsMetadata() {
    const entries = requireArray(await this.#request('/organization-secrets'), 'organization secrets');
    return entries.map(({ id, name, type, status, expiresAt, createdAt }) => ({ id, name, type, status, expiresAt, createdAt }));
  }

  async prepareWhatsappMediaUpload(appId, filePath) {
    await this.#requireApplication(appId);
    if (typeof filePath !== 'string' || !isAbsolute(filePath)) throw new Error('Select an absolute file path in the native picker');
    const info = await stat(filePath);
    if (!info.isFile() || info.size < 1 || info.size > 20 * 1024 * 1024) throw new Error('Choose a non-empty file of at most 20 MiB');
    return {
      status: 'ready', appId, filePath,
      preview: { applicationId: appId, fileName: basename(filePath), filePath, sizeBytes: info.size, modifiedAt: info.mtimeMs },
      identity: { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino },
    };
  }

  async uploadWhatsappMedia(prepared) {
    if (prepared?.status !== 'ready') throw new Error('A confirmed media upload preview is required');
    const current = await this.prepareWhatsappMediaUpload(prepared.appId, prepared.filePath);
    if (JSON.stringify(current.preview) !== JSON.stringify(prepared.preview) || JSON.stringify(current.identity) !== JSON.stringify(prepared.identity)) {
      throw new Error('Selected file changed; choose and confirm it again');
    }
    const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.pdf': 'application/pdf' };
    const content = await readFile(prepared.filePath);
    const form = new FormData();
    form.append('file', new Blob([content], { type: mimeTypes[extname(prepared.filePath).toLowerCase()] ?? 'application/octet-stream' }), basename(prepared.filePath));
    form.append('appId', prepared.appId);
    const token = await this.accessTokenProvider.getAccessToken();
    if (!token) throw new Error('Gateway login required');
    let response;
    try {
      response = await this.fetchImpl(new URL(`${this.baseUrl}/channels/whatsapp/upload`), {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        body: form, redirect: 'error', signal: AbortSignal.timeout(60000),
      });
    } catch {
      throw new Error('Gateway media upload outcome is unknown. Check the panel before retrying.');
    }
    if (response.status === 401) throw new Error('Gateway session expired; sign in again');
    if (!response.ok) throw new Error(`Gateway media upload failed (HTTP ${response.status})`);
    let payload;
    try { payload = await response.json(); } catch { throw new Error('Gateway media upload outcome is unknown. Check the panel before retrying.'); }
    if (payload?.isSuccess === false || typeof payload?.data?.handle !== 'string' || !payload.data.handle) {
      throw new Error('Gateway media upload outcome is unknown. Check the panel before retrying.');
    }
    return { status: 'uploaded', applicationId: prepared.appId, fileName: basename(prepared.filePath), handle: payload.data.handle };
  }

  async getInsightsReport({ report, startDate, endDate, appId, granularity, pageNumber = 1, pageSize = 20 }) {
    const paths = {
      summary: '/channels/whatsapp/insights/summary',
      messages: '/channels/whatsapp/insights/messages',
      categories: '/channels/whatsapp/insights/messages/categories',
      messagingCost: '/channels/whatsapp/insights/messaging-cost',
      messagingCostApps: '/channels/whatsapp/insights/messaging-cost/apps',
      messagesBreakup: '/channels/whatsapp/insights/messages/breakup',
    };
    if (!Object.hasOwn(paths, report)) throw new Error('Unsupported insights report');
    for (const [name, date] of [['startDate', startDate], ['endDate', endDate]]) {
      if (date !== undefined && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))) {
        throw new Error(`${name} must be a YYYY-MM-DD date`);
      }
    }
    if (startDate && endDate && startDate > endDate) throw new Error('startDate must not be after endDate');
    if (appId !== undefined) await this.#requireApplication(appId);
    if (granularity !== undefined && !['hourly', 'daily', 'weekly', 'monthly'].includes(granularity)) {
      throw new Error('Unsupported granularity');
    }
    if (report === 'messagesBreakup') {
      assertPage(pageNumber, 'pageNumber', 1000000);
      assertPage(pageSize, 'pageSize', 100);
    }
    const supportsGranularity = ['messages', 'messagingCost', 'messagesBreakup'].includes(report);
    if (!supportsGranularity && granularity !== undefined) throw new Error(`${report} does not support granularity`);
    const path = paths[report] + queryString({
      startDate, endDate, appId,
      ...(supportsGranularity ? { granularity } : {}),
      ...(report === 'messagesBreakup' ? { pageNumber, pageSize } : {}),
    });
    const response = await this.#requestResponse(path);
    return {
      report,
      data: report === 'messagesBreakup'
        ? requireArray(response.data, 'insights rows')
        : requireRecord(response.data, 'insights report'),
      ...(report === 'messagesBreakup' ? { pagingMetadata: response.pagingMetadata ?? null } : {}),
    };
  }

  async getInsightsExport({ startDate, endDate, appId }) {
    if (typeof startDate !== 'string' || typeof endDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate > endDate) {
      throw new Error('A valid YYYY-MM-DD date range is required');
    }
    if (appId !== undefined) await this.#requireApplication(appId);
    const rows = requireArray(await this.#request(`/channels/whatsapp/insights/export${queryString({ startDate, endDate, appId })}`), 'insights export');
    return { rows, rowCount: rows.length, startDate, endDate, applicationId: appId ?? null };
  }

  async validateWalletCoupon({ amountUsd, couponCode }) {
    if ((typeof amountUsd !== 'string' && typeof amountUsd !== 'number') || !/^\d+(?:\.\d{1,2})?$/.test(String(amountUsd)) || Number(amountUsd) <= 0) {
      throw new Error('amountUsd must be a positive amount with at most two decimals');
    }
    const code = assertNonEmptyString(couponCode, 'couponCode', 100);
    return requireRecord(await this.#request(`/wallet/coupon/validate${queryString({ amountUsd, couponCode: code })}`), 'coupon validation');
  }

  async listTemplateLibrary(appId, { category, language, topic, useCase, industry, search, limit = 20, after, before }) {
    await this.#requireApplication(appId);
    if (!['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(category)) throw new Error('Unsupported template category');
    if (typeof language !== 'string' || !/^[A-Za-z_]{2,20}$/.test(language)) throw new Error('Invalid template language');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be 1-100');
    for (const [name, value] of Object.entries({ topic, useCase, industry, search, after, before })) {
      if (value !== undefined && (typeof value !== 'string' || value.length > 200)) throw new Error(`${name} is invalid`);
    }
    if (after && before) throw new Error('Use either after or before cursor, not both');
    const path = `/channels/whatsapp/applications/${encodeURIComponent(appId)}/template-library`;
    const response = await this.#requestResponse(path + queryString({ category, language, topic, useCase, industry, search, limit, after, before }));
    return { items: requireArray(response.data, 'template library'), pagingMetadata: response.pagingMetadata ?? null };
  }

  async getTemplateLibraryFilters(appId, { category, language, topic, useCase, industry, search }) {
    await this.#requireApplication(appId);
    if (!['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(category)) throw new Error('Unsupported template category');
    if (typeof language !== 'string' || !/^[A-Za-z_]{2,20}$/.test(language)) throw new Error('Invalid template language');
    const path = `/channels/whatsapp/applications/${encodeURIComponent(appId)}/template-library/filters`;
    const data = await this.#request(path + queryString({ category, language, topic, useCase, industry, search }));
    return requireRecord(data, 'template library filters');
  }

  async getTemplateLibraryDetail(appId, templateName, language) {
    await this.#requireApplication(appId);
    assertIdentifier(templateName, 'templateName');
    if (typeof language !== 'string' || !/^[A-Za-z_]{2,20}$/.test(language)) throw new Error('Invalid template language');
    const path = `/channels/whatsapp/applications/${encodeURIComponent(appId)}/template-library/templates/${encodeURIComponent(templateName)}`;
    return requireRecord(await this.#request(path + queryString({ language })), 'template library detail');
  }

  async listWhatsappTemplates(appId, pageNumber = 1, pageSize = 20) {
    assertPage(pageNumber, 'pageNumber', 1000000);
    assertPage(pageSize, 'pageSize', 100);
    await this.#requireApplication(appId);
    const page = await this.#requestResponse(`/channels/whatsapp/applications/${encodeURIComponent(appId)}/templates?pageNumber=${pageNumber}&pageSize=${pageSize}`);
    const data = requireArray(page.data, 'templates');
    return {
      items: data.map(({ sourceId, name, language, category, status, qualityScore, rejectedReason }) => ({
        sourceId, name, language, category, status, qualityScore, rejectedReason,
      })),
      pagingMetadata: page.pagingMetadata ?? null,
    };
  }

  async getWhatsappTemplate(appId, sourceId) {
    assertIdentifier(sourceId, 'sourceId');
    await this.#requireApplication(appId);
    const template = await this.#request(`/channels/whatsapp/applications/${encodeURIComponent(appId)}/templates/${encodeURIComponent(sourceId)}`);
    if (!template || template.sourceId !== sourceId) throw new Error('Gateway returned an invalid template response');
    const { id, name, language, category, status, components, qualityScore, rejectedReason } = template;
    return { id, sourceId, name, language, category, status, components, qualityScore, rejectedReason };
  }

  async getWebhookStatus(appId) {
    await this.#requireApplication(appId);
    const webhook = await this.#request(`/applications/${encodeURIComponent(appId)}/webhook`);
    if (!webhook || !webhook.id) return { configured: false };
    const { id, url, subscribedEvents, isActive, createdAt, updatedAt } = webhook;
    return { configured: true, id, url, subscribedEvents, isActive, createdAt, updatedAt };
  }

  async prepareWebhookHeaderUpdate(appId, headerName) {
    await this.#requireApplication(appId);
    if (typeof headerName !== 'string' || !/^[A-Za-z][A-Za-z0-9-]{0,99}$/.test(headerName)) throw new Error('headerName must be an HTTP header name');
    const webhook = await this.#request(`/applications/${encodeURIComponent(appId)}/webhook`);
    if (!webhook?.id) throw new Error('Configure a webhook URL before adding a custom header');
    const headers = requireRecord(webhook.headers ?? {}, 'webhook headers');
    if (Object.values(headers).some((value) => typeof value !== 'string' || /[\*\u2022\u2026]/.test(value))) {
      throw new Error('Existing webhook headers are masked or invalid; cannot safely preserve them');
    }
    return {
      status: 'ready', appId, headerName, webhookId: webhook.id, headers,
      preview: { applicationId: appId, webhookUrl: webhook.url, headerName, headerAlreadyExists: Object.hasOwn(headers, headerName), value: 'entered locally and hidden' },
    };
  }

  async updateWebhookHeader(prepared, value) {
    if (prepared?.status !== 'ready') throw new Error('A confirmed webhook header preview is required');
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error('Webhook header value is invalid');
    const current = await this.prepareWebhookHeaderUpdate(prepared.appId, prepared.headerName);
    if (current.webhookId !== prepared.webhookId || JSON.stringify(current.preview) !== JSON.stringify(prepared.preview) || JSON.stringify(current.headers) !== JSON.stringify(prepared.headers)) {
      throw new Error('Webhook changed; review and confirm the action again');
    }
    const headers = { ...current.headers, [prepared.headerName]: value };
    await this.#requestResponse(`/applications/${encodeURIComponent(prepared.appId)}/webhook`, { method: 'POST', body: { headers } });
    return { status: 'applied', action: 'set_webhook_header', applicationId: prepared.appId, headerName: prepared.headerName, value: 'hidden' };
  }

  async listApiKeyMetadata(appId, pageNumber = 1, pageSize = 20) {
    assertPage(pageNumber, 'pageNumber', 1000000);
    assertPage(pageSize, 'pageSize', 100);
    await this.#requireApplication(appId);
    const page = await this.#requestResponse(`/applications/${encodeURIComponent(appId)}/api-keys?pageNumber=${pageNumber}&pageSize=${pageSize}`);
    const data = requireArray(page.data, 'API keys');
    return {
      items: data.map(({ id, appId: keyAppId, name, dailyLimit, concurrencyLimit, isActive, expiresAt, createdAt }) => ({
        id, appId: keyAppId, name, dailyLimit, concurrencyLimit, isActive, expiresAt, createdAt,
      })),
      pagingMetadata: page.pagingMetadata ?? null,
    };
  }

  async listTestNumbers(appId) {
    await this.#requireApplication(appId);
    const data = requireArray(await this.#request(`/applications/${encodeURIComponent(appId)}/sandbox/test-numbers`), 'test numbers');
    return data.map((number) => ({
      id: number.id,
      appId: number.appId,
      title: number.title,
      phoneNumber: number.phoneNumber,
    }));
  }

  async prepareSandboxTestNumber({ appId, phoneNumber, title }) {
    assertIdentifier(appId, 'appId');
    if (typeof phoneNumber !== 'string') throw new Error('phoneNumber must be in E.164 format');
    const normalizedPhoneNumber = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;
    if (!/^\+[1-9]\d{6,14}$/.test(normalizedPhoneNumber)) {
      throw new Error('phoneNumber must be in E.164 format');
    }
    if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 50 || /[\r\n\0]/.test(title))) {
      throw new Error('title must contain 1-50 characters');
    }
    const numbers = await this.listTestNumbers(appId);
    const existing = numbers.find((number) => number.phoneNumber === normalizedPhoneNumber);
    if (existing) return { status: 'already_exists', number: existing };
    return {
      status: 'ready',
      preview: { applicationId: appId, phoneNumber: normalizedPhoneNumber, ...(title === undefined ? {} : { title }) },
    };
  }

  async createSandboxTestNumber(prepared) {
    if (prepared?.status !== 'ready') throw new Error('A confirmed test-number preview is required');
    const { applicationId: appId, phoneNumber, title } = prepared.preview;
    const current = await this.prepareSandboxTestNumber({ appId, phoneNumber, title });
    if (current.status === 'already_exists') return current;
    const data = await this.#post(`/applications/${encodeURIComponent(appId)}/sandbox/test-numbers`, {
      phoneNumber,
      ...(title === undefined ? {} : { title }),
    });
    if (!data || data.appId !== appId || data.phoneNumber !== phoneNumber || typeof data.id !== 'string') {
      throw new Error('Gateway test-number creation outcome is unknown. Check the panel before retrying.');
    }
    return {
      status: 'created',
      number: { id: data.id, appId: data.appId, title: data.title, phoneNumber: data.phoneNumber },
    };
  }

  async prepareSandboxText({ appId, testNumberId, message }) {
    assertIdentifier(appId, 'appId');
    assertUuid(testNumberId, 'testNumberId');
    if (typeof message !== 'string' || !message.trim() || message.length > 4096) {
      throw new Error('message must contain 1-4096 characters');
    }
    const numbers = await this.listTestNumbers(appId);
    const number = numbers.find((item) => item.id === testNumberId && item.appId === appId);
    if (!number) throw new Error('Test number not found in this application');
    return {
      status: 'not_sent',
      preview: {
        applicationId: appId,
        testNumberId,
        testNumber: number.title,
        phoneNumber: number.phoneNumber,
        message,
      },
      nextStep: 'Ask the user to approve this exact preview, then use send_sandbox_text. A native confirmation is also required.',
    };
  }

  async sendSandboxText(prepared) {
    if (prepared?.status !== 'not_sent') throw new Error('A confirmed sandbox preview is required');
    const approved = prepared.preview;
    const current = await this.prepareSandboxText({
      appId: approved.applicationId,
      testNumberId: approved.testNumberId,
      message: approved.message,
    });
    if (current.preview.phoneNumber !== approved.phoneNumber || current.preview.testNumber !== approved.testNumber) {
      throw new Error('Sandbox recipient changed; review and confirm again');
    }
    const data = await this.#post(
      `/applications/${encodeURIComponent(approved.applicationId)}/sandbox/messages/test`,
      { testNumberId: approved.testNumberId, messageType: 'CUSTOM', message: approved.message },
    );
    if (!data || data.testNumberId !== approved.testNumberId || data.to !== approved.phoneNumber) {
      throw new Error('Gateway sandbox send outcome is unknown. Check sandbox history before retrying.');
    }
    return {
      status: 'accepted_by_gateway',
      applicationId: approved.applicationId,
      testNumberId: data.testNumberId,
      to: data.to,
      messageId: data.messageId ?? null,
      elapsedMs: data.elapsedMs,
      deliveryConfirmed: false,
    };
  }

  async prepareSandboxTemplate({ appId, testNumberId, sourceId, parameters }) {
    assertIdentifier(appId, 'appId');
    assertUuid(testNumberId, 'testNumberId');
    assertIdentifier(sourceId, 'sourceId');
    const numbers = await this.listTestNumbers(appId);
    const number = numbers.find((item) => item.id === testNumberId && item.appId === appId);
    if (!number) throw new Error('Test number not found in this application');
    const template = await this.getWhatsappTemplate(appId, sourceId);
    if (template.status !== 'APPROVED') throw new Error('Only APPROVED templates can be sent');
    assertUuid(template.id, 'template.id');
    if (!Array.isArray(template.components) || template.components.length === 0) {
      throw new Error('Template components are unavailable; cannot safely preview a send');
    }
    const validatedParameters = validateTemplateParameters(template, parameters);
    return {
      status: 'not_sent',
      preview: {
        applicationId: appId,
        testNumberId,
        testNumber: number.title,
        phoneNumber: number.phoneNumber,
        template: {
          id: template.id,
          sourceId: template.sourceId,
          name: template.name,
          language: template.language,
          category: template.category,
          status: template.status,
          components: template.components,
        },
        parameters: validatedParameters,
      },
      nextStep: 'Show this exact template, recipient and parameters to the user. After explicit approval, call send_sandbox_template; a native confirmation is also required.',
    };
  }

  async sendSandboxTemplate(prepared) {
    if (prepared?.status !== 'not_sent') throw new Error('A confirmed sandbox template preview is required');
    const approved = prepared.preview;
    const current = await this.prepareSandboxTemplate({
      appId: approved.applicationId,
      testNumberId: approved.testNumberId,
      sourceId: approved.template.sourceId,
      parameters: approved.parameters,
    });
    if (JSON.stringify(current.preview) !== JSON.stringify(approved)) {
      throw new Error('Sandbox template or recipient changed; review and confirm again');
    }
    const data = await this.#post(
      `/applications/${encodeURIComponent(approved.applicationId)}/sandbox/messages/test`,
      {
        testNumberId: approved.testNumberId,
        messageType: 'TEMPLATE',
        templateId: approved.template.id,
        ...(Object.keys(approved.parameters).length ? { parameters: approved.parameters } : {}),
      },
    );
    if (!data || data.testNumberId !== approved.testNumberId || data.to !== approved.phoneNumber || data.messageType !== 'TEMPLATE') {
      throw new Error('Gateway sandbox template send outcome is unknown. Check sandbox history before retrying.');
    }
    return {
      status: 'accepted_by_gateway',
      applicationId: approved.applicationId,
      testNumberId: data.testNumberId,
      to: data.to,
      templateId: approved.template.id,
      templateName: approved.template.name,
      language: approved.template.language,
      messageId: data.messageId ?? null,
      elapsedMs: data.elapsedMs,
      deliveryConfirmed: false,
    };
  }

  async preparePanelAction(action, args) {
    let preview;
    let request;
    if (action === 'rename_application' || action === 'update_application_contact' || action === 'set_whatsapp_username') {
      const app = await this.#getOwnedApplicationDetail(args.appId);
      const platform = app.channel?.platform;
      if (!['whatsapp', 'instagram'].includes(platform)) throw new Error('Application platform is unavailable; cannot safely choose an update route');
      const path = `/channels/${platform}/applications/${encodeURIComponent(args.appId)}`;
      if (action === 'rename_application') {
        const applicationName = assertNonEmptyString(args.applicationName, 'applicationName', 100);
        preview = { applicationId: args.appId, platform, before: { applicationName: app.displayName }, after: { applicationName } };
        request = { method: 'PATCH', path, body: { applicationName } };
      } else if (action === 'update_application_contact') {
        const contact = args.contact;
        if (!contact || typeof contact !== 'object' || Array.isArray(contact) || !Object.keys(contact).length || Object.keys(contact).some((key) => !['name', 'email', 'phoneNumber'].includes(key))) {
          throw new Error('contact must contain only name, email and/or phoneNumber');
        }
        const update = {};
        for (const [key, value] of Object.entries(contact)) update[key] = assertNonEmptyString(value, `contact.${key}`, 200);
        if (update.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(update.email)) throw new Error('contact.email is invalid');
        if (update.phoneNumber && !/^\+[1-9]\d{6,14}$/.test(update.phoneNumber)) throw new Error('contact.phoneNumber must be E.164');
        preview = { applicationId: args.appId, platform, before: { contact: app.contact ?? null }, after: { contact: update } };
        request = { method: 'PATCH', path, body: { contact: update } };
      } else {
        if (platform !== 'whatsapp') throw new Error('Business username is available only for WhatsApp applications');
        if (typeof args.username !== 'string' || args.username.length > 50 || /[\r\n\0]/.test(args.username)) throw new Error('username is invalid');
        preview = { applicationId: args.appId, platform, before: { username: app.channel.businessUsername ?? null }, after: { username: args.username } };
        request = { method: 'PATCH', path, body: { username: args.username } };
      }
    } else if (action === 'update_test_number' || action === 'delete_test_number') {
      assertUuid(args.testNumberId, 'testNumberId');
      const numbers = await this.listTestNumbers(args.appId);
      const number = numbers.find((item) => item.id === args.testNumberId && item.appId === args.appId);
      if (!number) throw new Error('Test number not found in this application');
      const path = `/applications/${encodeURIComponent(args.appId)}/sandbox/test-numbers/${encodeURIComponent(args.testNumberId)}`;
      if (action === 'update_test_number') {
        const title = assertNonEmptyString(args.title, 'title', 50);
        preview = { applicationId: args.appId, before: number, after: { ...number, title } };
        request = { method: 'PATCH', path, body: { title } };
      } else {
        preview = { applicationId: args.appId, delete: number };
        request = { method: 'DELETE', path };
      }
    } else if (action === 'add_allowed_origin' || action === 'delete_allowed_origin') {
      const origin = assertOrigin(args.origin);
      const { origins } = await this.getAllowedOrigins();
      const exists = origins.includes(origin);
      if (action === 'add_allowed_origin' && exists) return { status: 'unchanged', action, origin };
      if (action === 'delete_allowed_origin' && !exists) return { status: 'unchanged', action, origin };
      preview = { origin, before: { allowed: exists }, after: { allowed: !exists } };
      request = { method: action === 'add_allowed_origin' ? 'POST' : 'DELETE', path: '/organizations/allowed-origins', body: { origin } };
    } else if (action === 'delete_whatsapp_template') {
      const template = await this.getWhatsappTemplate(args.appId, args.sourceId);
      preview = { applicationId: args.appId, delete: template };
      request = { method: 'DELETE', path: `/channels/whatsapp/applications/${encodeURIComponent(args.appId)}/templates/${encodeURIComponent(args.sourceId)}` };
    } else if (action === 'create_whatsapp_template' || action === 'update_whatsapp_template') {
      await this.#requireApplication(args.appId);
      const body = args.template;
      if (!body || typeof body !== 'object' || Array.isArray(body) || !body.body || typeof body.body !== 'object') {
        throw new Error('Template content and body are required');
      }
      const basePath = `/channels/whatsapp/applications/${encodeURIComponent(args.appId)}/templates`;
      if (action === 'create_whatsapp_template') {
        assertIdentifier(body.name, 'template.name');
        if (typeof body.language !== 'string' || !/^[A-Za-z_]{2,20}$/.test(body.language)) throw new Error('Invalid template language');
        if (!['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(body.category)) throw new Error('Invalid template category');
        preview = { applicationId: args.appId, create: body };
        request = { method: 'POST', path: basePath, body };
      } else {
        const current = await this.getWhatsappTemplate(args.appId, args.sourceId);
        preview = { applicationId: args.appId, before: current, after: body };
        request = { method: 'POST', path: `${basePath}/${encodeURIComponent(args.sourceId)}`, body };
      }
    } else if (action === 'upsert_webhook' || action === 'delete_webhook' || action === 'test_webhook') {
      const webhook = await this.getWebhookStatus(args.appId);
      const path = `/applications/${encodeURIComponent(args.appId)}/webhook`;
      if (action === 'upsert_webhook') {
        const update = {};
        if (args.url !== undefined) update.url = assertHttpsUrl(args.url, 'webhook.url');
        if (args.subscribedEvents !== undefined) {
          if (!args.subscribedEvents || typeof args.subscribedEvents !== 'object' || Array.isArray(args.subscribedEvents) || !Object.keys(args.subscribedEvents).length || Object.entries(args.subscribedEvents).some(([key, value]) => !['messages', 'message_status', 'message_template_status', 'read', 'account'].includes(key) || typeof value !== 'boolean')) {
            throw new Error('Unsupported webhook subscribedEvents');
          }
          update.subscribedEvents = args.subscribedEvents;
        }
        if (!Object.keys(update).length || (!webhook.configured && !update.url)) throw new Error('A new webhook requires an HTTPS URL');
        preview = { applicationId: args.appId, before: webhook, after: update, headers: 'existing headers remain unchanged; new webhook has no custom headers' };
        request = { method: 'POST', path, body: update };
      } else if (action === 'delete_webhook') {
        if (!webhook.configured) return { status: 'unchanged', action, applicationId: args.appId };
        preview = { applicationId: args.appId, delete: webhook };
        request = { method: 'DELETE', path };
      } else {
        if (!webhook.configured) throw new Error('Webhook is not configured for this application');
        preview = { applicationId: args.appId, test: webhook };
        request = { method: 'POST', path: `${path}/test` };
      }
    } else if (action === 'test_sandbox_webhook') {
      await this.#requireApplication(args.appId);
      const targetUrl = assertHttpsUrl(args.targetUrl, 'targetUrl');
      if (typeof args.payload !== 'string' || !args.payload.trim() || args.payload.length > 10000) throw new Error('payload must be JSON of at most 10000 characters');
      try { JSON.parse(args.payload); } catch { throw new Error('payload must be valid JSON'); }
      preview = { applicationId: args.appId, targetUrl, payload: args.payload };
      request = { method: 'POST', path: `/applications/${encodeURIComponent(args.appId)}/sandbox/webhook/test`, body: { targetUrl, payload: args.payload } };
    } else if (action === 'update_whatsapp_business_profile') {
      const current = await this.getWhatsappBusinessProfile(args.appId);
      const update = args.profile;
      const allowed = ['about', 'address', 'description', 'email', 'category', 'websites', 'profilePictureReference'];
      if (!update || typeof update !== 'object' || Array.isArray(update) || !Object.keys(update).length || Object.keys(update).some((key) => !allowed.includes(key))) throw new Error('Unsupported business profile fields');
      for (const [key, value] of Object.entries(update)) {
        if (value === null) continue;
        if (key === 'websites') {
          if (!Array.isArray(value) || value.length > 2) throw new Error('websites must be a list of at most two URLs');
          value.forEach((website) => assertHttpsUrl(website, 'website'));
        } else if (typeof value !== 'string' || value.length > 1000) throw new Error(`${key} must be text or null`);
      }
      preview = { applicationId: args.appId, before: current, after: update };
      request = { method: 'PATCH', path: `/channels/whatsapp/applications/${encodeURIComponent(args.appId)}/profile`, body: update };
    } else if (action === 'upsert_billing_account') {
      const current = await this.getBillingAccount();
      const account = args.account;
      const required = ['legalAddress', 'taxNumber', 'taxOffice', 'companyName', 'companyLegalTitle', 'vatNumber'];
      const allowed = [...required, 'additionalNote', 'city', 'country'];
      if (!account || typeof account !== 'object' || Array.isArray(account) || Object.keys(account).some((key) => !allowed.includes(key))) throw new Error('Unsupported billing account fields');
      for (const key of required) assertNonEmptyString(account[key], `account.${key}`, 500);
      for (const [key, value] of Object.entries(account)) {
        if (value !== null && (typeof value !== 'string' || value.length > 500)) throw new Error(`account.${key} is invalid`);
      }
      preview = { before: current, after: account };
      request = { method: 'PUT', path: '/billing/account', body: account };
    } else if (action === 'delete_api_key') {
      assertUuid(args.keyId, 'keyId');
      let key;
      for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
        const page = await this.listApiKeyMetadata(args.appId, pageNumber, 100);
        key = page.items.find((item) => item.id === args.keyId && item.appId === args.appId);
        if (key || !page.pagingMetadata?.hasNext) break;
      }
      if (!key) throw new Error('API key not found in this application');
      preview = { applicationId: args.appId, delete: key };
      request = { method: 'DELETE', path: `/applications/${encodeURIComponent(args.appId)}/api-keys/${encodeURIComponent(args.keyId)}` };
    } else if (action === 'create_api_key') {
      const app = await this.getApplication(args.appId);
      const name = assertNonEmptyString(args.name, 'name', 100);
      const body = { name };
      for (const field of ['dailyLimit', 'concurrencyLimit']) {
        const value = args[field];
        if (value !== undefined) {
          if (!Number.isInteger(value) || value < 1 || value > 1000000) throw new Error(`${field} must be 1-1000000`);
          body[field] = value;
        }
      }
      if (args.expiresAt !== undefined) {
        if (typeof args.expiresAt !== 'string' || Number.isNaN(Date.parse(args.expiresAt)) || Date.parse(args.expiresAt) <= Date.now()) throw new Error('expiresAt must be a future timestamp');
        body.expiresAt = args.expiresAt;
      }
      preview = { applicationId: args.appId, applicationName: app.displayName, create: { ...body, secretDisclosure: 'shown only in a local native dialog, never returned to the AI client' } };
      request = { method: 'POST', path: `/applications/${encodeURIComponent(args.appId)}/api-keys`, body };
    } else if (action === 'create_organization_secret') {
      const name = assertNonEmptyString(args.name, 'name', 100);
      if (!['PUBLISHABLE', 'SECRET'].includes(args.type)) throw new Error('Unsupported organization secret type');
      if (args.type === 'PUBLISHABLE' && args.expiresAt != null) throw new Error('Publishable keys cannot have an expiry');
      if (args.expiresAt != null && (typeof args.expiresAt !== 'string' || Number.isNaN(Date.parse(args.expiresAt)) || Date.parse(args.expiresAt) <= Date.now())) {
        throw new Error('expiresAt must be a future timestamp');
      }
      const currentSecrets = await this.listOrganizationSecretsMetadata();
      const body = { name, type: args.type, expiresAt: args.expiresAt ?? null };
      preview = { currentSecrets, create: { ...body, secretDisclosure: 'shown only in a local native dialog, never returned to the AI client' } };
      request = { method: 'POST', path: '/organization-secrets', body };
    } else {
      throw new Error('Unsupported panel action');
    }
    return { status: 'ready', action, args, preview, request };
  }

  async executePanelAction(prepared) {
    if (prepared?.status !== 'ready') throw new Error('A confirmed panel action preview is required');
    const current = await this.preparePanelAction(prepared.action, prepared.args);
    if (current.status !== 'ready' || JSON.stringify(current.preview) !== JSON.stringify(prepared.preview) || JSON.stringify(current.request) !== JSON.stringify(prepared.request)) {
      throw new Error('Panel data changed; review and confirm the action again');
    }
    const response = await this.#requestResponse(prepared.request.path, {
      method: prepared.request.method,
      body: prepared.request.body,
    });
    if (prepared.action === 'create_api_key') {
      const data = requireRecord(response.data, 'created API key');
      if (data.appId !== prepared.args.appId || typeof data.id !== 'string' || typeof data.key !== 'string' || !data.key) {
        throw new Error('API key creation outcome is unknown. Check the panel before retrying.');
      }
      return {
        status: 'created', action: prepared.action,
        key: data.key,
        metadata: { id: data.id, appId: data.appId, name: data.name, dailyLimit: data.dailyLimit, concurrencyLimit: data.concurrencyLimit, expiresAt: data.expiresAt },
      };
    }
    if (prepared.action === 'create_organization_secret') {
      const data = requireRecord(response.data, 'created organization secret');
      if (typeof data.id !== 'string' || data.name !== prepared.request.body.name || data.type !== prepared.request.body.type) {
        throw new Error('Organization secret creation outcome is unknown. Check the panel before retrying.');
      }
      let secret = typeof data.key === 'string' && !/[\*\u2022\u2026]/.test(data.key) ? data.key : null;
      if (!secret && data.type === 'SECRET') {
        try {
          const revealed = requireRecord((await this.#requestResponse(`/organization-secrets/${encodeURIComponent(data.id)}/reveal`, { method: 'POST' })).data, 'revealed organization secret');
          if (revealed.id === data.id && typeof revealed.key === 'string' && !/[\*\u2022\u2026]/.test(revealed.key)) secret = revealed.key;
        } catch {
          // Creation succeeded. Reveal failure cannot be treated as a failed create or retried automatically.
        }
      }
      return {
        status: 'created', action: prepared.action, secret,
        metadata: { id: data.id, name: data.name, type: data.type, status: data.status, expiresAt: data.expiresAt },
      };
    }
    if (prepared.action === 'create_whatsapp_template' || prepared.action === 'update_whatsapp_template') {
      const data = requireRecord(response.data, 'template write');
      return {
        status: 'submitted_to_gateway', action: prepared.action,
        applicationId: prepared.args.appId,
        template: { sourceId: data.sourceId, name: data.name, language: data.language, category: data.category, status: data.status },
        approvalByMetaConfirmed: false,
      };
    }
    return { status: 'applied', action: prepared.action, preview: prepared.preview, outcomeConfirmedByGateway: true };
  }
}
