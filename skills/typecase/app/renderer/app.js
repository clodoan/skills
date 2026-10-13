/* Typecase renderer. All data comes from the main process over the
   preload bridge; this file is pure presentation + navigation state. */

const TOOLS = [
  { id: "grok", label: "Grok" },
  { id: "cursor", label: "Cursor" },
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "shared", label: "Shared" },
];
const SCOPES = [
  { id: "user", label: "User" },
  { id: "project", label: "Project" },
  { id: "plugin", label: "Plugin" },
];

const TOOL_ICONS = {
  grok: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M3 13 13 3M9.5 3H13v3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cursor: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M4 2.5 12.5 8 8.3 9.1 6.4 13.5Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  claude: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 2v12M3 5l10 6M13 5 3 11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  codex: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="m3 4.5 4 3.5-4 3.5M8.5 12H13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  shared: '<svg viewBox="0 0 16 16" width="13" height="13"><circle cx="5.5" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="10.5" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
};
const LIB_ICONS = {
  all: '<svg viewBox="0 0 16 16" width="13" height="13"><rect x="2.5" y="2.5" width="11" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  active: '<svg viewBox="0 0 16 16" width="13" height="13"><circle cx="8" cy="8" r="5.3" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>',
  changed: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M13 8A5 5 0 1 1 8 3h3M9 1l2.2 2L9 5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  overlaps: '<svg viewBox="0 0 16 16" width="13" height="13"><circle cx="6" cy="8" r="3.8" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="10" cy="8" r="3.8" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
};

let data = null;
const state = {
  library: "all",       // all | active | changed | overlaps
  tool: null,
  scope: null,
  collection: null,     // root dir
  chips: { risky: false, overlaps: false, changed: false },
  layout: "grid",
  density: "cozy",
  theme: localStorage.getItem("typecase-theme") ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  view: "grid",         // grid | detail
  skillKey: null,
  tab: "rendered",
  showFrontmatter: false,
  focusIndex: -1,
};

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const keyOf = (s) => `${s.tool}:${s.scope}:${s.name}:${s.path}`;
const lockKeyOf = (s) => `${s.tool}:${s.scope}:${s.name}`; // matches lockfile.mjs keyOf
const prefersReduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

function transition(fn) {
  if (!prefersReduced && document.startViewTransition) document.startViewTransition(fn);
  else fn();
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  localStorage.setItem("typecase-theme", state.theme);
  for (const b of document.querySelectorAll(".swatch"))
    b.classList.toggle("active", b.dataset.theme === state.theme);
}

/* ---------- derived data ---------- */

function changedKeys() {
  // Change entries carry the lockfile key (tool:scope:name).
  return new Set((data.changes ?? []).filter((c) => c.status !== "removed").map((c) => c.key));
}
const isChanged = (changed, s) => changed.has(lockKeyOf(s));
function overlapNames() {
  const s = new Set();
  for (const o of data.overlaps) { s.add(o.a.path); s.add(o.b.path); }
  return s;
}
function dupNames() {
  return new Set(data.duplicates.map((d) => d.name));
}

function visibleSkills() {
  const changed = changedKeys();
  const overlaps = overlapNames();
  let out = data.skills.filter((s) => !s.error);
  if (state.library === "changed") out = out.filter((s) => isChanged(changed, s));
  if (state.library === "overlaps") out = out.filter((s) => overlaps.has(s.path));
  if (state.tool) out = out.filter((s) => s.tool === state.tool);
  if (state.scope) out = out.filter((s) => s.scope === state.scope);
  if (state.collection) out = out.filter((s) => s.root === state.collection);
  if (state.chips.risky) out = out.filter((s) => s.riskyTools.length);
  if (state.chips.overlaps) out = out.filter((s) => overlaps.has(s.path));
  if (state.chips.changed) out = out.filter((s) => isChanged(changed, s));
  return out;
}

function fuzzyScore(query, s) {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const name = s.name.toLowerCase();
  const hay = `${s.description ?? ""} ${s.triggers ?? ""}`.toLowerCase();
  if (name === q) return 100;
  if (name.includes(q)) return 60 - name.indexOf(q);
  // subsequence on name
  let i = 0;
  for (const ch of name) if (ch === q[i]) i++;
  if (i === q.length) return 30;
  if (hay.includes(q)) return 15;
  const words = q.split(/\s+/);
  const hits = words.filter((w) => hay.includes(w) || name.includes(w)).length;
  return hits === words.length ? 8 : hits > 0 ? 2 : -1;
}

/* ---------- sidebar ---------- */

function navItem({ icon, label, count, active, special, onClick }) {
  const b = document.createElement("button");
  b.className = "nav-item" + (active ? " active" : "") + (special ? " special" : "");
  b.innerHTML = `${icon ?? ""}<span>${esc(label)}</span>${count != null ? `<span class="count">${count}</span>` : ""}`;
  b.addEventListener("click", onClick);
  return b;
}

function renderSidebar() {
  const nav = $("#sidenav");
  nav.replaceChildren();
  const skills = data.skills.filter((s) => !s.error);
  const changed = changedKeys();
  const overlaps = overlapNames();
  const pick = (patch) => () =>
    transition(() => {
      Object.assign(state, { view: "grid", skillKey: null, tab: "rendered", focusIndex: -1 }, patch);
      render();
    });

  const h = (t) => { const d = document.createElement("div"); d.className = "nav-heading"; d.textContent = t; nav.appendChild(d); };

  h("Library");
  const lib = [
    { id: "all", label: "All Skills", count: skills.length },
    { id: "active", label: "Active", count: skills.length },
    { id: "changed", label: "Changed since lock", count: changed.size, special: true },
    { id: "overlaps", label: "Overlaps", count: new Set([...overlaps].map((p) => p)).size, special: true },
  ];
  for (const l of lib) {
    nav.appendChild(navItem({
      icon: LIB_ICONS[l.id], label: l.label, count: l.count, special: l.special,
      active: state.library === l.id && !state.tool && !state.scope && !state.collection,
      onClick: pick({ library: l.id, tool: null, scope: null, collection: null }),
    }));
  }

  h("Tools");
  for (const t of TOOLS) {
    const count = skills.filter((s) => s.tool === t.id).length;
    if (!count && !["grok", "cursor", "claude", "codex"].includes(t.id)) continue;
    nav.appendChild(navItem({
      icon: TOOL_ICONS[t.id], label: t.label, count,
      active: state.tool === t.id,
      onClick: pick({ library: "all", tool: t.id, scope: null, collection: null }),
    }));
  }

  h("Collections");
  const roots = data.roots.filter((r) => r.exists && skills.some((s) => s.root === r.dir));
  for (const r of roots) {
    const short = r.dir.replace(data.cwd, "·").replace(/^\/(home|Users)\/[^/]+/, "~");
    nav.appendChild(navItem({
      icon: TOOL_ICONS[r.tool] ?? LIB_ICONS.all,
      label: short, count: skills.filter((s) => s.root === r.dir).length,
      active: state.collection === r.dir,
      onClick: pick({ library: "all", tool: null, scope: null, collection: r.dir }),
    }));
  }

  h("Sources");
  for (const sc of SCOPES) {
    const count = skills.filter((s) => s.scope === sc.id).length;
    nav.appendChild(navItem({
      icon: LIB_ICONS.active, label: sc.label, count,
      active: state.scope === sc.id,
      onClick: pick({ library: "all", tool: null, scope: sc.id, collection: null }),
    }));
  }
}

/* ---------- grid ---------- */

function toolLabel(id) { return TOOLS.find((t) => t.id === id)?.label ?? id; }

function cardBadges(s) {
  const changed = changedKeys();
  const overlaps = overlapNames();
  const dups = dupNames();
  const out = [];
  if (s.riskyTools.length) out.push('<span class="badge risky">risky</span>');
  if (dups.has(s.name)) out.push('<span class="badge dup">dup</span>');
  else if (overlaps.has(s.path)) out.push('<span class="badge overlap">overlap</span>');
  if (isChanged(changed, s)) out.push('<span class="badge changed">changed</span>');
  return out.join("");
}

function renderGrid() {
  const content = $("#content");
  const skills = visibleSkills().sort((a, b) => a.name.localeCompare(b.name));
  const scopeLabel =
    state.tool ? toolLabel(state.tool)
    : state.scope ? SCOPES.find((s) => s.id === state.scope).label
    : state.collection ? "Collection"
    : state.library === "changed" ? "Changed since lock"
    : state.library === "overlaps" ? "Overlapping"
    : "All";

  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="count-head">
      <h1>${skills.length} Skill${skills.length === 1 ? "" : "s"}</h1>
      <span class="sub">${esc(scopeLabel)}</span>
    </div>`;
  const grid = document.createElement("div");
  grid.className = (state.layout === "list" ? "list" : "grid") + (state.density === "compact" ? " compact" : "");
  grid.id = "grid";

  skills.forEach((s, i) => {
    const card = document.createElement("article");
    card.className = "card" + (i === state.focusIndex ? " focused" : "");
    card.tabIndex = 0;
    card.dataset.key = keyOf(s);
    if (i === state.focusIndex) card.style.viewTransitionName = "hero";
    card.innerHTML = `
      <div class="badges">${cardBadges(s)}</div>
      <div class="hero">${esc(s.name)}</div>
      <div class="desc">${esc(s.description || "—")}</div>
      <div class="meta">
        <span class="tool-tag">${TOOL_ICONS[s.tool] ?? ""} ${esc(toolLabel(s.tool))}</span>
        <span>·</span><span>${esc(s.scope)}</span>
        <span>·</span><span>~${s.tokens} tok</span>
      </div>`;
    const open = () => openDetail(keyOf(s), card);
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
    grid.appendChild(card);
  });
  if (!skills.length) {
    grid.innerHTML = `<div class="empty-hint">Nothing here. ${
      state.library === "changed" ? "Run <code>typecase lock</code>, edit a skill, and changes will appear." : "Try clearing filters."
    }</div>`;
  }
  wrap.appendChild(grid);
  content.replaceChildren(wrap);
  $("#segmented-wrap").hidden = true;
}

/* ---------- detail ---------- */

function openDetail(key, cardEl) {
  if (cardEl && !prefersReduced) cardEl.style.viewTransitionName = "hero";
  transition(() => {
    state.view = "detail";
    state.skillKey = key;
    state.tab = "rendered";
    state.showFrontmatter = false;
    render();
  });
}

function closeDetail() {
  transition(() => {
    state.view = "grid";
    state.skillKey = null;
    render();
  });
}

function row(label, valueHtml, muted = false) {
  return valueHtml
    ? `<div class="row"><div class="label">${esc(label)}</div><div class="value${muted ? " muted" : ""}">${valueHtml}</div></div>`
    : "";
}

function renderDetail() {
  const content = $("#content");
  const s = data.skills.find((x) => keyOf(x) === state.skillKey);
  if (!s) { closeDetail(); return; }
  const lockEntry = data.lock?.skills?.[lockKeyOf(s)];
  const change = (data.changes ?? []).find((c) => c.key === lockKeyOf(s));
  const myOverlaps = data.overlaps.filter((o) => o.a.path === s.path || o.b.path === s.path);
  const myDup = data.duplicates.find((d) => d.name === s.name);

  const el = document.createElement("div");
  el.className = "detail";
  el.innerHTML = `
    <div class="detail-top">
      <button class="back-btn" id="back-btn">‹ Skills</button>
      <div class="spacer"></div>
      <button class="icon-btn${state.showFrontmatter ? " active" : ""}" id="fm-btn" title="Raw frontmatter">i</button>
    </div>
    <div class="detail-hero" style="view-transition-name: hero">${esc(s.name)}</div>
    <div class="detail-sub">${esc(s.description || "")}</div>
    <div class="detail-badges">${cardBadges(s)}</div>
    ${state.showFrontmatter ? `<div class="frontmatter-pop">${esc(JSON.stringify(s.frontmatter, null, 2))}</div>` : ""}
    <div id="tab-body"></div>`;
  content.replaceChildren(el);

  el.querySelector("#back-btn").addEventListener("click", closeDetail);
  el.querySelector("#fm-btn").addEventListener("click", () => { state.showFrontmatter = !state.showFrontmatter; render(); });

  const body = el.querySelector("#tab-body");
  if (state.tab === "rendered") renderTabRendered(body, s, { lockEntry, myOverlaps, myDup });
  else if (state.tab === "source") renderTabSource(body, s);
  else renderTabHistory(body, s, { lockEntry, change });

  const seg = $("#segmented-wrap");
  seg.hidden = false;
  for (const b of seg.querySelectorAll("button"))
    b.classList.toggle("active", b.dataset.tab === state.tab);
}

function renderTabRendered(body, s, { lockEntry, myOverlaps, myDup }) {
  const whenUse = s.sections.find((x) => /when to use|^use/i.test(x.heading))?.text ?? "";
  const toolChips = s.commands.map((c) => {
    const risky = s.riskyTools.some((r) => c.includes(r) || r.includes(c.split(/\s/)[0]));
    return `<span class="tool-chip${risky ? " risky" : ""}">${esc(c)}${risky ? " ⚠" : ""}</span>`;
  }).join("");
  const riskyOnly = s.riskyTools
    .filter((r) => !s.commands.some((c) => c.includes(r)))
    .map((r) => `<span class="tool-chip risky">${esc(r)} ⚠</span>`).join("");
  const overlapLinks = myOverlaps.map((o) => {
    const other = o.a.path === s.path ? o.b : o.a;
    const otherKey = data.skills.find((x) => x.path === other.path);
    return `<li><a class="link-skill" data-goto="${esc(otherKey ? keyOf(otherKey) : "")}">${esc(other.name)}</a> <span class="mono" style="color:var(--ink-3)">(${Math.round(o.score * 100)}% shared vocabulary, ${esc(other.tool)})</span></li>`;
  }).join("");
  const dupLine = myDup
    ? `<li>${myDup.identical ? "Identical copy" : "Same name, different content"} in ${myDup.installs.filter((i) => i.path !== s.path).map((i) => `${esc(i.tool)} · ${esc(i.scope)}`).join(", ")}</li>`
    : "";
  const lockHtml = lockEntry
    ? `locked <span class="mono">${esc(lockEntry.hash.slice(0, 12))}</span>${lockEntry.hash === s.hash ? " · unchanged" : ` · now <span class="mono">${esc(s.hash.slice(0, 12))}</span> (drifted)`}${lockEntry.source?.kind === "git" ? ` · ${esc(lockEntry.source.remote ?? "git")}@${esc((lockEntry.source.commit ?? "").slice(0, 7))}` : lockEntry.source?.version ? ` · v${esc(lockEntry.source.version)}` : ""}`
    : `not locked — run <code>typecase lock</code>`;

  body.innerHTML = `
    <div class="rows">
      ${row("Triggers", esc(s.triggers) || null)}
      ${whenUse ? row("When to use", esc(whenUse)) : ""}
      ${row("When not to use", s.whenNot ? esc(s.whenNot) : "<span class='value muted'>not declared</span>")}
      ${row("Tools it can call", toolChips || riskyOnly ? `<div class="tool-chips">${toolChips}${riskyOnly}</div>` : "<span class='value muted'>none mentioned</span>")}
      ${row("Files referenced", s.files.length ? `<ul>${s.files.map((f) => `<li class="mono">${esc(f)}</li>`).join("")}</ul>` : "<span class='value muted'>none</span>")}
      ${row("Path", `<div class="path-row"><span class="mono">${esc(s.path)}</span><button class="mini-btn" id="reveal-btn">Reveal in Finder</button><button class="mini-btn" id="editor-btn">Open in Cursor</button></div>`)}
      ${(overlapLinks || dupLine) ? row("Overlaps with", `<ul>${dupLine}${overlapLinks}</ul>`) : ""}
      ${row("Version / lock", lockHtml)}
      ${row("Size", `~${s.tokens} tokens · ${s.sections.length} sections`)}
    </div>`;

  body.querySelector("#reveal-btn").addEventListener("click", () => window.typecase.reveal(s.path));
  body.querySelector("#editor-btn").addEventListener("click", () => window.typecase.openEditor(s.dir));
  for (const a of body.querySelectorAll("[data-goto]"))
    a.addEventListener("click", () => a.dataset.goto && openDetail(a.dataset.goto));
}

async function renderTabSource(body, s) {
  body.innerHTML = `<div class="source-block">Loading…</div>`;
  try {
    const raw = await window.typecase.raw(s.path);
    body.querySelector(".source-block").textContent = raw;
  } catch (e) {
    body.querySelector(".source-block").textContent = `Could not read ${s.path}: ${e.message}`;
  }
}

function diffItemHtml(c) {
  switch (c.kind) {
    case "section-added": return `<li class="added">New section “${esc(c.heading)}”</li>`;
    case "section-removed": return `<li class="removed">Section “${esc(c.heading)}” removed</li>`;
    case "section-changed": return `<li class="changed">Section “${esc(c.heading)}” rewritten</li>`;
    case "description": return `<li class="changed">Description changed</li>`;
    case "triggers": return `<li class="changed">Triggers changed</li>`;
    case "when-not": return `<li class="changed">“When not to use” changed</li>`;
    case "commands": return `<li class="changed">Commands: ${c.added?.length ? `+${c.added.map(esc).join(", ")}` : ""} ${c.removed?.length ? `−${c.removed.map(esc).join(", ")}` : ""}</li>`;
    case "risky-tools": return `<li class="removed">Risky tools: ${c.added?.length ? `+${c.added.map(esc).join(", ")}` : ""} ${c.removed?.length ? `−${c.removed.map(esc).join(", ")}` : ""}</li>`;
    case "files": return `<li class="changed">Files referenced: ${(c.added ?? []).length} added, ${(c.removed ?? []).length} removed</li>`;
    default: return `<li>${esc(c.kind)}</li>`;
  }
}

function renderTabHistory(body, s, { lockEntry, change }) {
  let html = "";
  if (!data.lock) {
    html = `<div class="empty-hint">No <code>skills.lock</code> in ${esc(data.cwd)} yet. Run <code>typecase lock</code> to pin every installed skill, then this tab shows what changed and why it matters.</div>`;
  } else {
    if (change) {
      html += `<div class="history-entry">
        <h3>Since lock <span class="hash">${esc(change.fromHash ?? "")}${change.toHash ? " → " + esc(change.toHash) : ""}</span></h3>
        <div class="para">${esc((change.paragraph ?? "").replace(/\*\*/g, ""))}</div>
        ${change.changes?.length ? `<ul class="diff-list">${change.changes.map(diffItemHtml).join("")}</ul>` : ""}
      </div>`;
    } else {
      html += `<div class="empty-hint">Unchanged since lock${lockEntry ? ` (<span class="mono">${esc(lockEntry.hash.slice(0, 12))}</span>, ${esc(new Date(data.lock.generatedAt).toLocaleString())})` : ""}.</div>`;
    }
    if (lockEntry) {
      html += `<div class="history-entry">
        <h3>Locked version <span class="hash">${esc(lockEntry.hash.slice(0, 12))}</span></h3>
        <div class="para">Pinned ${esc(new Date(data.lock.generatedAt).toLocaleString())} · ${
          lockEntry.source?.kind === "git"
            ? `from ${esc(lockEntry.source.remote ?? "git")} @ ${esc((lockEntry.source.commit ?? "").slice(0, 7))}`
            : lockEntry.source?.version ? `plugin v${esc(lockEntry.source.version)}` : "local install"
        } · ~${lockEntry.tokens} tokens. Restore with <code>typecase pin ${esc(s.name)}</code>.</div>
      </div>`;
    }
  }
  const relevant = (data.changelog || "")
    .split(/^## /m).slice(1)
    .filter((block) => block.includes(`**${s.name}**`))
    .map((block) => {
      const [date, ...lines] = block.split("\n");
      const mine = lines.filter((l) => l.includes(`**${s.name}**`)).map((l) => l.replace(/^- /, ""));
      return `<div class="history-entry"><h3>${esc(date.trim())}</h3>${mine.map((m) => `<div class="para">${esc(m.replace(/\*\*/g, ""))}</div>`).join("")}</div>`;
    }).join("");
  if (relevant) html += relevant;
  body.innerHTML = html;
}

/* ---------- keyboard ---------- */

function gridColumns() {
  const cards = document.querySelectorAll("#grid .card");
  if (cards.length < 2) return 1;
  const top0 = cards[0].offsetTop;
  let n = 1;
  while (n < cards.length && cards[n].offsetTop === top0) n++;
  return n;
}

function moveFocus(delta) {
  const cards = [...document.querySelectorAll("#grid .card")];
  if (!cards.length) return;
  state.focusIndex = Math.max(0, Math.min(cards.length - 1, (state.focusIndex < 0 ? 0 : state.focusIndex + delta)));
  cards.forEach((c, i) => c.classList.toggle("focused", i === state.focusIndex));
  cards[state.focusIndex].scrollIntoView({ block: "nearest", behavior: prefersReduced ? "auto" : "smooth" });
}

document.addEventListener("keydown", (e) => {
  const paletteOpen = !$("#palette-backdrop").hidden;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    paletteOpen ? closePalette() : openPalette();
    return;
  }
  if (paletteOpen) return;
  if ((e.metaKey || e.ctrlKey) && e.key === "\\") { e.preventDefault(); $("#toggle-sidebar").click(); return; }
  if (state.view === "detail") {
    if (e.key === "Escape") closeDetail();
    if (e.key === "1") setTab("rendered");
    if (e.key === "2") setTab("source");
    if (e.key === "3") setTab("history");
    return;
  }
  if (e.target.tagName === "INPUT") return;
  const cols = gridColumns();
  if (e.key === "ArrowRight") { e.preventDefault(); moveFocus(1); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); moveFocus(-1); }
  else if (e.key === "ArrowDown") { e.preventDefault(); moveFocus(cols); }
  else if (e.key === "ArrowUp") { e.preventDefault(); moveFocus(-cols); }
  else if (e.key === "Enter" && state.focusIndex >= 0) {
    const card = document.querySelectorAll("#grid .card")[state.focusIndex];
    if (card) openDetail(card.dataset.key, card);
  }
});

/* ---------- command palette ---------- */

let paletteSel = 0;
function openPalette() {
  $("#palette-backdrop").hidden = false;
  const input = $("#palette-input");
  input.value = "";
  paletteSel = 0;
  renderPalette("");
  input.focus();
}
function closePalette() { $("#palette-backdrop").hidden = true; }

function paletteMatches(q) {
  return data.skills
    .filter((s) => !s.error)
    .map((s) => ({ s, score: fuzzyScore(q, s) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name))
    .slice(0, 12);
}

function renderPalette(q) {
  const results = $("#palette-results");
  const matches = paletteMatches(q);
  paletteSel = Math.min(paletteSel, Math.max(0, matches.length - 1));
  results.replaceChildren(...matches.map((m, i) => {
    const d = document.createElement("div");
    d.className = "palette-row" + (i === paletteSel ? " selected" : "");
    d.innerHTML = `<span class="name">${esc(m.s.name)}</span><span class="d">${esc(m.s.description ?? "")}</span><span class="t">${esc(toolLabel(m.s.tool))} · ${esc(m.s.scope)}</span>`;
    d.addEventListener("click", () => { closePalette(); openDetail(keyOf(m.s)); });
    results.appendChild(d);
    return d;
  }));
}

$("#palette-input").addEventListener("input", (e) => { paletteSel = 0; renderPalette(e.target.value); });
$("#palette-input").addEventListener("keydown", (e) => {
  const matches = paletteMatches(e.target.value);
  if (e.key === "Escape") closePalette();
  else if (e.key === "ArrowDown") { e.preventDefault(); paletteSel = Math.min(paletteSel + 1, matches.length - 1); renderPalette(e.target.value); }
  else if (e.key === "ArrowUp") { e.preventDefault(); paletteSel = Math.max(paletteSel - 1, 0); renderPalette(e.target.value); }
  else if (e.key === "Enter" && matches[paletteSel]) { closePalette(); openDetail(keyOf(matches[paletteSel].s)); }
});
$("#palette-backdrop").addEventListener("click", (e) => { if (e.target.id === "palette-backdrop") closePalette(); });

/* ---------- toolbar wiring ---------- */

function setTab(tab) {
  state.tab = tab;
  render();
}

$("#toggle-sidebar").addEventListener("click", () => $("#app").classList.toggle("sidebar-hidden"));
$("#density-btn").addEventListener("click", () => {
  state.density = state.density === "cozy" ? "compact" : "cozy";
  $("#density-btn").classList.toggle("active", state.density === "compact");
  render();
});
for (const b of document.querySelectorAll("#layout-group .tb-btn"))
  b.addEventListener("click", () => { state.layout = b.dataset.layout; render(); });
for (const b of document.querySelectorAll(".chip"))
  b.addEventListener("click", () => {
    state.chips[b.dataset.chip] = !state.chips[b.dataset.chip];
    b.classList.toggle("active", state.chips[b.dataset.chip]);
    render();
  });
for (const b of document.querySelectorAll(".swatch"))
  b.addEventListener("click", () => { state.theme = b.dataset.theme; applyTheme(); });
$("#search-pill").addEventListener("click", openPalette);
for (const b of document.querySelectorAll("#segmented button"))
  b.addEventListener("click", () => setTab(b.dataset.tab));

/* ---------- render root ---------- */

function render() {
  for (const b of document.querySelectorAll("#layout-group .tb-btn"))
    b.classList.toggle("active", b.dataset.layout === state.layout);
  renderSidebar();
  if (state.view === "detail") renderDetail();
  else renderGrid();
}

async function load() {
  data = await window.typecase.data();
  if (data.platform === "darwin") document.body.classList.add("mac");
  render();
}

window.typecase.onSkillsChanged(async () => {
  data = await window.typecase.data();
  render();
});

applyTheme();
load();
