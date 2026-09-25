/**
 * Test fixture server: red hero (purple in dark mode), yellow fixed
 * cookie banner, tall gradient body. Runs as a separate process because
 * the test process blocks its event loop while the CLI runs.
 * Prints "listening <port>" on stdout.
 */

import http from "node:http";

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin:0; background:#ffffff; }
  .hero { height:100vh; background:#e11d48; }
  @media (prefers-color-scheme: dark) { .hero { background:#7c3aed; } }
  .banner { position:fixed; bottom:0; left:0; right:0; height:60px; background:#facc15; }
  .tall { height:220vh; background:linear-gradient(#0ea5e9,#22c55e); }
</style></head><body><div class="hero"></div><div class="tall"></div><div class="banner" id="cookie"></div></body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(FIXTURE);
});
server.listen(0, () => console.log(`listening ${server.address().port}`));
