const { orderStatus } = require('./status');
const { REFERENCE } = require('./intent');
const SEARCH_ENDPOINT = '/api/v2/Order/search';
const COMPANY_ENDPOINT = '/api/v1/Company/GetListCompany';
const VARIANT_ENDPOINT = '/api/v2/Product/variant';
const STOCK_ENDPOINT = '/api/v1/stock-analytics';
const DAILY_ENDPOINT = '/api/v2/Report/daily';
const SALES_ENDPOINT = '/api/v2/Report/order/summary';
const SHIPPING_ENDPOINT = '/api/v3/Order/list/order-platform';
const SHIPPING_HISTORY_ENDPOINT = '/api/v2/Order/summaryPlatform/history';
const SHIPPED_STATUSES = [2005, 4001, 4002];
const UNPACKED_STATUSES = [1001, 1003, 2001, 2002, 3003, 3004];
const CLOSED_SHIPPING_STATUSES = [3001, 5001, 5002, ...SHIPPED_STATUSES];
const DEMO_ORDERS = [
  { companyId: 101, orderId: 1001, orderDocumentNo: 'SO001', movementCode: 'MV001', platformOrderId: '250001', status: 2002, trackingNumber: 'TH0123456789', shippingCarrier: 'ตัวอย่างขนส่ง' },
  { companyId: 101, orderId: 1002, orderDocumentNo: 'SO002', movementCode: 'MV002', status: 5002, trackingNumber: 'TH0987654321', shippingCarrier: 'ตัวอย่างขนส่ง' },
  { companyId: 202, orderId: 2001, orderDocumentNo: 'SO999', status: 1003 },
];
function isCompanyId(value) { return Number.isSafeInteger(value) && value > 0 && value <= 2147483647; }
function sameReference(a, b) { return typeof a === 'string' && a.toUpperCase() === b.toUpperCase(); }
function exactMatch(order, reference) {
  return ['orderDocumentNo', 'movementCode', 'platformOrderId', 'trackingNumber', 'orderId']
    .some(key => order[key] != null && String(order[key]).toUpperCase() === reference.toUpperCase());
}
function safeText(value, max = 150) { return String(value ?? '').replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, max).toWellFormed(); }
function publicOrder(order) {
  const documented = orderStatus(order.status);
  const description = typeof order.statusDescription === 'string' ? order.statusDescription.trim() : '';
  return {
    orderNo: safeText(order.orderDocumentNo || order.movementCode || order.orderId),
    status: documented.bucket !== 'unknown' ? documented.label :
      (/\p{Script=Thai}/u.test(description) && !/^รหัสสถานะ\s*\d*$/u.test(description) ? safeText(description) : documented.label),
    tracking: safeText(order.trackingNumber), carrier: safeText(order.shippingCarrier || order.shopeeOrderShippingCarrier),
  };
}
const count = value => Number.isSafeInteger(value) && value >= 0;
function verifiedCompany(report, companyId) {
  if (!Array.isArray(report?.appliedCompanyIds) || report.appliedCompanyIds.length !== 1 || report.appliedCompanyIds[0] !== companyId) {
    throw new Error('ShipX report company scope not verified');
  }
}
const bangkokDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' });
function reportDates(days, now = new Date(), offset = 0) {
  if ((days !== 1 && days !== 3) || !count(offset) || days + offset > 3) throw new Error('Unsupported report period');
  const today = Date.parse(bangkokDay.format(now) + 'T00:00:00Z');
  return Array.from({ length: days }, (_, i) => new Date(today - (offset + i) * 86400000).toISOString().slice(0, 10));
}
function echoedDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return null;
  const zoned = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
  const ts = Date.parse(zoned || value.length === 10 ? value : value + 'Z');
  if (!Number.isFinite(ts)) return null;
  return zoned ? bangkokDay.format(ts) : value.slice(0, 10);
}
function scanTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return NaN;
  return Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? value : value + '+07:00');
}
function shippingChannel(value) {
  const key = typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s_-]+/g, '') : '';
  if (key === 'shopee' || key === 'lazada' || key === 'tiktok') return key;
  return key === 'tiktokshop' ? 'tiktok' : 'other';
}
async function mapShippingHistory(items, get) {
  const results = [];
  // The API exposes order details by ID. Bound concurrent lookups against ShipX.
  for (let index = 0; index < items.length; index += 8) {
    results.push(...await Promise.all(items.slice(index, index + 8).map(get)));
  }
  return results;
}
function verifyDates(report, from, to) {
  if (echoedDay(report.fromDate) !== from || echoedDay(report.toDate) !== to) throw new Error('ShipX report dates not verified');
}
function dailySummary(date, total, statuses) {
  if (!count(total) || !Array.isArray(statuses)) throw new Error('Invalid daily report');
  const row = { date, total, unpacked: 0, awaitingShipment: 0, attention: 0, unknown: 0, complete: 0, pendingStatuses: [] };
  const seen = new Set();
  let sum = 0;
  for (const status of statuses) {
    const code = status?.statusCode, n = status?.count;
    if (!Number.isSafeInteger(code) || !count(n) || seen.has(code) || !count(sum + n) || sum + n > total) throw new Error('Invalid status breakdown');
    seen.add(code); sum += n;
    const { label, bucket } = orderStatus(code);
    row[bucket] += n;
    if (n && ['unpacked', 'awaitingShipment', 'attention'].includes(bucket)) row.pendingStatuses.push({ label, count: n });
  }
  row.unknown += total - sum;
  return row;
}
class ShipXClient {
  constructor(config, fetcher = fetch) { this.config = config; this.fetcher = fetcher; }
  async request(endpoint, params, signal, body) {
    const url = new URL(endpoint, this.config.shipxBaseUrl);
    for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, String(value));
    const headers = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (this.config.shipxApiKey) headers['X-API-Key'] = this.config.shipxApiKey;
    if (this.config.shipxBearer) headers.Authorization = `Bearer ${this.config.shipxBearer}`;
    const response = await this.fetcher(url, { headers, method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: signal || AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`ShipX HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 5000000) throw new Error('ShipX response too large');
    const json = JSON.parse(text);
    if (!json || typeof json !== 'object') throw new Error('Invalid ShipX response');
    return json;
  }
  get(endpoint, params, signal) { return this.request(endpoint, params, signal); }
  async companies() {
    if (this.config.demo) return [{ id: 101, name: 'ABC Logistics' }, { id: 202, name: 'บริษัท สยามรีเทล จำกัด' }];
    const json = await this.get(COMPANY_ENDPOINT);
    if (!Array.isArray(json.data?.companies)) throw new Error('Unexpected Company response contract');
    return json.data.companies.filter(c => isCompanyId(c.companyId)).map(c => ({ id: c.companyId, name: safeText(c.companyName || c.companyId) }));
  }
  async findOrder(companyId, reference) {
    if (!isCompanyId(companyId)) throw new Error('Company scope required');
    if (typeof reference !== 'string' || !REFERENCE.test(reference)) throw new Error('Invalid order reference');
    if (this.config.demo) {
      const matches = DEMO_ORDERS.filter(o => o.companyId === companyId && exactMatch(o, reference));
      return { order: matches.length === 1 ? publicOrder(matches[0]) : null, outcome: matches.length > 1 ? 'ambiguous' : matches.length ? 'found' : 'not_found' };
    }
    const matches = new Map(), signal = AbortSignal.timeout(15000);
    for (let page = 1; page <= 5; page++) {
      const json = await this.get(SEARCH_ENDPOINT, { searchText: reference, companyIds: companyId, pageNumber: page, pageSize: 100 }, signal);
      if (!Array.isArray(json.data?.data) || typeof json.data.hasMore !== 'boolean') throw new Error('Unexpected Order search response contract');
      for (const order of json.data.data) {
        // Verify ownership even if the upstream filter is broken. Missing IDs fail closed.
        if (order && order.companyId === companyId && isCompanyId(order.companyId) && exactMatch(order, reference)) {
          if (!isCompanyId(order.orderId)) throw new Error('Order identity missing');
          matches.set(order.orderId, publicOrder(order));
        }
      }
      if (matches.size > 1) return { order: null, outcome: 'ambiguous' };
      if (!json.data.hasMore) return { order: matches.values().next().value || null, outcome: matches.size ? 'found' : 'not_found' };
    }
    return { order: null, outcome: 'search_limit' };
  }
  async findStock(companyId, reference) {
    if (!isCompanyId(companyId)) throw new Error('Company scope required');
    if (typeof reference !== 'string' || !REFERENCE.test(reference)) throw new Error('Invalid SKU');
    if (this.config.demo) {
      if (companyId !== 101 || !sameReference('SKU001', reference)) return { outcome: 'not_found' };
      return { outcome: 'found', stock: { sku: 'SKU001', name: 'กล่องตัวอย่าง ShipX', ready: 128 } };
    }
    const signal = AbortSignal.timeout(15000), matches = new Map();
    const pageSize = 100;
    for (let page = 1; page <= 5; page++) {
      const { data } = await this.get(VARIANT_ENDPOINT, { companyIds: companyId, searchTerm: reference, includeProductMaster: true, pageNumber: page, pageSize }, signal);
      if (!Array.isArray(data?.variants) || !count(data.totalPages) || data.pageNumber !== page) throw new Error('Unexpected Product response');
      for (const item of data.variants) {
        const v = item?.variant, m = item?.productMaster;
        if (!sameReference(v?.sku, reference)) continue;
        if (m?.companyId !== companyId) continue;
        if (!isCompanyId(v.productVariantId) || !isCompanyId(m.productMasterId) || m.productMasterId !== v.productMasterId) throw new Error('Product identity not verified');
        if (matches.has(v.productVariantId) && matches.get(v.productVariantId).masterId !== m.productMasterId) throw new Error('Conflicting product identity');
        matches.set(v.productVariantId, { masterId: m.productMasterId, sku: safeText(v.sku), name: safeText(v.variantName || m.name) });
      }
      if (matches.size > 1) return { outcome: 'ambiguous' };
      if (page >= data.totalPages) break;
      if (page === 5) return { outcome: 'search_limit' };
    }
    if (!matches.size) return { outcome: 'not_found' };
    const [[id, product]] = matches;
    let stock;
    for (let page = 1; page <= 5; page++) {
      const data = await this.get(STOCK_ENDPOINT, { companyIds: companyId, search: reference, pageNumber: page, pageSize }, signal);
      if (!Array.isArray(data.items) || !count(data.pagination?.totalPages) || data.pagination.currentPage !== page) throw new Error('Unexpected Stock response');
      for (const row of data.items) {
        if (row?.productVariantId !== id) continue;
        if (row.productMasterId !== product.masterId || !sameReference(row.sku, reference) ||
            (Object.hasOwn(row, 'companyId') && row.companyId !== companyId) ||
            !Number.isSafeInteger(row.currentStock) || stock) throw new Error('Stock identity or counts not verified');
        stock = { sku: product.sku, name: product.name, ready: row.currentStock };
      }
      if (page >= data.pagination.totalPages) return stock ? { outcome: 'found', stock } : { outcome: 'stock_unavailable' };
    }
    return { outcome: 'search_limit' };
  }
  async orderOverview(companyId, days, now, offset = 0) {
    if (!isCompanyId(companyId)) throw new Error('Company scope required');
    const dates = reportDates(days, now, offset);
    if (this.config.demo) {
      return dates.map((date, i) => {
        const demo = [[1003, 4], [2002, 2], [2004, 3], [3003, 1], [4002, 5], [5002, 1]].filter((_, j) => i !== 2 || j >= 4);
        const rows = companyId === 101 ? demo.map(([statusCode, count]) => ({ statusCode, count })) : [];
        return dailySummary(date, rows.reduce((n, r) => n + r.count, 0), rows);
      });
    }
    const signal = AbortSignal.timeout(12000);
    return Promise.all(dates.map(async date => {
      const report = await this.get(DAILY_ENDPOINT, { companyIds: companyId, fromDate: date + 'T00:00:00', toDate: date + 'T23:59:59.999' }, signal);
      verifiedCompany(report, companyId);
      verifyDates(report, date, date);
      return dailySummary(date, report.totalOrders, report.statusBreakdown);
    }));
  }
  async salesReport(companyId, days, now, offset = 0) {
    if (!isCompanyId(companyId)) throw new Error('Company scope required');
    const dates = reportDates(days, now, offset), from = dates.at(-1), to = dates[0];
    if (this.config.demo) return { from, to, totalOrders: companyId === 101 ? 12 * days : 0, totalItems: companyId === 101 ? 20 * days : 0, totalRevenue: companyId === 101 ? 1540 * days : 0 };
    const { data } = await this.get(SALES_ENDPOINT, { companyIds: companyId, fromDate: from, toDate: to }, AbortSignal.timeout(12000));
    verifiedCompany(data, companyId);
    verifyDates(data, from, to);
    if (!count(data.totalOrders) || !count(data.totalItems) || !Number.isFinite(data.totalRevenue)) throw new Error('Invalid sales report');
    return { from, to, totalOrders: data.totalOrders, totalItems: data.totalItems, totalRevenue: data.totalRevenue };
  }
  async ordersDueForShipping(companyId, date, cancel) {
    if (!isCompanyId(companyId)) throw new Error('Company scope required');
    if (!this.config.demo && !this.config.shippingDateIsDueDate) {
      throw Object.assign(new Error('Confirm the meaning of ShippingDate before enabling due-date reports'), { code: 'shipping_date_unconfirmed' });
    }
    let orders = [];
    if (this.config.demo) {
      orders = companyId === 101 ? [
        { orderId: 1, orderDocumentNo: 'SO001', status: 2002, shippingPlatform: 'Shopee' },
        { orderId: 2, orderDocumentNo: 'SO003', status: 1003, shippingPlatform: 'Lazada' },
        { orderId: 3, orderDocumentNo: 'SO004', status: 3004, shippingPlatform: 'TikTok Shop' },
        { orderId: 4, orderDocumentNo: 'SO005', status: 2003, orderType: 1 },
        { orderId: 5, orderDocumentNo: 'SO006', status: 2004, orderType: 1 },
        { orderId: 6, orderDocumentNo: 'SO007', status: 2005 },
        { orderId: 7, orderDocumentNo: 'SO008', status: 4002 },
        { orderId: 8, orderDocumentNo: 'SO009', status: 3001 },
        { orderId: 9, orderDocumentNo: 'SO010', status: 5002 },
        { orderId: 10, orderDocumentNo: 'SO011', status: 9999 },
      ].map(order => ({ orderType: 0, ...order })) : [];
    } else {
      const deadline = AbortSignal.timeout(14000), ids = new Set();
      const signal = cancel ? AbortSignal.any([deadline, cancel]) : deadline;
      let totalCount;
      // The V3 OpenAPI specifies the request, but omits the list response schema.
      // Accept only the established V2 paginated envelope; other shapes fail closed.
      for (let page = 1; ; page++) {
        const json = await this.request(SHIPPING_ENDPOINT, {}, signal, {
          companyIds: [companyId], shippingStartDate: date + 'T00:00:00+07:00', shippingEndDate: date + 'T23:59:59.999+07:00',
          pageNumber: page, pageSize: 100, sortBy: 'orderId', sortOrder: 'asc',
        });
        const data = json.data;
        if (!Array.isArray(data?.data) || typeof data.hasMore !== 'boolean' || data.data.length > 100 ||
            (data.pageNumber != null && data.pageNumber !== page)) throw new Error('Unsupported V3 pagination contract');
        if (Object.hasOwn(data, 'totalCount')) {
          if (!count(data.totalCount) || (totalCount !== undefined && data.totalCount !== totalCount)) throw new Error('Shipping report changed during pagination');
          totalCount = data.totalCount;
        }
        for (const order of data.data) {
          if (!order || order.companyId !== companyId || !isCompanyId(order.orderId) ||
              ids.has(order.orderId) || echoedDay(order.shippingDate) !== date || !Number.isSafeInteger(order.status)) {
            throw new Error('Shipping order ownership, identity, date or completeness not verified');
          }
          ids.add(order.orderId);
          orders.push({
            orderId: order.orderId, orderDocumentNo: safeText(order.orderDocumentNo || order.movementCode || order.orderId),
            shippingPlatform: safeText(order.shippingPlatform), status: order.status, orderType: order.orderType,
          });
        }
        if (!data.hasMore) {
          if (totalCount !== undefined && totalCount !== orders.length) throw new Error('Incomplete shipping report');
          break;
        }
        if (page === 50 || data.data.length === 0) throw new Error('Shipping report exceeds complete scan limit');
      }
    }
    return orders;
  }
  async shippingProgress(companyId, now = new Date(), offset = 0) {
    const [date] = reportDates(1, now, offset);
    return shippingSummary(date, await this.ordersDueForShipping(companyId, date));
  }
  async shippingFollowUp(companyId, cutoff, cancel) {
    const [date] = reportDates(1, cutoff);
    const orders = await this.ordersDueForShipping(companyId, date, cancel);
    const groups = { b2c: [], b2b: [], unknown: [] };
    for (const order of orders) {
      const { status, orderType } = order;
      if (CLOSED_SHIPPING_STATUSES.includes(status)) continue;
      let stage = 'unknown';
      if (status === 2004) stage = 'pickup';
      else if (status === 2003 || UNPACKED_STATUSES.includes(status)) stage = 'notReady';
      const type = orderType === 1 ? 'b2b' : orderType === 0 ? 'b2c' : 'unknown';
      groups[type].push({ orderNo: order.orderDocumentNo, stage, status: orderStatus(status).label });
    }
    return groups;
  }
  async dailyShippedOrders(companyId, now = new Date(), cancel) {
    if (!isCompanyId(companyId)) throw new Error('Company scope required');
    const [date] = reportDates(1, now);
    const summary = { date, shopee: 0, lazada: 0, tiktok: 0, express: 0, b2b: 0, b2bExpress: 0, other: 0, unknownType: 0, total: 0 };
    if (this.config.demo) {
      return companyId === 101 ? { ...summary, shopee: 120, lazada: 13, tiktok: 215, b2b: 4, b2bExpress: 1, total: 352 } : summary;
    }

    const deadline = AbortSignal.timeout(90000);
    const signal = cancel ? AbortSignal.any([cancel, deadline]) : deadline;
    const get = (endpoint, params) => {
      signal.throwIfAborted();
      return this.get(endpoint, params, AbortSignal.any([signal, AbortSignal.timeout(10000)]));
    };
    const fromDate = date + 'T00:00:00+07:00';
    const from = Date.parse(fromDate);
    const { data } = await get(SHIPPING_HISTORY_ENDPOINT, { companyId, fromDate, toDate: now.toISOString() });
    if (!data || (data.batches !== null && !Array.isArray(data.batches))) throw new Error('Invalid shipping history');
    const ids = new Set();
    const batches = [];
    for (const batch of data.batches || []) {
      const batchId = batch?.summaryPlatformBatchId;
      const timestamp = scanTimestamp(batch?.dateCreated);
      if (batch?.companyId !== companyId || !isCompanyId(batchId) || ids.has(batchId) ||
          !Number.isFinite(timestamp) || timestamp < from || bangkokDay.format(timestamp) !== date) {
        throw new Error('Shipping batch ownership, identity or date not verified');
      }
      ids.add(batchId);
      if (timestamp <= now.getTime()) batches.push(batch);
    }

    const details = await mapShippingHistory(batches, async batch => {
      if (Array.isArray(batch.items) && batch.items.length >= (batch.successCount ?? 1)) return batch;
      const { data: detail } = await get(`${SHIPPING_HISTORY_ENDPOINT}/${batch.summaryPlatformBatchId}`);
      if (detail?.companyId !== companyId || detail.summaryPlatformBatchId !== batch.summaryPlatformBatchId ||
          scanTimestamp(detail.dateCreated) !== scanTimestamp(batch.dateCreated) || !Array.isArray(detail.items)) {
        throw new Error('Shipping batch detail ownership, identity or date not verified');
      }
      return detail;
    });

    const shipped = new Map();
    for (const batch of details) {
      if (batch.successCount > batch.items.length) throw new Error('Incomplete shipping batch detail');
      for (const item of batch.items) {
        if (!item || typeof item.isCancelled !== 'boolean' || !Number.isSafeInteger(item.previousStatus) || !Number.isSafeInteger(item.newStatus)) {
          throw new Error('Invalid shipping scan item');
        }
        // V3 summaryPlatform flips the order from Packed to ReadyToShip only after all boxes are scanned.
        if (item.isCancelled || item.previousStatus !== 2003 || item.newStatus !== 2004) continue;
        if (!isCompanyId(item.orderId)) throw new Error('Shipping scan order identity not verified');
        const channel = shippingChannel(item.platform || batch.platform);
        if (!shipped.has(item.orderId) || shipped.get(item.orderId) === 'other') shipped.set(item.orderId, channel);
        else if (channel !== 'other' && shipped.get(item.orderId) !== channel) throw new Error('Conflicting shipping channels for order');
      }
    }

    const channels = await mapShippingHistory([...shipped], async ([id, scanChannel]) => {
      const { data: order } = await get(`/api/v2/Order/${id}/detail`);
      if (order?.companyId !== companyId || order.orderId !== id || (order.expressDelivery != null && typeof order.expressDelivery !== 'boolean')) {
        throw new Error('Shipping order ownership, identity or express flag not verified');
      }
      if (order.orderType === 1) return order.expressDelivery ? 'b2bExpress' : 'b2b';
      if (order.orderType !== 0) return 'unknownType';
      if (order.expressDelivery) return 'express';
      return scanChannel === 'other' ? shippingChannel(order.shippingPlatform) : scanChannel;
    });
    for (const channel of channels) summary[channel]++;
    summary.b2b += summary.b2bExpress;
    summary.total = channels.length;
    return summary;
  }
}
function shippingSummary(date, orders) {
  const summary = { date, scheduled: orders.length, due: 0, packed: 0, toPack: 0, readyToShip: 0, shipped: 0, cancelled: 0, returns: 0, unknown: 0, problemCount: 0, problems: [] };
  for (const order of orders) {
    if (order.status === 3001) { summary.cancelled++; continue; }
    if ([5001, 5002].includes(order.status)) { summary.returns++; continue; }
    summary.due++;
    // Warehouse shipping summary in V2 documents these statuses as past packing.
    if ([2003, 2004, ...SHIPPED_STATUSES].includes(order.status)) {
      summary.packed++;
      if ([2003, 2004].includes(order.status)) summary.readyToShip++; else summary.shipped++;
    } else if (UNPACKED_STATUSES.includes(order.status)) {
      summary.toPack++;
      if ([3003, 3004].includes(order.status)) summary.problemCount++;
      if (summary.problems.length < 5) summary.problems.push({
        orderNo: safeText(order.orderDocumentNo || order.orderId), platform: safeText(order.shippingPlatform),
        status: orderStatus(order.status).label,
      });
    } else summary.unknown++;
  }
  summary.packedPercent = summary.due ? Math.round(summary.packed * 1000 / summary.due) / 10 : null;
  return summary;
}
module.exports = { ShipXClient, SEARCH_ENDPOINT, COMPANY_ENDPOINT, VARIANT_ENDPOINT, STOCK_ENDPOINT, DAILY_ENDPOINT, SALES_ENDPOINT, SHIPPING_ENDPOINT, SHIPPING_HISTORY_ENDPOINT, isCompanyId, exactMatch, reportDates };
