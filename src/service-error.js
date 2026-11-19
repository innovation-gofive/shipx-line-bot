function serviceError(service, endpoint, reason, status) {
  const message = reason.replaceAll('_', ' ');
  return Object.assign(new Error(`${service} ${message}${status ? ` HTTP ${status}` : ''}`), { service, endpoint, reason, statusCode: status });
}

function failureReason(error) {
  if (Number.isInteger(error?.statusCode)) return `HTTP ${error.statusCode}`;
  if (error?.name === 'TimeoutError') return 'timeout';
  if (error?.name === 'AbortError') return 'aborted';
  if (error?.reason) return error.reason;
  if (error instanceof TypeError) return 'connection_error';
  return 'response_not_verified';
}

module.exports = { serviceError, failureReason };
