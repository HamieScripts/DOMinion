import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  assert.equal(readFileSync(path.join(root, "dist/products/item.html"), "utf8"), "<h1>Item</h1>\n<a href=\"/images/logo.svg\">Logo</a>\n");
  assert.equal(readFileSync(path.join(root, "dist/about/index.html"), "utf8"), "<h1>About</h1>\n");
  assert.equal(readFileSync(path.join(root, "dist/images/logo.svg"), "utf8"), "<svg></svg>\n");
  assert.equal(existsSync(path.join(root, "dist/shared/navigation.html")), false);
});

test("build applies the configured deployment prefix only to site-root URLs", (t) => {
  const root = createProject(t);
  writeProjectFile(root, "dominion.config.json", JSON.stringify({ basePath: "/preview/project/" }));
  writeProjectFile(root, "src/guides/setup/index.html", `<!doctype html>
<a href="/docs?lang=en#setup">Docs</a>
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
  assert.equal(readFileSync(path.join(root, "dist/current.html"), "utf8"), currentPage);
  assert.equal(readFileSync(path.join(root, "src/current.html"), "utf8"), currentPage);
});