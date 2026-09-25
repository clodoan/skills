import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("./ramble.mjs", import.meta.url));

let base;
before(() => {
  base = mkdtempSync(path.join(tmpdir(), "ramble-test-"));
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

function runRamble(root, args = []) {
  const out = path.join(root, "ramble-out");
  const res = spawnSync(process.execPath, [CLI, root, "--out", out, ...args], { encoding: "utf8" });
  const read = (f) => {
    try { return readFileSync(path.join(out, f), "utf8"); } catch { return ""; }
  };
  return { code: res.status, out: res.stdout + res.stderr, mmd: read("flow.mmd"), md: read("flow.md") };
}

/** Node labels and edges ("from -kind-> to", by label) of a flow.mmd. */
function graph(mmd) {
  const labels = new Map();
  for (const m of mmd.matchAll(/^\s*(\w+)(?:\["(.*)"\]|\{\{"(.*)"\}\})\s*$/gm)) labels.set(m[1], m[2] ?? m[3]);
  const edges = [];
  const re = /^\s*(\w+) (?:-->|-\. (\w+) \.->|-\.->\|"([^"]*)"\|)\s*(\w+)\s*$/gm;
  for (const m of mmd.matchAll(re)) {
    const kind = m[2] ?? (m[3] !== undefined ? m[3] : "link");
    edges.push(`${labels.get(m[1])} -${kind}-> ${labels.get(m[4])}`);
  }
  return { labels: [...labels.values()], edges };
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
  const { code, out, mmd, md } = runRamble(root);
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

  assert.deepEqual(graph(mmd).edges.sort(), [
    "/ -link-> /dashboard",
    "/dashboard -link-> /posts/:id",
    "/login -redirect-> /dashboard",
    "middleware -middleware-> /login",
  ]);
});

test("edge targets resolve template literals against dynamic routes", () => {
  const root = makeApp("templit", {
    "package.json": "{}",
    "app/page.tsx": "export default () => <Link href={`/items/${item.id}`}>x</Link>",
    "app/items/[itemId]/page.tsx": "export default () => null",
  });
  const { code, mmd } = runRamble(root);
  assert.equal(code, 0);
  assert.deepEqual(graph(mmd).edges, ["/ -link-> /items/:itemId"]);
});

test("next pages router: index, nested, dynamic; _app and api excluded", () => {
  const root = makeApp("nextpages", {
    "package.json": `{"dependencies":{"next":"15"}}`,
    "pages/index.tsx": "export default () => null",
    "pages/about.tsx": "export default () => null",
    "pages/blog/[slug].tsx": "export default () => null",
    "pages/_app.tsx": "export default () => null",
    "pages/api/hello.ts": "export default () => {}",
  });
  const { code, mmd } = runRamble(root);
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
  const { code, mmd, md } = runRamble(root);
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
  const { code, mmd } = runRamble(root);
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
  const { code, mmd } = runRamble(root);
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
  const { code, mmd } = runRamble(root);
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
  const { code, mmd, md } = runRamble(root);
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
  const { code, md } = runRamble(root);
  assert.equal(code, 0);
  assert.match(md, /Unresolved navigations \(need eyes\):\*\* 2 \(0 unmatched, 2 expression, 0 relative\)/);
  assert.match(md, /`paths\.app\.getHref\(\)` at app\/page\.tsx:1 \(expression\)/);
  assert.match(md, /`dynamicUrl` at app\/page\.tsx:2 \(expression\)/);
});

test("a link to a missing route is reported as unmatched with file:line, never drawn", () => {
  const root = makeApp("selfcheck", {
    "package.json": "{}",
    "app/page.tsx": `export default () => <a href="/a">a</a>`,
    "app/a/page.tsx": `export default () => <a href="/missing">gone</a>`,
  });
  const { code, md, mmd } = runRamble(root);
  assert.equal(code, 0);
  assert.deepEqual(graph(mmd).edges, ["/ -link-> /a"]);
  assert.match(md, /`\/missing` at app\/a\/page\.tsx:1 \(unmatched\)/);
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
  assert.match(md, /Edges:\*\* 18 \(1 redirect/);
  assert.match(md, /Unresolved navigations \(need eyes\):\*\* 0/);
  assert.ok(graph(readFileSync(path.join(out, "flow.mmd"), "utf8")).edges.includes("middleware -middleware-> /login"));
});

test("no routers found is a usage error", () => {
  const root = makeApp("empty", { "README.md": "nothing here" });
  const { code, out } = runRamble(root);
  assert.equal(code, 2, out);
  assert.match(out, /no routers found/);
});

test("--thumbs without --base-url is a usage error", () => {
  const root = makeApp("thumbsargs", { "package.json": "{}", "app/page.tsx": "x" });
  const res = spawnSync(process.execPath, [CLI, root, "--thumbs"], { encoding: "utf8" });
  assert.equal(res.status, 2);
  assert.match(res.stdout + res.stderr, /--thumbs requires --base-url/);
});

test("route folders named like build output (build, public, static…) are still routes", () => {
  const files = { "package.json": "{}", "app/page.tsx": "x" };
  for (const d of ["build", "out", "public", "static", "dist", "coverage"]) files[`app/${d}/page.tsx`] = "x";
  const { code, mmd } = runRamble(makeApp("prunednames", files));
  assert.equal(code, 0);
  for (const d of ["build", "out", "public", "static", "dist", "coverage"]) {
    assert.ok(graph(mmd).labels.includes(`/${d}`), `/${d} dropped`);
  }
});

test("a symlinked directory loop in the route tree is walked once", () => {
  const root = makeApp("dirloop", { "package.json": "{}", "app/page.tsx": "x", "app/a/page.tsx": "x" });
  symlinkSync("..", path.join(root, "app", "a", "loop"));
  const { code, md, mmd } = runRamble(root);
  assert.equal(code, 0);
  assert.deepEqual(graph(mmd).labels.sort(), ["/", "/a"]);
  assert.match(md, /Screens:\*\* 2 /);
});

test("broken symlinks and unreadable directories do not crash the scan", () => {
  const root = makeApp("broken", { "package.json": "{}", "app/page.tsx": "x", "src/locked/a.ts": "x" });
  symlinkSync("./nope.ts", path.join(root, "broken.ts"));
  symlinkSync("./nope", path.join(root, "app", "gone"));
  chmodSync(path.join(root, "src", "locked"), 0o000);
  try {
    const { code, out, mmd } = runRamble(root);
    assert.equal(code, 0, out);
    assert.deepEqual(graph(mmd).labels, ["/"]);
  } finally {
    chmodSync(path.join(root, "src", "locked"), 0o755);
  }
});

test("pages router: only top-level pages/api is API; .d.ts and _middleware are not pages", () => {
  const root = makeApp("pagesapi", {
    "package.json": `{"dependencies":{"next":"15"}}`,
    "pages/index.tsx": "x",
    "pages/api/hello.ts": "x",
    "pages/docs/api/intro.tsx": "x",
    "pages/types.d.ts": "x",
    "pages/_middleware.ts": "x",
  });
  const { code, mmd } = runRamble(root);
  assert.equal(code, 0);
  assert.deepEqual(graph(mmd).labels.sort(), ["/", "/docs/api/intro"]);
});

test("node ids follow sorted route paths, independent of filesystem order", () => {
  const root = makeApp("order", { "package.json": "{}", "app/page.tsx": "x", "app/zeta/page.tsx": "x", "app/alpha/page.tsx": "x" });
  const { mmd } = runRamble(root);
  const ids = [...mmd.matchAll(/^\s*(r\d+)\["(.*)"\]$/gm)].map((m) => `${m[1]}=${m[2]}`);
  assert.deepEqual(ids, ["r0=/", "r1=/alpha", "r2=/zeta"]);
});

test("a project inside a folder named app still gets its pages router", () => {
  const root = makeApp("app/proj", { "package.json": `{"dependencies":{"next":"15"}}`, "pages/index.tsx": "x", "pages/about.tsx": "x" });
  const { code, out, mmd } = runRamble(root);
  assert.equal(code, 0, out);
  assert.deepEqual(graph(mmd).labels, ["/", "/about"]);
});

test("a route folder named app is a segment, not a second router", () => {
  const root = makeApp("nestedapp", { "package.json": "{}", "app/page.tsx": "x", "app/app/page.tsx": "x", "app/app/settings/page.tsx": "x" });
  const { code, md, mmd } = runRamble(root);
  assert.equal(code, 0);
  assert.match(md, /Routers:\*\* next-app \(app\)\n/);
  assert.deepEqual(graph(mmd).labels, ["/", "/app", "/app/settings"]);
});

test("a Vite app's src/pages components folder is not a Next pages router", () => {
  const root = makeApp("vitepages", {
    "package.json": `{"dependencies":{"react-router-dom":"^6"}}`,
    "src/main.tsx": `createBrowserRouter([{ path: "/" }, { path: "/about" }]);`,
    "src/pages/Home.tsx": "x",
    "src/pages/About.tsx": "x",
  });
  const { code, md, mmd } = runRamble(root);
  assert.equal(code, 0);
  assert.ok(!md.includes("next-pages"), md);
  assert.deepEqual(graph(mmd).labels, ["/", "/about"]);
});

test("a pages/ folder holding only api/ is not reported as a router", () => {
  const root = makeApp("apionly", { "package.json": `{"dependencies":{"next":"15"}}`, "app/page.tsx": "x", "pages/api/auth.ts": "x" });
  const { md } = runRamble(root);
  assert.match(md, /Routers:\*\* next-app \(app\)\n/);
});

test("dotted top-level folders are segments unless they look like hosts; %5F escapes _", () => {
  const root = makeApp("dotted", {
    "package.json": "{}",
    "app/page.tsx": "x",
    "app/v1.0/page.tsx": "x",
    "app/feed.xml/route.ts": "x",
    "app/%5Finternal/page.tsx": "x",
    "app/app.example.com/dashboard/page.tsx": "x",
  });
  const { code, mmd, md } = runRamble(root);
  assert.equal(code, 0);
  assert.ok(mmd.includes('["/v1.0"]'), "version folder treated as a host");
  assert.ok(mmd.includes('["/_internal"]'));
  assert.match(mmd, /subgraph \w+\["app · app\.example\.com"\]/);
  assert.match(md, /API route handlers[^\n]*:\*\* 1/);
});

test("react-router: JSX-only <Routes> apps are detected and nest by open/close tags", () => {
  const root = makeApp("rrjsx", {
    "package.json": `{"dependencies":{"react-router-dom":"^6"}}`,
    "src/App.tsx": `import { BrowserRouter, Routes, Route } from "react-router-dom";
      export default () => (
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/app" element={<Layout />}>
              <Route index element={<Dash />} />
              <Route path="inbox" element={<Inbox />} />
              <Route element={<Shell />}>
                <Route element={<Settings/>} path="settings" />
              </Route>
              <Route
                path="inbox/:id"
                element={<Msg />}
              />
            </Route>
            <Route path={"/braced"} element={<B />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      );`,
  });
  const { code, out, mmd } = runRamble(root);
  assert.equal(code, 0, out);
  assert.deepEqual(graph(mmd).labels, ["/", "/:rest*", "/app", "/app/inbox", "/app/inbox/:id", "/app/settings", "/braced"]);
});

test("react-router: path chains through a $-named config resolve", () => {
  const root = makeApp("rrdollar", {
    "package.json": "{}",
    "src/routes.ts": `export const $routes = { home: { path: "/home" } };`,
    "src/router.tsx": `createBrowserRouter([{ path: $routes.home.path }]);`,
  });
  const { code, mmd } = runRamble(root);
  assert.equal(code, 0);
  assert.deepEqual(graph(mmd).labels, ["/home"]);
});

const NEXT_PKG = `{"dependencies":{"next":"15"}}`;

test("a middleware redirect survives later quoted strings (config.matcher)", () => {
  const root = makeApp("mwmatcher", {
    "package.json": "{}",
    "app/page.tsx": "x",
    "app/login/page.tsx": "x",
    "src/middleware.ts": `import { NextResponse } from "next/server";
      export function middleware(req) {
        if (!auth) return NextResponse.redirect(new URL("/login", req.url));
        if (x) return NextResponse.rewrite(new URL("/other", req.url));
      }
      export const config = { matcher: ["/((?!api|_next).*)"] };`,
  });
  const { mmd } = runRamble(root);
  assert.deepEqual(graph(mmd).edges, ["middleware -middleware-> /login"]);
});

test("every navigation call site is an edge or a categorized entry with file:line", () => {
  const root = makeApp("categories", {
    "package.json": "{}",
    "app/a/page.tsx": "x",
    "app/page.tsx": `export default function P() {
  const navigate = useNavigate();
  navigate(-1);
  router.push({ pathname: "/a", query: { tab: 1 } });
  return <>
    <Link href={{ pathname: "/a" }}>obj</Link>
    <Link href={cond ? "/a" : "/b"}>ternary</Link>
    <Link href={\`\${base}/a\`}>base</Link>
    <Link to="../a">rel</Link>
    <a href="#top">anchor</a>
    <a href="mailto:x@y.z">mail</a>
    <a href="//cdn.example.com/x">cdn</a>
    <a href="https://example.com/y">ext</a>
    <a href="/gone">missing</a>
  </>;
}`,
  });
  const { md, mmd } = runRamble(root);
  assert.deepEqual(graph(mmd).edges, ["/ -link-> /a"]);
  assert.match(md, /Unresolved navigations \(need eyes\):\*\* 4 \(1 unmatched, 2 expression, 1 relative\)/);
  assert.match(md, /`cond \? "\/a" : "\/b"` at app\/page\.tsx:7 \(expression\)/);
  assert.match(md, /`'\$\{base\}\/a'` at app\/page\.tsx:8 \(expression\)/);
  assert.match(md, /`\.\.\/a` at app\/page\.tsx:9 \(relative\)/);
  assert.match(md, /`\/gone` at app\/page\.tsx:14 \(unmatched\)/);
  assert.match(md, /Not drawn by design:\*\* 3 external, 1 anchor, 1 history/);
  assert.match(md, /External link hosts:\*\* cdn\.example\.com, example\.com\n/);
  assert.match(md, /`-1` at app\/page\.tsx:3/);
});

test("comments and look-alike attributes are not navigations", () => {
  const root = makeApp("lookalike", {
    "package.json": "{}",
    "app/a/page.tsx": "x",
    "app/page.tsx": `// <Link href="/a">old</Link>
/* router.push("/a") */
export default () => <>
  {/* <a href="/a">x</a> */}
  <div data-href="/a" />
  <svg><use xlink:href="#icon" /></svg>
  <p>see https://example.com/docs</p>
</>;`,
  });
  const { md, mmd } = runRamble(root);
  assert.deepEqual(graph(mmd).edges, []);
  assert.match(md, /Unresolved navigations \(need eyes\):\*\* 0/);
  assert.match(md, /Not drawn by design:\*\* none/);
});

test("the console summary always includes the unresolved line", () => {
  const root = makeApp("console", {
    "package.json": "{}",
    "app/page.tsx": `export default () => <a href="/nope">x</a>`,
    "app/feed/(.)photo/page.tsx": "x",
    "app/feed/(..)(..)x/page.tsx": "x",
    "app/feed/page.tsx": "x",
  });
  const { out } = runRamble(root);
  assert.match(out, /Unresolved navigations \(need eyes\):\*\* 1 \(1 unmatched/);
});
