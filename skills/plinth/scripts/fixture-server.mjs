/**
 * Test fixture server: red hero (purple in dark mode), yellow fixed
 * cookie banner, tall gradient body; /csp serves it with a strict CSP,
 * /probe reports the page's UA and input capabilities, /split is half
 * black, half white. Runs as a separate process because
 * the test process blocks its event loop while the CLI runs.
 * Prints "listening <port>" on stdout.
 */

import http from "node:http";

// The 2px lime/blue marker strips (thin, so they never win the band
// color vote) pin the exact edges of the page viewport:
// fidelity tests assert they never appear inside status-bar / island /
// home-indicator regions (which would mean content under the chrome).
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin:0; background:#ffffff; }
  .hero { height:100vh; background:#e11d48; }
  @media (prefers-color-scheme: dark) { .hero { background:#7c3aed; } }
  .banner { position:fixed; bottom:8px; left:0; right:0; height:52px; background:#facc15; }
  .tall { height:220vh; background:linear-gradient(#0ea5e9,#22c55e); }
  .marker-top { position:fixed; top:0; left:0; right:0; height:2px; background:#00ff00; }
  .marker-bottom { position:fixed; bottom:0; left:0; right:0; height:2px; background:#0000ff; }
</style></head><body><div class="hero"></div><div class="tall"></div>
<div class="banner" id="cookie"></div>
<div class="marker-top"></div><div class="marker-bottom"></div></body></html>`;

// /probe reports what the page sees (no viewport meta on purpose) to
// /log, which is echoed on stdout as "log <json>" for the tests to read.
const PROBE = `<!doctype html><body style="margin:0;background:#fff"><script>
fetch("/log?" + new URLSearchParams({
  tag: location.search.slice(1), ua: navigator.userAgent, width: innerWidth,
  touchPoints: navigator.maxTouchPoints, coarse: matchMedia("(pointer: coarse)").matches,
}));
</script>`;

// Half black, half white: the safe-area band must pick one, not grey.
const SPLIT = `<!doctype html><body style="margin:0;height:100vh;background:linear-gradient(90deg,#000 50%,#fff 50%)">`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://fixture");
  if (url.pathname === "/log") {
    console.log(`log ${JSON.stringify(Object.fromEntries(url.searchParams))}`);
    res.end();
    return;
  }
  const headers = { "content-type": "text/html" };
  // Strict CSP: inline styles (like --hide's) are blocked unless bypassed.
  if (url.pathname === "/csp") headers["content-security-policy"] = "style-src 'self'";
  res.writeHead(200, headers);
  res.end(url.pathname === "/probe" ? PROBE : url.pathname === "/split" ? SPLIT : FIXTURE);
});
server.listen(0, () => console.log(`listening ${server.address().port}`));
