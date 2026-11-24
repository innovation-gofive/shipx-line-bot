const { serviceError } = require('./service-error');
const endpoint = '/api/v3/Order/list/order-platform';
const count = n => Number.isSafeInteger(n) && n >= 0;

// ShipX deployments expose both hasMore and count-based pagination contracts.
function orderPage(json, page, pageSize) {
  const data = json?.data && !Array.isArray(json.data) ? json.data : json;
  const rows = Array.isArray(data?.data) ? data.data : data?.items ?? data?.orders ?? (Array.isArray(json?.data) ? json.data : null);
  const metadata = data?.pagination ?? json?.pagination ?? data;
  const current = metadata?.currentPage ?? metadata?.pageNumber ?? json?.pageNumber;
  const total = metadata?.totalCount ?? metadata?.totalItems ?? metadata?.totalRecords ?? metadata?.total ?? data?.totalCount ?? json?.totalCount ?? json?.total;
  const pages = metadata?.totalPages;
  const size = metadata?.pageSize ?? pageSize;
  let more = data?.hasMore ?? metadata?.hasMore ?? metadata?.hasNext ?? metadata?.hasNextPage ?? data?.hasNextPage ?? json?.hasMore;
  if (more == null && count(pages)) more = page < pages;
  if (more == null && count(total)) more = page * size < total;
  if (!Array.isArray(rows) || rows.length > pageSize || typeof more !== 'boolean' ||
      (current != null && current !== page) || (total != null && !count(total)) ||
      (pages != null && !count(pages)) || !count(size) || size < 1 || size > pageSize || rows.length > size) {
    const error = serviceError('ShipX', endpoint, 'order_pagination_not_verified');
    const keys = value => value && !Array.isArray(value) && typeof value === 'object'
      ? Object.keys(value).filter(k => /^[a-zA-Z_][a-zA-Z0-9_]{0,29}$/.test(k)).slice(0,15).join(',') : Array.isArray(value) ? 'array' : typeof value;
    error.diagnostic = `rootKeys=${keys(json)} dataKeys=${keys(json?.data)} paginationKeys=${keys(metadata)}`;
    throw error;
  }
  return { rows, hasMore: more, totalCount: total };
}
module.exports = { orderPage };
