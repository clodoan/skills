import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("./map.mjs", import.meta.url));

let base;
before(() => {
  base = mkdtempSync(path.join(tmpdir(), "map-test-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
});

function makeApp(name, files) {
  const root = path.join(base, name);
  for (const [file, contents] of Object.entries(files)) {
    const full = path.join(root, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

function runMap(root, args = []) {
  const out = path.join(root, "map-out");
  const res = spawnSync(process.execPath, [CLI, root, "--out", out, ...args], { encoding: "utf8" });
  const read = (f) => {
    try { return readFileSync(path.join(out, f), "utf8"); } catch { return ""; }
  };
  return { code: res.status, out: res.stdout + res.stderr, mmd: read("flow.mmd"), md: read("flow.md") };
}

test("next app router: groups, dynamic, catch-alls, slots, intercepts, privates", () => {
  const root = makeApp("nextapp", {
    "package.json": "{}",
    "app/page.tsx": `export default () => <a href="/dashboard">go</a>`,
    "app/(marketing)/pricing/page.tsx": "export default () => null",
    "app/(auth)/login/page.tsx": `import { redirect } from "next/navigation";
      export default () => redirect("/dashboard")`,
    "app/dashboard/page.tsx": `export default () => <Link href={\`/posts/\${id}\`}>p</Link>`,
    "app/posts/[id]/page.tsx": "export default () => null",
    "app/docs/[...slug]/page.tsx": "export default () => null",
    "app/wiki/[[...path]]/page.tsx": "export default () => null",
    "app/@modal/photo/page.tsx": "export default () => null",
    "app/feed/(.)photo/page.tsx": "export default () => null",
    "app/_private/page.tsx": "export default () => null",
    "app/api-things/route.ts": "export const GET = () => {}",
    "middleware.ts": `import { NextResponse } from "next/server";
      export function middleware() { return NextResponse.redirect(new URL("/login", req.url)); }`,
  });
  const { code, out, mmd, md } = runMap(root);
  assert.equal(code, 0, out);

  for (const route of ["/", "/pricing", "/login", "/dashboard", "/posts/:id", "/docs/:slug*", "/wiki/:path*?"]) {
    assert.ok(mmd.includes(`["${route}"]`), `route ${route} missing from diagram`);
  }
  assert.ok(!mmd.includes("_private"), "private folder leaked");
  assert.ok(!mmd.includes("@modal") && !mmd.includes('"/photo"'), "parallel slot page became a screen");
  assert.match(md, /Parallel route slots[^\n]*:\*\* 1/);
  assert.match(md, /Intercepting routes[^\n]*:\*\* 1/);
  assert.match(md, /\(\.\)photo under \/feed/);
  assert.match(md, /API route handlers[^\n]*:\*\* 1/);

  // Edges: link / → /dashboard; template literal → /posts/:id; redirect dashed; middleware dashed.
  assert.match(mmd, /r\d+ --> r\d+/);
  assert.match(mmd, /-\. redirect \.->/);
  assert.match(mmd, /middleware\{\{"middleware"\}\}/);
  assert.match(mmd, /-\. middleware \.->/);
  assert.match(md, /Self-check: every route file appears/);
});

test("edge targets resolve template literals against dynamic routes", () => {
  const root = makeApp("templit", {
    "package.json": "{}",
    "app/page.tsx": "export default () => <Link href={`/items/${item.id}`}>x</Link>",
    "app/items/[itemId]/page.tsx": "export default () => null",
  });
  const { code, mmd } = runMap(root);
  assert.equal(code, 0);
  assert.match(mmd, /r\d+ --> r\d+/);
});

test("next pages router: index, nested, dynamic; _app and api excluded", () => {
  const root = makeApp("nextpages", {
    "package.json": "{}",
    "pages/index.tsx": "export default () => null",
    "pages/about.tsx": "export default () => null",
    "pages/blog/[slug].tsx": "export default () => null",
    "pages/_app.tsx": "export default () => null",
    "pages/api/hello.ts": "export default () => {}",
  });
  const { code, mmd } = runMap(root);
  assert.equal(code, 0);
  for (const route of ["/", "/about", "/blog/:slug"]) {
    assert.ok(mmd.includes(`["${route}"]`), `route ${route} missing`);
  }
  assert.ok(!mmd.includes("_app") && !mmd.includes("api"));
});

test("a content folder named pages/ is not mistaken for a router (real case: taxonomy)", () => {
  const root = makeApp("mdxcontent", {
    "package.json": "{}",
    "app/page.tsx": "export default () => null",
    "content/pages/privacy.mdx": "# Privacy",
    "content/pages/terms.mdx": "# Terms",
  });
  const { code, mmd, md } = runMap(root);
  assert.equal(code, 0);
  assert.ok(!mmd.includes("/privacy"), "MDX content dir was treated as a pages router");
  assert.ok(!md.includes("next-pages"));
});

test("host-based app folders (real case: dub) become apps, not URL segments", () => {
  const root = makeApp("hostapp", {
    "package.json": "{}",
    "app/app.example.com/dashboard/page.tsx": "export default () => null",
    "app/admin.example.com/page.tsx": "export default () => null",
  });
  const { code, mmd } = runMap(root);
  assert.equal(code, 0);
  assert.ok(mmd.includes('["/dashboard"]'), "host folder leaked into URL path");
  assert.ok(!mmd.includes('/app.example.com/dashboard'));
  assert.match(mmd, /app\.example\.com/); // as app subgraph label
});

test("symlinked files in the route tree do not crash the walker (real case: dub)", () => {
  const root = makeApp("symlinks", {
    "package.json": "{}",
    "app/page.tsx": "export default () => null",
    "LICENSE.md": "MIT",
  });
  symlinkSync(path.join(root, "LICENSE.md"), path.join(root, "app", "LICENSE.md"));
  const { code, mmd } = runMap(root);
  assert.equal(code, 0);
  assert.ok(mmd.includes('["/"]'));
});

test("react-router: literal paths, relative nesting, splat", () => {
  const root = makeApp("rr", {
    "package.json": `{"dependencies":{"react-router-dom":"^6"}}`,
    "src/router.tsx": `import { createBrowserRouter } from "react-router-dom";
      export const router = createBrowserRouter([
        { path: "/", element: null },
        { path: "/app", children: [
          { path: "settings", element: null },
          { path: "teams/:teamId", element: null },
        ]},
        { path: "*", element: null },
      ]);`,
  });
  const { code, mmd } = runMap(root);
  assert.equal(code, 0);
  for (const route of ["/", "/app", "/app/settings", "/app/teams/:teamId", "/:rest*"]) {
    assert.ok(mmd.includes(`["${route}"]`), `route ${route} missing`);
  }
});

test("react-router central paths config resolves identifier chains (real case: bulletproof-react)", () => {
  const root = makeApp("rrpaths", {
    "package.json": `{"dependencies":{"react-router-dom":"^6"}}`,
    "src/config/paths.ts": `export const paths = {
        home: { path: '/', getHref: () => '/' },
        auth: { login: { path: '/auth/login', getHref: () => '/auth/login' } },
        app: {
          root: { path: '/app', getHref: () => '/app' },
          discussions: { path: 'discussions', getHref: () => '/app/discussions' },
        },
      };`,
    "src/router.tsx": `import { createBrowserRouter } from "react-router-dom";
      import { paths } from './config/paths';
      export const router = createBrowserRouter([
        { path: paths.home.path, element: null },
        { path: paths.auth.login.path, element: null },
        { path: paths.app.root.path, children: [
          { path: paths.app.discussions.path, element: null },
        ]},
      ]);`,
  });
  const { code, mmd, md } = runMap(root);
  assert.equal(code, 0);
  for (const route of ["/", "/auth/login", "/app", "/app/discussions"]) {
    assert.ok(mmd.includes(`["${route}"]`), `route ${route} missing`);
  }
  assert.match(md, /Unresolved route path expressions:\*\* 0/);
});

test("expression-valued navigations are reported, not dropped", () => {
  const root = makeApp("exprnav", {
    "package.json": "{}",
    "app/page.tsx": `export default () => <Link to={paths.app.getHref()}>x</Link>;
      const g = () => router.push(dynamicUrl);`,
    "app/other/page.tsx": "export default () => null",
  });
  const { code, md } = runMap(root);
  assert.equal(code, 0);
  assert.match(md, /Unresolved navigations[^:]*:\*\* 2 \(2 expression-valued\)/);
  assert.match(md, /\{paths\.app\.getHref\(\)\}/);
  assert.match(md, /\{dynamicUrl\}/);
});

test("every route file appears in the diagram and every edge resolves (self-check)", () => {
  const root = makeApp("selfcheck", {
    "package.json": "{}",
    "app/page.tsx": `export default () => <a href="/a">a</a>`,
    "app/a/page.tsx": `export default () => <a href="/missing">gone</a>`,
  });
  const { code, md } = runMap(root);
  assert.equal(code, 0);
  assert.match(md, /Self-check: every route file appears/);
  // /missing has no route: must land in unresolved, never in the diagram.
  assert.match(md, /`\/missing` at/);
});

test("bundled grok-chat fixture maps to its documented shape", () => {
  const fixture = fileURLToPath(new URL("../fixtures/grok-chat", import.meta.url));
  const out = path.join(base, "grokchat-out");
  const res = spawnSync(process.execPath, [CLI, fixture, "--out", out], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const md = readFileSync(path.join(out, "flow.md"), "utf8");
  assert.match(md, /Screens:\*\* 11/);
  assert.match(md, /Parallel route slots[^\n]*:\*\* 1 — @history/);
  assert.match(md, /\(\.\)share under \/c\/:chatId/);
  assert.match(md, /-\. middleware \.->/);
  assert.match(md, /Self-check: every route file appears/);
});

test("no routers found is a usage error", () => {
  const root = makeApp("empty", { "README.md": "nothing here" });
  const { code, out } = runMap(root);
  assert.equal(code, 2, out);
  assert.match(out, /no routers found/);
});

test("--thumbs without --base-url is a usage error", () => {
  const root = makeApp("thumbsargs", { "package.json": "{}", "app/page.tsx": "x" });
  const res = spawnSync(process.execPath, [CLI, root, "--thumbs"], { encoding: "utf8" });
  assert.equal(res.status, 2);
  assert.match(res.stdout + res.stderr, /--thumbs requires --base-url/);
});
