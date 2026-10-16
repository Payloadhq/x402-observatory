'use strict';
// A failed outbound proxy CONNECT is not evidence that a destination is down.
// Match only explicit proxy/tunnel + status 403 errors, not a remote HTTP 403.
function proxyConnectBlocked(error) {
  const str = String(error || '');
  return /(?:proxy|tunnel|CONNECT).*\b403\b|\b403\b.*(?:proxy|tunnel|CONNECT)/i.test(str);
}
module.exports = { proxyConnectBlocked };
