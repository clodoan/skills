/**
 * FIXTURE mock server for the grok-chat fixture app. Serves hand-written
 * static HTML per route so map --thumbs has real screens to capture.
 * Not xAI code; every page is watermarked "fixture".
 *
 *   node serve.mjs [port]     (default 4700)
 */

import http from "node:http";

const shell = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title} · grok-chat fixture</title><style>
  * { box-sizing: border-box; margin: 0; }
  body { background: #131211; color: #ece9e4; font: 15px/1.5 system-ui, sans-serif;
         min-height: 100vh; display: flex; flex-direction: column; }
  header { display: flex; align-items: center; gap: 18px; padding: 14px 22px; color: #8d8a84; }
  header .logo { width: 22px; height: 22px; border: 2px solid #ece9e4; border-radius: 50%;
                 position: relative; }
  header .logo::after { content: ""; position: absolute; inset: 8px -4px auto; height: 2px;
                        background: #ece9e4; transform: rotate(-45deg); }
  header nav { margin-left: auto; display: flex; gap: 14px; }
  header a { color: #b5b2ab; text-decoration: none; font-size: 13px; }
  .pill { border: 1px solid #3a3835; border-radius: 999px; padding: 6px 14px; }
  .pill.solid { background: #ece9e4; color: #131211; }
  main { flex: 1; display: flex; flex-direction: column; align-items: center;
         justify-content: center; gap: 26px; padding: 32px; }
  h1 { font-size: 26px; font-weight: 600; }
  .composer { width: min(640px, 90%); background: #1d1c1a; border: 1px solid #2e2c29;
              border-radius: 18px; padding: 18px 18px 46px; color: #8d8a84; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
          gap: 14px; width: min(720px, 92%); }
  .card { background: #1d1c1a; border: 1px solid #2e2c29; border-radius: 14px;
          padding: 18px; color: #b5b2ab; }
  .card b { display: block; color: #ece9e4; margin-bottom: 6px; }
  footer { padding: 12px; text-align: center; color: #57544f; font-size: 11px;
           letter-spacing: 0.16em; text-transform: uppercase; }
</style></head><body>
<header><div class="logo"></div><span>grok-chat</span>
  <nav><a href="/imagine">Imagine</a><a href="/tasks">Tasks</a><a href="/files">Files</a>
  <a class="pill" href="/login">Sign in</a><a class="pill solid" href="/login">Sign up</a></nav>
</header>
<main>${body}</main>
<footer>fixture app — not xai — mock screens for the map skill demo</footer>
</body></html>`;

const card = (title, sub) => `<div class="card"><b>${title}</b>${sub}</div>`;

const PAGES = {
  "/": shell("Chat", `<h1>Ask anything</h1><div class="composer">Message grok-chat…</div>`),
  "/imagine": shell("Imagine", `<h1>Imagine</h1><div class="grid">${card("Aurora over a data center", "image · 4s ago")}${card("Blueprint of a rocket", "image · 1m ago")}${card("Isometric city at dusk", "image · 3m ago")}</div>`),
  "/tasks": shell("Tasks", `<h1>Tasks</h1><div class="grid">${card("Daily digest", "runs 07:00 · last run ok")}${card("Repo watcher", "runs hourly · 2 findings")}${card("News brief", "runs 18:00 · paused")}</div>`),
  "/files": shell("Files", `<h1>Files</h1><div class="grid">${card("roadmap.pdf", "1.2 MB · yesterday")}${card("metrics.csv", "310 KB · 2d ago")}${card("design-notes.md", "18 KB · 5d ago")}</div>`),
  "/login": shell("Sign in", `<h1>Sign in to grok-chat</h1><div class="composer" style="padding:18px;text-align:center">Continue with fixture account</div>`),
  "/settings": shell("Settings", `<h1>Settings</h1><div class="grid">${card("Models", "default: fixture-1")}${card("Appearance", "theme: dark")}</div>`),
  "/settings/models": shell("Models", `<h1>Models</h1><div class="grid">${card("fixture-1", "fast · default")}${card("fixture-1-mini", "cheap")}</div>`),
  "/settings/appearance": shell("Appearance", `<h1>Appearance</h1><div class="grid">${card("Dark", "active")}${card("Light", "")}</div>`),
};

const port = Number(process.argv[2] ?? 4700);
http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  const page = PAGES[url] ?? shell("Not found", "<h1>404 (fixture)</h1>");
  res.writeHead(PAGES[url] ? 200 : 404, { "content-type": "text/html" });
  res.end(page);
}).listen(port, () => console.log(`grok-chat fixture on http://localhost:${port}`));
