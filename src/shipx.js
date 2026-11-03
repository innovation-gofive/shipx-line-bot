const SEARCH_ENDPOINT = '/api/v2/Order/search';
const COMPANY_ENDPOINT = '/api/v1/Company/GetListCompany';
const DEMO_ORDERS = [
  { companyId: 101, orderId: 1001, orderDocumentNo: 'SO001', movementCode: 'MV001', platformOrderId: '250001', status: 2, statusDescription: 'กำลังแพ็คสินค้า', trackingNumber: 'TH0123456789', shippingCarrier: 'ตัวอย่างขนส่ง' },
  { companyId: 101, orderId: 1002, orderDocumentNo: 'SO002', movementCode: 'MV002', status: 3, statusDescription: 'ส่งออกจากคลังแล้ว', trackingNumber: 'TH0987654321', shippingCarrier: 'ตัวอย่างขนส่ง' },
  { companyId: 202, orderId: 2001, orderDocumentNo: 'SO999', status: 1, statusDescription: 'รอหยิบสินค้า', trackingNumber: null },
];
function isCompanyId(value) { return Number.isSafeInteger(value) && value > 0 && value <= 2147483647; }
function exactMatch(order, reference) {
  return ['orderDocumentNo', 'movementCode', 'platformOrderId', 'trackingNumber', 'orderId']
    .some(key => order[key] != null && String(order[key]).toUpperCase() === reference.toUpperCase());
}
function safeText(value, max = 150) { return String(value ?? '').replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, max); }
function publicOrder(order) {
  return {
    orderNo: safeText(order.orderDocumentNo || order.movementCode || order.orderId),
    status: safeText(order.statusDescription || (order.status != null ? `รหัสสถานะ ${order.status}` : 'ยังไม่มีข้อมูลสถานะ')),
    tracking: safeText(order.trackingNumber), carrier: safeText(order.shippingCarrier || order.shopeeOrderShippingCarrier),
  };
}
class ShipXClient {
  constructor(config, fetcher = fetch) { this.config = config; this.fetcher = fetcher; }
  async get(endpoint, params, signal) {
    const url = new URL(endpoint, this.config.shipxBaseUrl);
    for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, String(value));
    const headers = { Accept: 'application/json' };
    if (this.config.shipxApiKey) headers['X-API-Key'] = this.config.shipxApiKey;
    if (this.config.shipxBearer) headers.Authorization = `Bearer ${this.config.shipxBearer}`;
    const response = await this.fetcher(url, { headers, redirect: 'error', signal: signal || AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`ShipX HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 5000000) throw new Error('ShipX response too large');
    const json = JSON.parse(text);
    if (!json || typeof json !== 'object') throw new Error('Invalid ShipX response');
    return json;
  }
  async companies() {
    if (this.config.demo) return [{ id: 101, name: 'ABC Logistics' }, { id: 202, name: 'บริษัท สยามรีเทล จำกัด' }];
    const json = await this.get(COMPANY_ENDPOINT);
    if (!Array.isArray(json.data?.companies)) throw new Error('Unexpected Company response contract');
    return json.data.companies.filter(c => isCompanyId(c.companyId)).map(c => ({ id: c.companyId, name: safeText(c.companyName || c.companyId) }));
  }
  async findOrder(companyId, reference) {
    if (!isCompanyId(companyId)) throw new Error('Company scope required');
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(reference)) throw new Error('Invalid order reference');
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
}
module.exports = { ShipXClient, SEARCH_ENDPOINT, COMPANY_ENDPOINT, isCompanyId, exactMatch };
