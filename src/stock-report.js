const { serviceError } = require('./service-error');
const endpoint = '/api/v1/stock-analytics';
const catalogEndpoint = '/api/v2/Product/variant';
const fail = reason => serviceError('ShipX', endpoint, reason);
const integer = Number.isSafeInteger;
const clean = value => String(value ?? '').replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 150).toWellFormed();

async function stockOverview(client, companyId, cancel) {
  if (!integer(companyId) || companyId <= 0) throw new Error('Company scope required');
  if (client.config.demo) {
    const items = companyId === 101 ? [
      { sku: 'SKU001', name: 'กล่องตัวอย่าง', ready: 128, reorderPoint: 40 },
      { sku: 'SKU002', name: 'ซองพัสดุ', ready: 12, reorderPoint: 20 },
      { sku: 'SKU003', name: 'เทปแพ็คสินค้า', ready: 0, reorderPoint: 10 },
    ] : [];
    return summarize(items);
  }
  const timeout = AbortSignal.timeout(20000), signal = cancel ? AbortSignal.any([timeout, cancel]) : timeout;
  const owned = new Map(), items = [], seen = new Set();
  let complete = false;
  for (let page = 1; page <= 50; page++) {
    const { data } = await client.get(catalogEndpoint, { companyIds: companyId, includeProductMaster: true, pageNumber: page, pageSize: 100 }, signal);
    if (!Array.isArray(data?.variants) || !integer(data.totalPages) || data.totalPages < 0 || data.pageNumber !== page) throw fail('catalog_response_not_verified');
    for (const item of data.variants) {
      const v = item?.variant, m = item?.productMaster;
      if (m?.companyId !== companyId || !integer(v?.productVariantId) || v.productVariantId <= 0 ||
          !integer(m.productMasterId) || m.productMasterId !== v.productMasterId || typeof v.sku !== 'string' || owned.has(v.productVariantId)) throw fail('catalog_company_not_verified');
      owned.set(v.productVariantId, { masterId: m.productMasterId, sku: v.sku });
    }
    if (page >= data.totalPages) { complete = true; break; }
  }
  if (!complete) throw fail('catalog_scan_limit');
  complete = false;
  let expectedTotal;
  for (let page = 1; page <= 50; page++) {
    const json = await client.get(endpoint, { companyIds: companyId, pageNumber: page, pageSize: 100 }, signal);
    const data = Array.isArray(json.items) ? json : json.data, p = data?.pagination;
    if (!Array.isArray(data?.items) || !integer(p?.totalPages) || p.totalPages < 0 || p.currentPage !== page || data.items.length > 100) throw fail('stock_response_not_verified');
    if (p.totalCount != null) {
      if (!integer(p.totalCount) || p.totalCount < 0 || (expectedTotal != null && expectedTotal !== p.totalCount)) throw fail('stock_count_changed');
      expectedTotal = p.totalCount;
    }
    for (const row of data.items) {
      const owner = owned.get(row?.productVariantId);
      if (!owner || owner.masterId !== row.productMasterId || owner.sku.toUpperCase() !== String(row.sku).toUpperCase() ||
          (row.companyId != null && row.companyId !== companyId) || seen.has(row.productVariantId) || !integer(row.currentStock)) throw fail('stock_identity_not_verified');
      if (row.reorderPoint != null && (!integer(row.reorderPoint) || row.reorderPoint < 0)) throw fail('reorder_point_not_verified');
      seen.add(row.productVariantId);
      items.push({ sku: clean(row.sku), name: clean(row.variantName || row.productMasterName), ready: row.currentStock,
        reorderPoint: row.reorderPoint ?? null });
    }
    if (page >= p.totalPages) { complete = true; break; }
  }
  if (!complete || (expectedTotal != null && expectedTotal !== items.length)) throw fail('stock_complete_scan_not_verified');
  return summarize(items);
}
function summarize(items) {
  const reorder = items.filter(i => i.reorderPoint !== null && i.ready <= i.reorderPoint)
    .sort((a, b) => a.ready - b.ready || a.sku.localeCompare(b.sku));
  return { totalSkus: items.length, readySkus: items.filter(i => i.ready > 0).length,
    outOfStockSkus: items.filter(i => i.ready <= 0).length, reorderSkus: reorder.length,
    missingThresholdSkus: items.filter(i => i.reorderPoint === null).length, items, reorder };
}
module.exports = { stockOverview };
