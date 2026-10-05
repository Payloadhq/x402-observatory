/* Payload X402 Observatory — privacy-respecting usage beacon (<30 lines).
 * Sends aggregate-only event counts to the Payload rail. No cookies, no
 * fingerprinting, no IP/UA stored server-side. Silent no-op if unreachable. */
(function () {
  var ENDPOINT = 'https://payload-rail.fly.dev/v1/events/observatory';
  function send(event, cta) {
    try {
      var body = JSON.stringify({ event: event, cta: cta || null });
      if (navigator.sendBeacon) navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
      else fetch(ENDPOINT, { method: 'POST', body: body, keepalive: true }).catch(function () {});
    } catch (e) { /* never break the dashboard */ }
  }
  send('page_view');
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-cta]');
    if (t) {
      var kind = t.getAttribute('data-cta');
      send(kind === 'manifest-check' ? 'checker_click'
        : kind.indexOf('github') === 0 ? 'github_action_click'
        : kind === 'product-kit' || kind === 'tooling' ? 'product_click'
        : kind === 'checkout' ? 'checkout_click' : 'cta_click', kind);
    }
  });
  var s = document.querySelector('input[type="search"], #resource-search');
  if (s) s.addEventListener('change', function () { send('search_used'); }, { once: true });
  var r = document.querySelector('[data-report]');
  if (r) r.addEventListener('click', function () { send('report_viewed'); }, { once: true });
})();
