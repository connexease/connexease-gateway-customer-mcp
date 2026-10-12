const SECURITY_CENTER_URL = 'https://business.facebook.com/settings/security';
const VERIFICATION_NOTE = 'Business verification durumu kesin olarak okunamıyor.';

const unknown = () => ({ status: 'unknown', value: null });

function metric(value) {
  if (!value || typeof value !== 'object') return unknown();
  const status = {
    success: 'ok', warning: 'warning', danger: 'action_required', neutral: 'unknown',
  }[value.severity] ?? 'unknown';
  return { status, value: value.value ?? null, display: value.display ?? null };
}

function reviewStatus(value) {
  if (typeof value !== 'string') return unknown();
  const status = {
    APPROVED: 'ok', PENDING: 'warning', REJECTED: 'action_required', DISABLED: 'action_required',
  }[value] ?? 'unknown';
  return { status, value };
}

function messagingLimit(value) {
  if (!value || typeof value !== 'object') return unknown();
  const tier = value.tier ?? null;
  if (tier === 'TIER_250') {
    return {
      status: 'warning', value: tier, display: value.display ?? null,
      inference: 'İşletme doğrulanmamış olabilir; bu limit tek başına doğrulama kanıtı değildir.',
    };
  }
  const status = tier && tier !== 'TIER_NOT_SET' ? 'ok' : 'unknown';
  return { status, value: tier, display: value.display ?? null };
}

function businessProfile(value) {
  if (!value?.configured || !value.profile) {
    return { status: value?.configured === false ? 'warning' : 'unknown', fields: null, missing: ['websites', 'email', 'address', 'description'] };
  }
  const { websites, email, address, description } = value.profile;
  const fields = {
    websites: Array.isArray(websites) && websites.some((site) => typeof site === 'string' && site.trim().length > 0),
    email: typeof email === 'string' && email.trim().length > 0,
    address: typeof address === 'string' && address.trim().length > 0,
    description: typeof description === 'string' && description.trim().length > 0,
  };
  const missing = Object.keys(fields).filter((field) => !fields[field]);
  return { status: missing.length ? 'warning' : 'ok', fields, missing };
}

export async function checkWhatsappAccountReadiness(gateway, appId) {
  const [application, health, profile] = await Promise.allSettled([
    gateway.getApplication(appId),
    gateway.getWhatsappHealth(appId),
    gateway.getWhatsappBusinessProfile(appId),
  ]);
  const checks = {
    accountReviewStatus: application.status === 'fulfilled'
      ? reviewStatus(application.value.channel?.accountReviewStatus) : unknown(),
    accountStatus: health.status === 'fulfilled' ? metric(health.value.accountStatus) : unknown(),
    messagingLimit: health.status === 'fulfilled' ? messagingLimit(health.value.messagingLimit) : unknown(),
    nameStatus: health.status === 'fulfilled' ? metric(health.value.nameStatus) : unknown(),
    phoneQuality: health.status === 'fulfilled' ? metric(health.value.phoneQuality) : unknown(),
    codeVerificationStatus: health.status === 'fulfilled' ? metric(health.value.codeVerificationStatus) : unknown(),
    businessProfile: profile.status === 'fulfilled' ? businessProfile(profile.value) : { status: 'unknown', fields: null, missing: [] },
  };
  const nextSteps = [];
  if (checks.accountReviewStatus.status === 'action_required' || checks.accountStatus.status === 'action_required') {
    nextSteps.push('Meta Business Manager üzerinden WhatsApp hesap kısıtlamalarını inceleyin.');
  }
  if (checks.nameStatus.status === 'action_required') nextSteps.push('Reddedilen görünen adı Meta üzerinden düzeltip yeniden incelemeye gönderin.');
  if (checks.codeVerificationStatus.status === 'action_required' || checks.codeVerificationStatus.status === 'warning') {
    nextSteps.push('WhatsApp telefon numarası doğrulamasını kontrol edin.');
  }
  if (checks.businessProfile.status === 'warning') nextSteps.push(`Business profilindeki eksik alanları tamamlayın: ${checks.businessProfile.missing.join(', ')}.`);
  if (checks.messagingLimit.value === 'TIER_250') nextSteps.push('İşletme doğrulama durumunu Meta Business Manager → Security Center üzerinden ayrıca kontrol edin.');
  if (Object.values(checks).some((check) => check.status === 'unknown')) {
    nextSteps.push('Okunamayan kontrolleri Gateway panelinde ve Meta Business Manager’da doğrulayın.');
  }
  const overallStatus = Object.values(checks).some((check) => check.status === 'action_required') ? 'action_required'
    : Object.values(checks).some((check) => check.status === 'warning') ? 'warning'
      : Object.values(checks).every((check) => check.status === 'ok') ? 'ok' : 'unknown';
  return {
    appId, overallStatus, checks, nextSteps,
    businessVerification: { status: 'unknown', note: VERIFICATION_NOTE, securityCenterUrl: SECURITY_CENTER_URL },
  };
}
