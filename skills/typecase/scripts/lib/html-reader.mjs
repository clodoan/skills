/**
 * Static single-file HTML fallback for `typecase open` on machines
 * without the desktop app (headless boxes, agents). Deliberately small:
 * same parser data, search, sidebar, detail, History — no interactivity
 * beyond filtering. The crafted experience is the Electron app.
 */

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

export function htmlReader(data, { lock } = {}) {
  const skills = data.skills.map((s, i) => ({ ...s, id: i }));
  const dupNames = new Set(data.duplicates.map((d) => d.name));
  const overlapNames = new Set(data.overlaps.flatMap((o) => [o.a.name, o.b.name]));
  const payload = JSON.stringify({ skills, duplicates: data.duplicates, overlaps: data.overlaps, lock }).replace(/</g, "\\u003c");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Typecase</title><style>
  :root { color-scheme: light dark; --ink:#1c1c1e; --dim:#8a8a90; --line:#00000014; --card:#ffffff; --bg:#f4f4f6; }
  @media (prefers-color-scheme: dark){ :root{ --ink:#ececf0; --dim:#9a9aa2; --line:#ffffff1a; --card:#1d1d21; --bg:#151518; } }
  * { box-sizing:border-box; margin:0 }
  body { font:14px/1.5 -apple-system,system-ui,sans-serif; color:var(--ink); background:var(--bg); display:grid; grid-template-columns:240px 1fr; min-height:100vh }
  aside { padding:20px 14px; border-right:1px solid var(--line) }
  aside h2 { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); margin:16px 8px 6px }
  aside button { display:block; width:100%; text-align:left; border:0; background:none; color:var(--ink); padding:5px 8px; border-radius:6px; cursor:pointer; font:inherit }
  aside button.on { background:var(--line) }
  main { padding:24px }
  input { width:320px; padding:7px 12px; border-radius:999px; border:1px solid var(--line); background:var(--card); color:inherit; font:inherit }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(230px,1fr)); gap:12px; margin-top:18px }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; cursor:pointer }
  .card h3 { font-size:19px; font-weight:650; margin-bottom:4px }
  .card p { color:var(--dim); font-size:12.5px; height:3em; overflow:hidden }
  .meta { color:var(--dim); font-size:11px; margin-top:10px; display:flex; gap:8px }
  .badge { color:#b45309 } .risky { color:#b91c1c }
  #detail { max-width:760px } #detail .row { display:grid; grid-template-columns:120px 1fr; padding:12px 0; border-top:1px solid var(--line) }
  #detail .row b { color:var(--dim); font-weight:500; font-size:12px }
  pre { white-space:pre-wrap; font:12px/1.5 ui-monospace,monospace; background:var(--card); padding:12px; border-radius:8px; border:1px solid var(--line) }
  </style></head><body>
  <aside>
    <h2>Library</h2>
    <button class="on" data-f="all">All</button><button data-f="dup">Duplicates</button><button data-f="overlap">Overlaps</button><button data-f="risky">Risky tools</button>
    <h2>Tools</h2>
    ${["grok", "cursor", "claude", "codex", "shared"].map((t) => `<button data-f="tool:${t}">${t}</button>`).join("")}
    <h2>History</h2><button data-f="history">Lock &amp; changes</button>
  </aside>
  <main>
    <input id="q" placeholder="Search ${skills.length} skills…" autofocus>
    <div id="grid" class="grid"></div>
    <div id="detail" hidden></div>
  </main>
  <script>
  const DATA = ${payload};
  const dupNames = new Set(${JSON.stringify([...dupNames])});
  const overlapNames = new Set(${JSON.stringify([...overlapNames])});
  let filter = "all";
  const grid = document.getElementById("grid"), detail = document.getElementById("detail"), q = document.getElementById("q");
  function cards() {
    detail.hidden = true; grid.hidden = false;
    const needle = q.value.toLowerCase();
    grid.innerHTML = DATA.skills.filter((s) => {
      if (filter.startsWith("tool:")) { if (s.tool !== filter.slice(5)) return false; }
      else if (filter === "dup" && !dupNames.has(s.name)) return false;
      else if (filter === "overlap" && !overlapNames.has(s.name)) return false;
      else if (filter === "risky" && !s.riskyTools.length) return false;
      return !needle || (s.name + " " + s.description + " " + s.triggers).toLowerCase().includes(needle);
    }).map((s) => \`<div class="card" onclick="show(\${s.id})"><h3>\${esc(s.name)}</h3><p>\${esc(s.description)}</p>
      <div class="meta"><span>\${s.tool}</span><span>\${s.scope}</span><span>\${s.tokens} tok</span>
      \${dupNames.has(s.name) ? '<span class="badge">dup</span>' : ''}\${s.riskyTools.length ? '<span class="risky">' + s.riskyTools.join("/") + '</span>' : ''}</div></div>\`).join("");
  }
  function esc(x){const d=document.createElement("i");d.textContent=x??"";return d.innerHTML}
  window.show = (id) => {
    const s = DATA.skills[id];
    grid.hidden = true; detail.hidden = false;
    const row = (k, v) => v ? \`<div class="row"><b>\${k}</b><div>\${v}</div></div>\` : "";
    detail.innerHTML = \`<p><a href="#" onclick="cards();return false">← all skills</a></p>
      <h1 style="font-size:34px;margin:14px 0 2px">\${esc(s.name)}</h1><p style="color:var(--dim)">\${esc(s.description)}</p><br>
      \${row("Triggers", esc(s.triggers))}\${row("When not", esc(s.whenNot))}
      \${row("Risky tools", s.riskyTools.join(", "))}\${row("Commands", s.commands.join(", "))}
      \${row("Files", s.files.join(", "))}\${row("Path", "<code>" + esc(s.path) + "</code>")}
      \${row("Sections", s.sections.filter(x=>x.level).map((x) => esc(x.heading)).join(" · "))}\`;
  };
  document.querySelectorAll("aside button").forEach((b) => b.onclick = () => {
    document.querySelectorAll("aside button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    filter = b.dataset.f;
    if (filter === "history") { history(); } else cards();
  });
  function history() {
    grid.hidden = true; detail.hidden = false;
    const lock = DATA.lock;
    detail.innerHTML = "<h1 style='font-size:28px'>History</h1>" + (lock
      ? \`<p style="color:var(--dim)">skills.lock from \${lock.generatedAt} — \${Object.keys(lock.skills).length} skills locked</p>
         <pre>\${esc(Object.values(lock.skills).map((s) => s.name + "  " + s.hash.slice(0, 12) + "  " + (s.source?.ref ?? s.source?.version ?? "local")).join("\\n"))}</pre>\`
      : "<p>No skills.lock here — run <code>typecase lock</code>.</p>");
  }
  q.oninput = cards; cards();
  </script></body></html>`;
}
