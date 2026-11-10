import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { buildProject } from "../src/build.js";

const browserPath = process.env.DOMINION_CHROME
  ?? chromium.executablePath();

function createProject(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "dominion-scripts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeProjectFile(root, relativePath, contents) {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

async function buildAndReadBrowserDom(root) {
  await buildProject({ rootDir: root });
  const outputPath = path.join(root, "dist/index.html");
  const result = spawnSync(browserPath, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--allow-file-access-from-files",
    "--dump-dom",
    pathToFileURL(outputPath).href,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}

test("each repeated fragment script receives its own root", { skip: !browserPath }, async (t) => {
  const root = createProject(t);
  writeProjectFile(root, "src/index.html", `<!doctype html>
<dominion-card></dominion-card>
<dominion-card></dominion-card>
`);
  writeProjectFile(root, "shared/card.html", `<article><p>waiting</p><dominion-badge></dominion-badge><script>
root.dataset.owner = "card";
root.querySelector("p").textContent = "card ready";
</script></article>`);
  writeProjectFile(root, "shared/badge.html", `<span>badge waiting<script>
root.dataset.owner = "badge";
root.textContent = "badge ready";
</script></span>`);

  const dom = await buildAndReadBrowserDom(root);

  assert.equal((dom.match(/<p>card ready<\/p>/g) ?? []).length, 2);
  assert.equal((dom.match(/<span data-dominion-root="fragment-\d+" data-owner="badge">badge ready<\/span>/g) ?? []).length, 2);
  assert.equal((dom.match(/<article data-dominion-root="fragment-\d+" data-owner="card">/g) ?? []).length, 2);
  assert.doesNotMatch(dom, /<script[^>]*>\s*root\.querySelector/);
});

test("a sibling script binds to the fragment's authored DOM root", { skip: !browserPath }, async (t) => {
  const root = createProject(t);
  writeProjectFile(root, "src/index.html", "<dominion-widget></dominion-widget>");
  writeProjectFile(root, "shared/widget.html", `<script>root.querySelector("p").textContent = "ready";</script>
<section><p>waiting</p></section>`);

  const dom = await buildAndReadBrowserDom(root);

  assert.match(dom, /<section data-dominion-root="fragment-\d+"><p>ready<\/p><\/section>/);
});

test("fragment timing directives preserve parse timing and deferred source order", { skip: !browserPath }, async (t) => {
  const root = createProject(t);
  writeProjectFile(root, "src/index.html", `<!doctype html>
<script>
window.requestIdleCallback = callback => {
  document.documentElement.dataset.nativeIdleRequested = "true";
  callback({ didTimeout: false, timeRemaining: () => 50 });
};
</script>
<dominion-timing></dominion-timing>
`);
  writeProjectFile(root, "shared/timing.html", `<section>
<p id="before">before</p>
<script #immediate>
root.dataset.immediateReadyState = document.readyState;
root.dataset.immediateSawLater = String(Boolean(root.querySelector("#later")));
</script>
<p id="later">later</p>
<script #defer>const blockValue = "first"; function instanceOnlyHelper() {} root.dataset.order = blockValue; root.dataset.helperGlobal = typeof window.instanceOnlyHelper;</script>
<script>root.dataset.order += ",second"; root.dataset.blockVisibility = typeof blockValue; root.dataset.functionVisibility = typeof instanceOnlyHelper; root.dataset.defaultReadyState = document.readyState;</script>
<script #idle>
root.dataset.idleReadyState = document.readyState;
root.dataset.idleSawLater = String(Boolean(root.querySelector("#later")));
</script>
</section>`);

  const dom = await buildAndReadBrowserDom(root);

  assert.match(dom, /data-immediate-ready-state="loading"/);
  assert.match(dom, /data-immediate-saw-later="false"/);
  assert.match(dom, /data-order="first,second"/);
  assert.match(dom, /data-block-visibility="undefined"/);
  assert.match(dom, /data-helper-global="undefined"/);
  assert.match(dom, /data-function-visibility="undefined"/);
  assert.match(dom, /data-default-ready-state="(?:interactive|complete)"/);
  assert.match(dom, /data-native-idle-requested="true"/);
  assert.match(dom, /data-idle-ready-state="(?:interactive|complete)"/);
  assert.match(dom, /data-idle-saw-later="true"/);
  assert.doesNotMatch(dom, /#(?:immediate|defer|idle)/);
});

test("idle scheduling falls back to a timer when requestIdleCallback is unavailable", { skip: !browserPath }, async (t) => {
  const root = createProject(t);
  writeProjectFile(root, "src/index.html", `<!doctype html>
<script>window.requestIdleCallback = undefined;</script>
<dominion-idle></dominion-idle>
`);
  writeProjectFile(root, "shared/idle.html", `<div><p>waiting</p><script #idle>
root.querySelector("p").textContent = "idle fallback ran";
</script></div>`);

  const dom = await buildAndReadBrowserDom(root);

  assert.match(dom, /<p>idle fallback ran<\/p>/);
});

test("inline module scripts keep native module semantics and data blocks stay untouched", { skip: !browserPath }, async (t) => {
  const root = createProject(t);
  writeProjectFile(root, "src/index.html", `<!doctype html>
<dominion-module></dominion-module>
`);
  writeProjectFile(root, "shared/module.html", `<section><p>waiting</p>
<script type="application/json" id="settings">{"mode":"static"}</script>
<script type="module" #defer>
import { importedValue } from "data:text/javascript,export%20const%20importedValue%20%3D%20%22imported%22";
root.querySelector("p").textContent = "module " + importedValue;
root.dataset.moduleThisIsUndefined = String(this === undefined);
root.dataset.moduleUrlExists = String(import.meta.url.length > 0);
</script>
</section>`);

  const dom = await buildAndReadBrowserDom(root);

  assert.match(dom, /<script type="application\/json" id="settings">\{"mode":"static"\}<\/script>/);
  assert.match(dom, /<p>module imported<\/p>/);
  assert.match(dom, /data-module-this-is-undefined="true"/);
  assert.match(dom, /data-module-url-exists="true"/);
  assert.doesNotMatch(dom, /type="module"[^>]*#defer/);
});

test("script timing errors identify the fragment and correction", async (t) => {
  const cases = [
    {
      name: "unknown directive",
      script: `<script #later>root.hidden = true;</script>`,
      message: /unknown script timing directive #later.*#immediate, #defer, or #idle/,
    },
    {
      name: "multiple directives",
      script: `<script #defer #idle>root.hidden = true;</script>`,
      message: /multiple script timing directives.*#defer, #idle/,
    },
    {
      name: "native async classic script",
      script: `<script async>root.hidden = true;</script>`,
      message: /native async\/defer attributes.*use #immediate, #defer, or #idle/,
    },
    {
      name: "native defer classic script",
      script: `<script defer>root.hidden = true;</script>`,
      message: /native async\/defer attributes.*use #immediate, #defer, or #idle/,
    },
    {
      name: "native async contradicts module defer",
      script: `<script type="module" async #defer>root.hidden = true;</script>`,
      message: /#defer conflicts with the native async attribute/,
    },
    {
      name: "module immediate directive",
      script: `<script type="module" #immediate>root.hidden = true;</script>`,
      message: /module scripts cannot use #immediate or #idle/,
    },
    {
      name: "data block timing directive",
      script: `<script type="application/json" #defer>{"enabled":true}</script>`,
      message: /timing directives apply only to executable classic or module scripts/,
    },
    {
      name: "external fragment script",
      script: `<script src="/behavior.js"></script>`,
      message: /external fragment scripts are not supported.*inline classic or module script/,
    },
  ];

  for (const testCase of cases) {
    const root = createProject(t);
    writeProjectFile(root, "src/index.html", "<dominion-widget></dominion-widget>");
    writeProjectFile(root, "shared/widget.html", `<div>${testCase.script}</div>`);

    await assert.rejects(buildProject({ rootDir: root }), (error) => {
      assert.match(error.message, /shared\/widget\.html:1:/, testCase.name);
      assert.match(error.message, /include chain: src\/index\.html -> shared\/widget\.html/, testCase.name);
      assert.match(error.message, testCase.message, testCase.name);
      return true;
    });
  }
});

test("static fragments and data-only pages receive no DOMinion runtime JavaScript", async (t) => {
  const root = createProject(t);
  writeProjectFile(root, "src/index.html", `<dominion-static></dominion-static>
<script type="application/json">{"feature":"native"}</script>
`);
  writeProjectFile(root, "shared/static.html", `<p>Static content</p><p>Second root</p>
<script type="application/json">{"mode":"static"}</script>`);

  await buildProject({ rootDir: root });

  const output = readFileSync(path.join(root, "dist/index.html"), "utf8");
  assert.match(output, /<p>Static content<\/p><p>Second root<\/p>/);
  assert.match(output, /<script type="application\/json">\{"mode":"static"\}<\/script>/);
  assert.match(output, /<script type="application\/json">\{"feature":"native"\}<\/script>/);
  assert.doesNotMatch(output, /data-dominion-root|\(\(\)=>\{/);
});

test("script compilation preserves fragment style ownership", { skip: !browserPath }, async (t) => {
  const root = createProject(t);
  writeProjectFile(root, "src/index.html", "<dominion-widget></dominion-widget>");
  writeProjectFile(root, "shared/widget.html", `<section>
<script>root.dataset.ready = "true";</script>
<style>.widget-label { color: rgb(255, 0, 0) }</style>
<p class="widget-label">Styled</p>
</section>`);

  const dom = await buildAndReadBrowserDom(root);

  assert.match(dom, /<section data-dominion-root="fragment-\d+" data-dominion-scope="fragment-\d+" data-ready="true">/);
  assert.match(dom, /<p class="widget-label">Styled<\/p>/);
});