function serviceError(service, endpoint, reason, status) {
  const message = reason.replaceAll('_', ' ');
  return Object.assign(new Error(`${service} ${message}${status ? ` HTTP ${status}` : ''}`), { service, endpoint, reason, statusCode: status });
}

function failureReason(error) {
  if (['company_access_not_verified','company_access_context_changed'].includes(error?.reason)) return `HTTP 403 (${error.reason})`;
  if (Number.isInteger(error?.statusCode)) return `HTTP ${error.statusCode}`;
  if (error?.name === 'TimeoutError') return 'timeout';
  if (error?.name === 'AbortError') return 'aborted';
  if (error?.reason) return error.diagnostic ? `${error.reason} (${error.diagnostic})` : error.reason;
  if (error instanceof TypeError) return 'connection_error';
  return 'response_not_verified';
}

module.exports = { serviceError, failureReason };
