import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildProject } from "../src/build.js";
import { startDevServer } from "../src/dev.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(projectRoot, "bin", "dominion.js");

function createProject(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "dominion-build-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeProjectFile(root, relativePath, contents) {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

function runBuild(root, ...args) {
  return spawnSync(process.execPath, [cliPath, "build", ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function runInit(root, ...args) {
  return spawnSync(process.execPath, [cliPath, "init", ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

async function waitFor(check, message, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(message);
}

async function getText(url) {
  const response = await fetch(url);
  return { status: response.status, text: await response.text() };
}

function findChromiumBrowser() {
  const candidates = [
    process.env.DOMINION_BROWSER,
    process.env.CHROME_BIN,
    process.env.EDGE_BIN,
    process.env.CHROMIUM_BIN,
    path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "msedge",
    "chrome",
    "chromium",
    "chromium-browser",
  ].filter(Boolean);

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true });
    if (!result.error && result.status === 0) {
      return candidate;
    }
  }
}

function stripGeneratedStyles(html) {
  return html.replace(/<style>[\s\S]*?<\/style>/g, "");
}

test("init scaffolds a buildable native multipage project", (t) => {
  const root = createProject(t);

  const initResult = runInit(root);

  assert.equal(initResult.status, 0, initResult.stderr || initResult.error?.message);
  for (const directory of ["src", "shared", "public"]) {
    assert.ok(existsSync(path.join(root, directory)), `${directory}/ exists`);
  }
  assert.ok(existsSync(path.join(root, "tailwind.css")));
  assert.ok(existsSync(path.join(root, "dominion.config.json")));
  const packageConfig = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(packageConfig.scripts.build, "dominion build");
  assert.equal(packageConfig.scripts.dev, "dominion dev");

  const buildResult = runBuild(root);

  assert.equal(buildResult.status, 0, buildResult.stderr || buildResult.error?.message);
  const home = stripGeneratedStyles(readFileSync(path.join(root, "dist/index.html"), "utf8"));
  const about = stripGeneratedStyles(readFileSync(path.join(root, "dist/about/index.html"), "utf8"));
  assert.match(home, /<nav[^>]*aria-label="Main navigation"/);
  assert.doesNotMatch(home, /dominion-navigation/);
  assert.match(home, /Welcome to DOMinion/);
  assert.match(about, /About this example/);
  assert.match(readFileSync(path.join(root, "dist/index.html"), "utf8"), /\.bg-brand/);
  assert.ok(existsSync(path.join(root, "dist/images/mark.svg")));
});

test("init refuses existing scaffold files unless --force is explicit", (t) => {
  const root = createProject(t);
  const firstResult = runInit(root);
  assert.equal(firstResult.status, 0, firstResult.stderr || firstResult.error?.message);
  writeProjectFile(root, "src/index.html", "<h1>Keep this until authorized</h1>\n");
  writeProjectFile(root, "src/custom.html", "<h1>Unrelated page</h1>\n");

  const refusedResult = runInit(root);

  assert.notEqual(refusedResult.status, 0);
  assert.match(refusedResult.stderr, /Refusing to overwrite existing project files/);
  assert.match(refusedResult.stderr, /--force/);
  assert.equal(readFileSync(path.join(root, "src/index.html"), "utf8"), "<h1>Keep this until authorized</h1>\n");

  const forcedResult = runInit(root, "--force");

  assert.equal(forcedResult.status, 0, forcedResult.stderr || forcedResult.error?.message);
  assert.match(readFileSync(path.join(root, "src/index.html"), "utf8"), /Welcome to DOMinion/);
  assert.equal(readFileSync(path.join(root, "src/custom.html"), "utf8"), "<h1>Unrelated page</h1>\n");
});

test("init refuses to write scaffold files through a directory symlink", (t) => {
  const root = createProject(t);
  const externalRoot = mkdtempSync(path.join(os.tmpdir(), "dominion-init-target-"));
  t.after(() => rmSync(externalRoot, { recursive: true, force: true }));
  try {
    symlinkSync(externalRoot, path.join(root, "src"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EACCES", "EPERM", "ENOSYS"].includes(error.code)) {
      t.skip(`Directory symlinks are unavailable: ${error.message}`);
      return;
    }
    throw error;
  }

  const result = runInit(root, "--force");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to write project files through a symbolic link: src/);
  assert.equal(existsSync(path.join(externalRoot, "index.html")), false);
  assert.equal(existsSync(path.join(root, "package.json")), false);
});

test("dev serves production output and rebuilds all watched project inputs", async (t) => {
  const root = createProject(t);
  const initResult = runInit(root);
  assert.equal(initResult.status, 0, initResult.stderr || initResult.error?.message);
  writeProjectFile(root, "dominion.config.json", JSON.stringify({ basePath: "/preview/project/" }));

  const occupiedServer = createServer();
  await new Promise((resolve) => occupiedServer.listen(0, "127.0.0.1", resolve));
  const occupiedPort = occupiedServer.address().port;
  const dev = await startDevServer({ rootDir: root, basePath: "/preview/project/", port: occupiedPort });
  const originalStderrWrite = process.stderr.write;
  const buildErrors = [];
  process.stderr.write = function (chunk, ...args) {
    if (String(chunk).includes("dominion dev: build failed:")) {
      buildErrors.push(String(chunk));
    }
    return originalStderrWrite.call(this, chunk, ...args);
  };
  t.after(async () => {
    process.stderr.write = originalStderrWrite;
    await dev.close();
    await new Promise((resolve) => occupiedServer.close(resolve));
  });

  const preview = new URL(dev.url);
  const prefix = `${preview.origin}/preview/project`;
  assert.notEqual(Number(preview.port), occupiedPort);

  const home = await getText(`${prefix}/`);
  const about = await getText(`${prefix}/about/`);
  const asset = await getText(`${prefix}/images/mark.svg`);
  assert.equal(home.status, 200);
  assert.match(home.text, /href="\/preview\/project\/about\/"/);
  assert.equal(about.status, 200);
  assert.match(about.text, /About this example/);
  assert.equal(asset.status, 200);
  assert.match(asset.text, /DOMinion mark/);
  assert.equal((await getText(`${prefix}/missing.html`)).status, 404);
  assert.equal((await getText(`${preview.origin}/`)).status, 404);

  writeProjectFile(root, "src/stale.html", "<h1>Temporary route</h1>\n");
  await waitFor(async () => (await getText(`${prefix}/stale.html`)).status === 200, "new page was not rebuilt");
  writeProjectFile(root, "src/about/index.html", "<!doctype html><title>About</title><h1>Page rebuilt</h1>\n");
  await waitFor(async () => (await getText(`${prefix}/about/`)).text.includes("Page rebuilt"), "page edit was not rebuilt");
  writeProjectFile(root, "shared/navigation.html", "<header><nav>Fragment rebuilt</nav></header>\n");
  await waitFor(async () => (await getText(`${prefix}/`)).text.includes("Fragment rebuilt"), "fragment edit was not rebuilt");
  writeProjectFile(root, "public/images/mark.svg", "updated asset\n");
  await waitFor(async () => (await getText(`${prefix}/images/mark.svg`)).text === "updated asset\n", "asset edit was not copied");
  writeProjectFile(root, "src/about/index.html", "<!doctype html><title>About</title><h1 class=\"text-preview\">Theme rebuilt</h1>\n");
  await waitFor(async () => (await getText(`${prefix}/about/`)).text.includes("Theme rebuilt"), "page edit was not rebuilt");
  writeProjectFile(root, "tailwind.css", "@theme { --color-preview: #123456; }\n");
  await waitFor(async () => (await getText(`${prefix}/about/`)).text.includes(".text-preview{color:var(--color-preview)}"), "theme edit was not rebuilt");

  const goodHome = await getText(`${prefix}/`);
  writeProjectFile(root, "src/index.html", "<dominion-missing></dominion-missing>\n");
  await waitFor(() => buildErrors.length > 0, "build failure was not reported to stderr");
  const preservedHome = await getText(`${prefix}/`);
  assert.equal(preservedHome.status, 200);
  assert.equal(preservedHome.text, goodHome.text);

  rmSync(path.join(root, "src/stale.html"));
  writeProjectFile(root, "src/index.html", "<!doctype html><title>Restored</title><h1>Recovered</h1>\n");
  await waitFor(async () => (await getText(`${prefix}/stale.html`)).status === 404, "deleted page left a stale route");
  await waitFor(async () => (await getText(`${prefix}/`)).text.includes("Recovered"), "preview did not recover after the build error");
});

test("dev resumes watching a nested source directory after it is recreated", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dominion-build-"));
  let dev;
  t.after(async () => {
    if (dev) {
      await dev.close();
    }
    rmSync(root, { recursive: true, force: true });
  });
  writeProjectFile(root, "src/index.html", "<h1>Home</h1>\n");
  writeProjectFile(root, "src/about/index.html", "<h1>Original page</h1>\n");
  dev = await startDevServer({ rootDir: root, port: 0 });

  assert.match((await getText(`${dev.url}about/`)).text, /Original page/);
  rmSync(path.join(root, "src/about"), { recursive: true });
  mkdirSync(path.join(root, "src/about"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  writeProjectFile(root, "src/about/index.html", "<h1>Recreated page</h1>\n");

  await waitFor(async () => (await getText(`${dev.url}about/`)).text.includes("Recreated page"), "preview did not rebuild an edit in a recreated directory");
});

test("CLI shows help and exits nonzero for an invalid deployment base path", (t) => {
  const root = createProject(t);
  const helpResult = spawnSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" });
  writeProjectFile(root, "src/index.html", "<h1>Home</h1>\n");
  writeProjectFile(root, "dominion.config.json", JSON.stringify({ basePath: "relative/path" }));

  const buildResult = runBuild(root);

  assert.equal(helpResult.status, 0);
  assert.match(helpResult.stdout, /Usage:[\s\S]*dominion build/);
  assert.match(helpResult.stdout, /dominion\.config\.json:.*basePath/);
  assert.notEqual(buildResult.status, 0);
  assert.match(buildResult.stderr, /basePath must be an absolute URL path/);
  assert.equal(existsSync(path.join(root, "dist")), false);
});

test("build preserves page paths, copies public assets, and excludes shared sources", (t) => {
  const root = createProject(t);
  writeProjectFile(root, "src/products/item.html", "<h1>Item</h1>\n<a href=\"/images/logo.svg\">Logo</a>\n");
  writeProjectFile(root, "src/about/index.html", "<h1>About</h1>\n");
  writeProjectFile(root, "public/images/logo.svg", "<svg></svg>\n");
  writeProjectFile(root, "shared/navigation.html", "<nav>Shared</nav>\n");

  const result = runBuild(root);

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const item = stripGeneratedStyles(readFileSync(path.join(root, "dist/products/item.html"), "utf8"));
  const about = stripGeneratedStyles(readFileSync(path.join(root, "dist/about/index.html"), "utf8"));
  assert.ok(item.includes("<h1>Item</h1>\n<a href=\"/images/logo.svg\">Logo</a>\n"));
  assert.ok(about.includes("<h1>About</h1>\n"));
  assert.equal(readFileSync(path.join(root, "dist/images/logo.svg"), "utf8"), "<svg></svg>\n");
  assert.equal(existsSync(path.join(root, "dist/shared/navigation.html")), false);
});

test("build emits minified page-specific Tailwind CSS from expanded page states and project theme", (t) => {
  const root = createProject(t);
  writeProjectFile(root, "src/index.html", `<!doctype html><html><head><title>Home</title></head><body>
<div class="text-red-600 bg-brand"></div>
<template><div class="hidden text-amber-700"></div></template>
</body></html>`);
  writeProjectFile(root, "src/other.html", `<!doctype html><html><head><title>Other</title></head><body><p class="underline"></p></body></html>`);
  writeProjectFile(root, "tailwind.css", "@theme { --color-brand: #123456; }\n");

  const result = runBuild(root);

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  for (const page of ["index.html", "other.html"]) {
    const output = readFileSync(path.join(root, "dist", page), "utf8");
    assert.equal(output.split("<style").length - 1, 1, page);
    const head = output.slice(output.indexOf("<head>"), output.indexOf("</head>"));
    assert.ok(head.includes("<style"), page);
  }
  const home = readFileSync(path.join(root, "dist/index.html"), "utf8");
  const other = readFileSync(path.join(root, "dist/other.html"), "utf8");
  assert.ok(home.includes(".text-red-600{color:var(--color-red-600)}"));
  assert.ok(home.includes(".bg-brand{background-color:var(--color-brand)}"));
  assert.ok(home.includes(".text-amber-700"));
  assert.ok(!home.includes(".underline"));
  assert.ok(other.includes(".underline"));
  assert.ok(!other.includes(".text-red-600"));
  assert.ok(!other.includes(".bg-brand"));
  assert.ok(!other.includes(".text-amber-700"));
});

test("build scopes used fragment styles to authored roots and excludes nested fragments", (t) => {
  const root = createProject(t);
  writeProjectFile(root, "src/index.html", `<!doctype html><html><head><title>Scopes</title></head><body>
<dominion-shell><p slot="body" class="supplied text-green-700">Supplied</p></dominion-shell>
<dominion-shell><p slot="body">Second</p></dominion-shell>
</body></html>`);
  writeProjectFile(root, "shared/shell.html", `<style>.shell { color: red; --inherited: teal; } .supplied { color: green; }</style>
<section class="shell text-blue-600"><slot name="body"></slot><dominion-inner></dominion-inner></section>`);
  writeProjectFile(root, "shared/inner.html", `<style>.inner { color: blue; }</style><article class="inner">Nested</article>`);
  writeProjectFile(root, "shared/unused.html", `<style>.unused { color: orange; }</style><aside class="unused">Unused</aside>`);

  const result = runBuild(root);

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const output = readFileSync(path.join(root, "dist/index.html"), "utf8");
  const styles = [...output.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  assert.equal(styles.length, 1);
  assert.doesNotMatch(styles[0][1].replace(/^\/\*![\s\S]*?\*\/\s*/, ""), /\r?\n/);
  assert.equal((styles[0][1].match(/@scope\s*\(/g) ?? []).length, 4);
  assert.ok(styles[0][1].indexOf("@layer components{") < styles[0][1].indexOf("@layer utilities{"));
  assert.ok(styles[0][1].includes(".shell{color:red;--inherited:teal}"));
  assert.ok(styles[0][1].includes(".text-blue-600{color:var(--color-blue-600)}"));
  assert.ok(styles[0][1].includes(".text-green-700{color:var(--color-green-700)}"));
  assert.ok(styles[0][1].includes(".text-blue-600{"));
  assert.match(styles[0][1], /to\s*\(\[data-dominion-scope=/);
  assert.ok(styles[0][1].includes("--inherited:teal"));
  assert.ok(styles[0][1].includes("data-dominion-scope"));
  assert.ok(!styles[0][1].includes(".unused"));
  assert.ok(!output.includes("<style>.shell"));
  assert.ok(output.includes('class="supplied text-green-700"'));
  assert.ok(output.includes('class="inner"'));
});

test("fragment root selectors style the root and inherit without leaking into nested fragments", (t) => {
  const browser = findChromiumBrowser();
  if (!browser) {
    t.skip("No Chromium-based browser found; set DOMINION_BROWSER to run this browser regression");
    return;
  }

  const root = createProject(t);
  writeProjectFile(root, "src/index.html", `<!doctype html><html><head><title>Fragment CSS</title></head><body>
<dominion-shell></dominion-shell>
<pre id="computed"></pre>
<script>
const style = (id) => getComputedStyle(document.getElementById(id));
document.getElementById("computed").textContent = JSON.stringify({
  rootColor: style("shell").color,
  inheritedToken: style("child").getPropertyValue("--fragment-token").trim(),
  childColor: style("child").color,
  nestedColor: style("nested").color,
  nestedOuterToken: style("nested").getPropertyValue("--outer-only").trim(),
});
</script>
</body></html>`);
  writeProjectFile(root, "shared/shell.html", `<style>
.shell { color: red; --fragment-token: teal; }
.child { color: blue; }
.nested-root { color: red; --outer-only: leaked; }
</style>
<section class="shell" id="shell"><p class="child" id="child">Child</p><dominion-inner></dominion-inner></section>`);
  writeProjectFile(root, "shared/inner.html", `<style>.nested-root { color: green; }</style><article class="nested-root" id="nested">Nested</article>`);

  const buildResult = runBuild(root);
  assert.equal(buildResult.status, 0, buildResult.stderr || buildResult.error?.message);

  const pagePath = path.join(root, "dist/index.html");
  const browserResult = spawnSync(browser, [
    "--headless",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${path.join(root, "browser-profile")}`,
    "--dump-dom",
    pathToFileURL(pagePath).href,
  ], { encoding: "utf8", windowsHide: true });

  assert.equal(browserResult.status, 0, browserResult.stderr || browserResult.error?.message);
  const computed = browserResult.stdout.match(/<pre id="computed">([\s\S]*?)<\/pre>/);
  assert.ok(computed, browserResult.stdout);
  const styles = JSON.parse(computed[1]);
  assert.equal(styles.rootColor, "rgb(255, 0, 0)");
  assert.equal(styles.inheritedToken, "teal");
  assert.equal(styles.childColor, "rgb(0, 0, 255)");
  assert.equal(styles.nestedColor, "rgb(0, 128, 0)");
  assert.equal(styles.nestedOuterToken, "");
});

test("build rejects nonlocal fragment CSS constructs with source context", (t) => {
  for (const css of [
    "@font-face { font-family: icon; src: url(icon.woff2); }",
    "@keyframes pulse { from { opacity: 0; } to { opacity: 1; } }",
  ]) {
    const root = createProject(t);
    writeProjectFile(root, "src/index.html", "<dominion-icon></dominion-icon>");
    writeProjectFile(root, "shared/icon.html", `<style>${css}</style><span>Icon</span>`);

    const result = runBuild(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /shared\/icon\.html: unsupported nonlocal fragment CSS at-rule/);
    assert.match(result.stderr, /include chain: src\/index\.html -> shared\/icon\.html/);
    assert.equal(existsSync(path.join(root, "dist")), false);
  }
});

test("build expands shared fragment includes into published HTML", (t) => {
  const root = createProject(t);
  writeProjectFile(root, "src/index.html", "<main><dominion-notice></dominion-notice></main>\n");
  writeProjectFile(root, "shared/notice.html", "<aside>Heads up</aside>\n");

  const result = runBuild(root);

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const output = readFileSync(path.join(root, "dist/index.html"), "utf8");
  assert.match(output, /<aside>Heads up<\/aside>/);
  assert.doesNotMatch(output, /dominion-notice/);
});

test("build expands nested and repeated shared fragment instances", (t) => {
  const root = createProject(t);
  writeProjectFile(root, "src/index.html", "<dominion-card></dominion-card><dominion-card></dominion-card>\n");
  writeProjectFile(root, "shared/card.html", "<article><dominion-badge></dominion-badge></article>");
  writeProjectFile(root, "shared/badge.html", "<b>New</b>");

  const result = runBuild(root);

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const output = readFileSync(path.join(root, "dist/index.html"), "utf8");
  assert.equal((output.match(/<article><b>New<\/b><\/article>/g) ?? []).length, 2);
  assert.doesNotMatch(output, /<dominion-/);
});

test("nested fragment slots belong to their own fragment definition", (t) => {
  const root = createProject(t);
  writeProjectFile(root, "src/index.html", "<dominion-shell></dominion-shell>");
  writeProjectFile(root, "shared/shell.html", `<main><dominion-inner><p slot="body">Inner content</p></dominion-inner></main>`);
  writeProjectFile(root, "shared/inner.html", `<section><slot name="body" #required></slot></section>`);

  const result = runBuild(root);

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const output = readFileSync(path.join(root, "dist/index.html"), "utf8");
  assert.match(output, /<main><section><p>Inner content<\/p><\/section><\/main>/);
  assert.doesNotMatch(output, /<slot|slot="|#required/);
});

test("build distributes named and default slot content in source order", (t) => {
  const root = createProject(t);
  writeProjectFile(root, "src/index.html", `<dominion-callout>
  <h2 slot="heading">Heading</h2>
  <p>First</p>
  <p slot="body">Targeted</p>
  <p>Last</p>
</dominion-callout>
`);
  writeProjectFile(root, "shared/callout.html", `<aside><header><slot name="heading" #required></slot></header>
  <main><slot name="body" #default #required></slot></main></aside>
`);

  const result = runBuild(root);

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const output = readFileSync(path.join(root, "dist/index.html"), "utf8");
  assert.match(output, /<header><h2>Heading<\/h2><\/header>/);
  assert.ok(output.indexOf("First") < output.indexOf("Targeted"));
  assert.ok(output.indexOf("Targeted") < output.indexOf("Last"));
  assert.doesNotMatch(output, /slot="(?:heading|body)"|#(?:default|required)|<slot/);
});

test("build preserves fragment placement in document head and table content", (t) => {
  const root = createProject(t);
  writeProjectFile(root, "src/index.html", `<!doctype html><html><head><title>Home</title><dominion-head-meta></dominion-head-meta></head>
<body><table><tbody><dominion-row></dominion-row></tbody></table></body></html>`);
  writeProjectFile(root, "shared/head-meta.html", `<meta name="description" content="A page">`);
  writeProjectFile(root, "shared/row.html", `<tr><td>Row content</td></tr>`);

  const result = runBuild(root);

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const output = readFileSync(path.join(root, "dist/index.html"), "utf8");
  assert.match(output, /<head><title>Home<\/title><meta name="description" content="A page"><style>[\s\S]*?<\/style><\/head>/);
  assert.match(output, /<table><tbody><tr><td>Row content<\/td><\/tr><\/tbody><\/table>/);
  assert.doesNotMatch(output, /dominion-(?:head-meta|row)/);
});

test("build distributes supplied table rows without relocating them", (t) => {
  const root = createProject(t);
  writeProjectFile(root, "src/index.html", `<dominion-table>
  <tr><td>Supplied row</td></tr>
</dominion-table>`);
  writeProjectFile(root, "shared/table.html", `<table><tbody><slot name="rows" #default #required></slot></tbody></table>`);

  const result = runBuild(root);

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const output = readFileSync(path.join(root, "dist/index.html"), "utf8");
  assert.match(output, /<table><tbody>\s*<tr><td>Supplied row<\/td><\/tr>\s*<\/tbody><\/table>/);
  assert.doesNotMatch(output, /<slot|dominion-table/);
});

test("build passes fragment instance ownership to script and CSS stages", async (t) => {
  const root = createProject(t);
  writeProjectFile(root, "src/index.html", "<dominion-shell><div><dominion-inner></dominion-inner></div></dominion-shell>");
  writeProjectFile(root, "shared/shell.html", "<main><slot name=\"body\" #default></slot></main>");
  writeProjectFile(root, "shared/inner.html", "<i>Inner</i>");
  let scriptContext;
  let cssContext;

  await buildProject({
    rootDir: root,
    pipeline: {
      emitScripts: async (html, context) => {
        scriptContext = context;
        return html;
      },
      generatePageCss: async (html, context) => {
        cssContext = context;
        return html;
      },
    },
  });

  assert.equal(scriptContext, cssContext);
  assert.ok(Array.isArray(cssContext.fragmentInstances));
  assert.equal(cssContext.fragmentInstances.length, 2);
  const [shell, inner] = cssContext.fragmentInstances;
  assert.equal(shell.name, "shell");
  assert.equal(inner.name, "inner");
  assert.equal(inner.parentInstanceId, shell.id);
  const output = readFileSync(path.join(root, "dist/index.html"), "utf8");
  const shellScope = shell.scopeRanges.map((range) => output.slice(range.start, range.end)).join("");
  assert.match(shellScope, /<main><div>/);
  assert.match(shellScope, /<\/div><\/main>/);
  assert.doesNotMatch(shellScope, /<i>Inner<\/i>/);
});

test("build validates authored roots for static and behavior fragments", (t) => {
  const staticRoot = createProject(t);
  writeProjectFile(staticRoot, "src/index.html", "<dominion-widget></dominion-widget>");
  writeProjectFile(staticRoot, "shared/widget.html", "<div>First</div><div>Second</div>");

  const staticResult = runBuild(staticRoot);

  assert.equal(staticResult.status, 0, staticResult.stderr || staticResult.error?.message);
  assert.match(readFileSync(path.join(staticRoot, "dist/index.html"), "utf8"), /<div>First<\/div><div>Second<\/div>/);

  const root = createProject(t);
  writeProjectFile(root, "src/index.html", "<dominion-widget></dominion-widget>\n");
  writeProjectFile(root, "shared/widget.html", `<div>First</div><div>Second</div>
<script>run()</script>`);

  const result = runBuild(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /shared\/widget\.html.*exactly one authored root/);
  assert.match(result.stderr, /src\/index\.html.*shared\/widget\.html/);

  const styleRoot = createProject(t);
  writeProjectFile(styleRoot, "src/index.html", "<dominion-widget></dominion-widget>");
  writeProjectFile(styleRoot, "shared/widget.html", "<div>First</div><div>Second</div><style>.widget { color: red }</style>");

  const styleResult = runBuild(styleRoot);

  assert.notEqual(styleResult.status, 0);
  assert.match(styleResult.stderr, /shared\/widget\.html.*exactly one authored root/);
});

test("required slots validate structure rather than visible content", (t) => {
  const emptyRoot = createProject(t);
  writeProjectFile(emptyRoot, "src/index.html", `<dominion-panel>
  <!-- comments and formatting whitespace do not fill a required slot -->
</dominion-panel>`);
  writeProjectFile(emptyRoot, "shared/panel.html", `<section><slot name="body" #required></slot></section>`);

  const emptyResult = runBuild(emptyRoot);

  assert.notEqual(emptyResult.status, 0);
  assert.match(emptyResult.stderr, /shared\/panel\.html:1:.*required slot is missing content: body/);
  assert.match(emptyResult.stderr, /include chain: src\/index\.html -> shared\/panel\.html/);

  const suppliedRoot = createProject(t);
  writeProjectFile(suppliedRoot, "src/index.html", `<dominion-panel><template slot="template"></template><div slot="hidden" hidden></div><span slot="empty"></span></dominion-panel>`);
  writeProjectFile(suppliedRoot, "shared/panel.html", `<section><slot name="template" #required></slot><slot name="hidden" #required></slot><slot name="empty" #required></slot><slot name="optional"></slot></section>`);

  const suppliedResult = runBuild(suppliedRoot);

  assert.equal(suppliedResult.status, 0, suppliedResult.stderr || suppliedResult.error?.message);
  const output = readFileSync(path.join(suppliedRoot, "dist/index.html"), "utf8");
  assert.match(output, /<template><\/template><div hidden><\/div><span><\/span>/);
  assert.doesNotMatch(output, /<slot|slot="|#required/);
});

test("build reports source-aware fragment and slot contract errors", (t) => {
  const cases = [
    {
      name: "missing fragment",
      page: "<dominion-missing></dominion-missing>",
      files: {},
      error: /src\/index\.html:1:.*shared\/missing\.html/,
    },
    {
      name: "invalid fragment name",
      page: "<dominion-bad_name></dominion-bad_name>",
      files: {},
      error: /invalid shared fragment name.*src\/index\.html/,
    },
    {
      name: "placeholder attributes",
      page: "<dominion-card class=\"wide\"></dominion-card>",
      files: { "shared/card.html": "<article>Card</article>" },
      error: /inclusion placeholders cannot have attributes/,
    },
    {
      name: "missing explicit close",
      page: "<dominion-card>",
      files: { "shared/card.html": "<article>Card</article>" },
      error: /must have an explicit closing tag/,
    },
    {
      name: "cycle",
      page: "<dominion-a></dominion-a>",
      files: {
        "shared/a.html": "<dominion-b></dominion-b>",
        "shared/b.html": "<dominion-a></dominion-a>",
      },
      error: /circular shared fragment inclusion.*shared\/a\.html.*shared\/b\.html/,
    },
    {
      name: "slot diagnostic uses its original definition line",
      page: "<dominion-card></dominion-card>",
      files: {
        "shared/card.html": "<dominion-inner></dominion-inner>\n<slot name=\"body\" #required></slot>",
        "shared/inner.html": "<div>\n<p>First line</p>\n<p>Second line</p>\n</div>",
      },
      error: /shared\/card\.html:2:.*required slot is missing content: body/,
    },
    {
      name: "unknown destination",
      page: "<dominion-card><p slot=\"missing\">Text</p></dominion-card>",
      files: { "shared/card.html": "<article><slot name=\"body\"></slot></article>" },
      error: /unknown slot destination: missing/,
    },
    {
      name: "meaningful content without default",
      page: "<dominion-card><p>Text</p></dominion-card>",
      files: { "shared/card.html": "<article><slot name=\"body\"></slot></article>" },
      error: /meaningful supplied content has no matching slot or #default/,
    },
    {
      name: "duplicate names",
      page: "<dominion-card></dominion-card>",
      files: { "shared/card.html": "<article><slot name=\"body\"></slot><slot name=\"body\"></slot></article>" },
      error: /duplicate slot name: body/,
    },
    {
      name: "multiple defaults",
      page: "<dominion-card></dominion-card>",
      files: { "shared/card.html": "<article><slot name=\"one\" #default></slot><slot name=\"two\" #default></slot></article>" },
      error: /only one slot may be marked #default/,
    },
    {
      name: "fallback content",
      page: "<dominion-card></dominion-card>",
      files: { "shared/card.html": "<article><slot name=\"body\">Fallback</slot></article>" },
      error: /slot fallback content is not supported/,
    },
  ];

  for (const testCase of cases) {
    const root = createProject(t);
    writeProjectFile(root, "src/index.html", testCase.page);
    for (const [filePath, contents] of Object.entries(testCase.files)) {
      writeProjectFile(root, filePath, contents);
    }

    const result = runBuild(root);

    assert.notEqual(result.status, 0, testCase.name);
    assert.match(result.stderr, testCase.error, testCase.name);
  }
});

test("build applies the configured deployment prefix only to site-root URLs", (t) => {
  const root = createProject(t);
  writeProjectFile(root, "dominion.config.json", JSON.stringify({ basePath: "/preview/project/" }));
  writeProjectFile(root, "src/guides/setup/index.html", `<!doctype html>
<a href="/docs?lang=en#setup" class="text-red-600">Docs</a>
<img src="/images/logo.svg?size=2#logo">
<img srcset="/images/small.jpg 1x, /images/large.jpg 2x">
<img srcset="data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA== 1x, /images/retina.jpg 2x">
<a href="../../assets/page.html?view=full#details">Relative</a>
<a href="//cdn.example.com/page">Protocol relative</a>
<a href="https://example.com/page">External</a>
<a href="#section">Fragment</a>
`);

  const result = runBuild(root);

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const output = readFileSync(path.join(root, "dist/guides/setup/index.html"), "utf8");
  assert.equal(output.split("<style").length - 1, 1);
  assert.ok(output.includes(".text-red-600{color:var(--color-red-600)}"));
  assert.match(output, /href="\/preview\/project\/docs\?lang=en#setup"/);
  assert.match(output, /src="\/preview\/project\/images\/logo\.svg\?size=2#logo"/);
  assert.match(output, /srcset="\/preview\/project\/images\/small\.jpg 1x, \/preview\/project\/images\/large\.jpg 2x"/);
  assert.match(output, /srcset="data:image\/gif;base64,R0lGODlhAQABAIAAAAUEBA== 1x, \/preview\/project\/images\/retina\.jpg 2x"/);
  assert.match(output, /href="\.\.\/\.\.\/assets\/page\.html\?view=full#details"/);
  assert.match(output, /href="\/\/cdn\.example\.com\/page"/);
  assert.match(output, /href="https:\/\/example\.com\/page"/);
  assert.match(output, /href="#section"/);
});

test("build reports collisions deterministically without replacing existing output or sources", (t) => {
  const root = createProject(t);
  const page = "<!doctype html><title>Source</title>\n";
  const asset = "asset bytes\n";
  writeProjectFile(root, "src/index.html", page);
  writeProjectFile(root, "public/index.html", asset);
  writeProjectFile(root, "dist/previous.txt", "previous output\n");

  const firstResult = runBuild(root);
  const secondResult = runBuild(root);

  assert.notEqual(firstResult.status, 0);
  assert.match(firstResult.stderr, /Output collision at index\.html/);
  assert.equal(firstResult.stderr, secondResult.stderr);
  assert.equal(readFileSync(path.join(root, "dist/previous.txt"), "utf8"), "previous output\n");
  assert.equal(readFileSync(path.join(root, "src/index.html"), "utf8"), page);
  assert.equal(readFileSync(path.join(root, "public/index.html"), "utf8"), asset);
});

test("build detects a file colliding with another output's directory", (t) => {
  const root = createProject(t);
  writeProjectFile(root, "src/assets.html", "<h1>Page</h1>\n");
  writeProjectFile(root, "public/assets.html/logo.svg", "<svg></svg>\n");

  const result = runBuild(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Output collision/);
  assert.match(result.stderr, /src\/assets\.html/);
  assert.match(result.stderr, /public\/assets\.html\/logo\.svg/);
});

test("rebuild removes stale pages while preserving current source files", (t) => {
  const root = createProject(t);
  const oldPage = "<h1>Old</h1>\n";
  const currentPage = "<h1>Current</h1>\n";
  writeProjectFile(root, "src/old.html", oldPage);
  assert.equal(runBuild(root).status, 0);

  rmSync(path.join(root, "src/old.html"));
  writeProjectFile(root, "src/current.html", currentPage);
  const result = runBuild(root);

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(existsSync(path.join(root, "dist/old.html")), false);
  assert.ok(stripGeneratedStyles(readFileSync(path.join(root, "dist/current.html"), "utf8")).endsWith(currentPage));
  assert.equal(readFileSync(path.join(root, "src/current.html"), "utf8"), currentPage);
});