/**
 * Test fixture server: red hero (purple in dark mode), yellow fixed
 * cookie banner, tall gradient body. Runs as a separate process because
 * the test process blocks its event loop while the CLI runs.
 * Prints "listening <port>" on stdout.
 */

import http from "node:http";

// The lime/blue marker strips pin the exact edges of the page viewport:
// fidelity tests assert they never appear inside status-bar / island /
// home-indicator regions (which would mean content under the chrome).
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin:0; background:#ffffff; }
  .hero { height:100vh; background:#e11d48; }
  @media (prefers-color-scheme: dark) { .hero { background:#7c3aed; } }
  .banner { position:fixed; bottom:8px; left:0; right:0; height:52px; background:#facc15; }
  .tall { height:220vh; background:linear-gradient(#0ea5e9,#22c55e); }
  .marker-top { position:fixed; top:0; left:0; right:0; height:4px; background:#00ff00; }
  .marker-bottom { position:fixed; bottom:0; left:0; right:0; height:4px; background:#0000ff; }
</style></head><body><div class="hero"></div><div class="tall"></div>
<div class="banner" id="cookie"></div>
<div class="marker-top"></div><div class="marker-bottom"></div></body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(FIXTURE);
});
server.listen(0, () => console.log(`listening ${server.address().port}`));
