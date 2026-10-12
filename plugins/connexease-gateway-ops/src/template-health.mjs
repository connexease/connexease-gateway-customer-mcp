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

// Meta sets previousCategory after it has recategorized a template and correctCategory for the
// category it will apply next, so each field is compared with the current category on its own.
function categoryChangesOf(template) {
  const changes = [];
  const base = { sourceId: template.sourceId, name: template.name, language: template.language };
  if (template.previousCategory && template.previousCategory !== template.category) {
    changes.push({ ...base, change: 'applied', from: template.previousCategory, to: template.category });
  }
  if (template.correctCategory && template.correctCategory !== template.category) {
    changes.push({ ...base, change: 'pending', from: template.category, to: template.correctCategory });
  }
  return changes;
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
  const categoryChanges = filtered.flatMap(categoryChangesOf);
  // The Gateway template list currently omits qualityScore; an empty low-quality list then means "unknown", not "none".
  const qualityMissing = filtered.length > 0 && !filtered.some((template) => typeof template.qualityScore === 'string' && template.qualityScore);
  return {
    appId,
    filters: { status: status ?? null, category: category ?? null },
    scannedCount: all.length,
    matchedCount: filtered.length,
    truncated: all.length === MAX_TEMPLATES && hasNext,
    statusCounts,
    qualityDistribution,
    qualityNote: qualityMissing
      ? "Kalite skoru Gateway liste API'sinden gelmiyor; düşük kaliteli template listesi bu yüzden boş olabilir."
      : null,
    lowQualityTemplates,
    rejectedTemplates,
    categoryChanges,
    categoryDistribution: countBy(filtered, 'category'),
    languageDistribution: countBy(filtered, 'language'),
    note: 'Bu özet template durumunu ve kalitesini gösterir; tek tek template gönderilme, okunma veya tıklanma metriklerini içermez.',
  };
}
