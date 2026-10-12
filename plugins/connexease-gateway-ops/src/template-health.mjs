const PAGE_SIZE = 100;
const MAX_TEMPLATES = 1000;
const STATUSES = ['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED'];

function countBy(items, field) {
  const counts = {};
  for (const item of items) {
    const key = typeof item[field] === 'string' && item[field] ? item[field] : 'UNKNOWN';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function hasNextPage(page, pageNumber) {
  const paging = page.pagingMetadata;
  if (typeof paging?.hasNext === 'boolean') return paging.hasNext;
  if (Number.isInteger(paging?.totalPages)) return pageNumber < paging.totalPages;
  return page.items.length === PAGE_SIZE;
}

export async function getTemplateHealthSummary(gateway, { appId, status, category } = {}) {
  if (status !== undefined && !STATUSES.includes(status)) throw new Error('Unsupported template status filter');
  if (category !== undefined && !['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(category)) {
    throw new Error('Unsupported template category filter');
  }
  const all = [];
  let pageNumber = 1;
  let hasNext = false;
  while (all.length < MAX_TEMPLATES) {
    const page = await gateway.listWhatsappTemplates(appId, pageNumber, PAGE_SIZE);
    if (!page || !Array.isArray(page.items)) throw new Error('Gateway returned an invalid template page');
    if (page.items.length === 0 && pageNumber > 1 && hasNext) throw new Error('Gateway template pagination ended unexpectedly');
    all.push(...page.items.slice(0, MAX_TEMPLATES - all.length));
    hasNext = hasNextPage(page, pageNumber);
    if (!hasNext) break;
    pageNumber += 1;
  }
  const filtered = all.filter((template) =>
    (status === undefined || template.status === status) &&
    (category === undefined || template.category === category));
  const statusCounts = Object.fromEntries(STATUSES.map((value) => [value, 0]));
  for (const template of filtered) {
    statusCounts[template.status] = (statusCounts[template.status] ?? 0) + 1;
  }
  const qualityDistribution = countBy(filtered, 'qualityScore');
  const rejectedTemplates = filtered.filter((template) => template.status === 'REJECTED').map((template) => ({
    sourceId: template.sourceId, name: template.name, language: template.language,
    rejectedReason: template.rejectedReason ?? null,
  }));
  const lowQualityTemplates = filtered.filter((template) => ['RED', 'YELLOW'].includes(String(template.qualityScore).toUpperCase())).map((template) => ({
    sourceId: template.sourceId, name: template.name, qualityScore: template.qualityScore,
  }));
  const categoryChanges = filtered.filter((template) => template.previousCategory && template.correctCategory && template.previousCategory !== template.correctCategory).map((template) => ({
    sourceId: template.sourceId, name: template.name,
    previousCategory: template.previousCategory, correctCategory: template.correctCategory,
  }));
  return {
    appId,
    filters: { status: status ?? null, category: category ?? null },
    scannedCount: all.length,
    matchedCount: filtered.length,
    truncated: all.length === MAX_TEMPLATES && hasNext,
    statusCounts,
    qualityDistribution,
    lowQualityTemplates,
    rejectedTemplates,
    categoryChanges,
    categoryDistribution: countBy(filtered, 'category'),
    languageDistribution: countBy(filtered, 'language'),
    note: 'Bu özet template durumunu ve kalitesini gösterir; tek tek template gönderilme, okunma veya tıklanma metriklerini içermez.',
  };
}
