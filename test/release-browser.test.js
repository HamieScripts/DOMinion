import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { buildProject } from "../src/build.js";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const screenshotRoot = path.join(projectRoot, "test-results", "release-verification");
const pagePaths = [
  "/",
  "/guide/project-structure/",
  "/guide/routing/",
  "/guide/fragments-and-slots/",
  "/guide/styling/",
  "/guide/script-timing/",
  "/guide/deployment/",
  "/examples/",
];

function mimeType(filePath) {
  return ({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  })[path.extname(filePath)] ?? "application/octet-stream";
}

async function serveDirectory(root, basePath) {
  const prefix = basePath === "/" ? "/" : basePath.slice(0, -1);
  const server = createServer((request, response) => {
    let requestPath;
    try {
      requestPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (prefix !== "/" && requestPath !== prefix && !requestPath.startsWith(`${prefix}/`)) {
      response.writeHead(404).end();
      return;
    }
    const relativePath = prefix === "/" ? requestPath : requestPath.slice(prefix.length) || "/";
    const filePath = path.resolve(root, `.${relativePath}`);
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
      response.writeHead(404).end();
      return;
    }
    const resolvedPath = path.extname(filePath) ? filePath : path.join(filePath, "index.html");
    if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": mimeType(resolvedPath) });
    response.end(readFileSync(resolvedPath));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function buildOutputs(outputRoot) {
  for (const basePath of ["/", "/DOMinion/"]) {
    await buildProject({ rootDir: projectRoot, basePath });
    cpSync(path.join(projectRoot, "dist"), path.join(outputRoot, basePath === "/" ? "root" : "project"), { recursive: true });
  }
}

function localPath(basePath, route) {
  return `${basePath === "/" ? "" : basePath.slice(0, -1)}${route}`;
}

test("published documentation works at root and project prefixes in desktop and mobile browsers", async (t) => {
  const outputRoot = mkdtempSync(path.join(os.tmpdir(), "dominion-release-"));
  t.after(() => rmSync(outputRoot, { recursive: true, force: true }));
  await buildOutputs(outputRoot);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(screenshotRoot, { recursive: true }));

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const measurements = [];

  for (const { basePath, outputName } of [
    { basePath: "/", outputName: "root" },
    { basePath: "/DOMinion/", outputName: "project" },
  ]) {
    const server = await serveDirectory(path.join(outputRoot, outputName), basePath);
    t.after(() => server.close());

    for (const viewport of [
      { name: "desktop", width: 1440, height: 1000 },
      { name: "mobile", width: 390, height: 844 },
    ]) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const page = await context.newPage();
      const pageErrors = [];
      const consoleErrors = [];
      const failedRequests = [];
      const badResponses = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") {
          consoleErrors.push(message.text());
        }
      });
      page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`));
      page.on("response", (response) => {
        if (response.status() >= 400) {
          badResponses.push(`${response.status()} ${response.url()}`);
        }
      });

      const homeUrl = `${server.origin}${localPath(basePath, "/")}`;
      const coldStarted = performance.now();
      const homeResponse = await page.goto(homeUrl, { waitUntil: "load" });
      const coldElapsedMs = performance.now() - coldStarted;
      assert.equal(homeResponse.status(), 200);
      assert.match(await page.title(), /DOMinion/);
      assert.equal(await page.locator("main h1").count(), 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${viewport.name} home has no horizontal page overflow`);

      const focusTargets = [];
      await page.keyboard.press("Tab");
      focusTargets.push(await page.evaluate(() => ({
        label: document.activeElement.textContent.trim(),
        href: document.activeElement.getAttribute("href"),
        rect: document.activeElement.getBoundingClientRect().toJSON(),
      })));
      assert.match(focusTargets[0].href, /#top$/, "the first keyboard target is the skip link");
      assert.ok(focusTargets[0].rect.height > 0 && focusTargets[0].rect.top >= 0, "the skip link is visible when focused");
      await page.keyboard.press("Tab");
      focusTargets.push(await page.evaluate(() => ({
        label: document.activeElement.textContent.trim(),
        outlineStyle: getComputedStyle(document.activeElement).outlineStyle,
        outlineWidth: getComputedStyle(document.activeElement).outlineWidth,
      })));
      assert.notEqual(focusTargets[1].outlineStyle, "none", "keyboard focus has a visible outline");
      assert.notEqual(focusTargets[1].outlineWidth, "0px");

      const primaryLinks = page.getByRole("navigation", { name: "Primary" }).getByRole("link");
      assert.equal(await primaryLinks.count(), 8);
      for (const route of pagePaths.slice(1, -1)) {
        const response = await page.goto(`${server.origin}${localPath(basePath, route)}`, { waitUntil: "load" });
        assert.equal(response.status(), 200, route);
        assert.equal(await page.locator("main h1").count(), 1, route);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${viewport.name} ${route} has no horizontal page overflow`);
        const browserPath = new URL(page.url()).pathname;
        assert.ok(browserPath.startsWith(basePath), `${browserPath} remains under ${basePath}`);
        if (route === "/guide/script-timing/") {
          await page.waitForFunction(() => document.querySelector("[data-idle]")?.textContent.includes("Idle became eligible after parsing"), { timeout: 5000 });
          assert.match(await page.locator("[data-immediate]").textContent(), /Immediate ran while parsing \(loading\); later sibling present: false\./);
          assert.match(await page.locator("[data-deferred]").textContent(), /Deferred ran after parsing \((?:interactive|complete)\)\./);
          assert.match(await page.locator("[data-idle]").textContent(), /Idle became eligible after parsing \((?:interactive|complete)\)\./);
        }
        for (const image of await page.locator("img").all()) {
          await image.scrollIntoViewIfNeeded();
          await image.evaluate((element) => element.decode());
        }
      }

      await page.goto(homeUrl, { waitUntil: "load" });
      for (let tab = 0; tab < 5; tab += 1) {
        await page.keyboard.press("Tab");
      }
      assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), "Routing", "keyboard navigation reaches the Routing link");
      await page.keyboard.press("Enter");
      await page.waitForURL(`${server.origin}${localPath(basePath, "/guide/routing/")}`);
      assert.equal(new URL(page.url()).pathname, localPath(basePath, "/guide/routing/"), "navigation links open nested documentation routes");
      assert.ok(await page.locator("pre code").count() > 0, "routing guide contains readable code examples");
      const codeLayout = await page.evaluate(() => ({
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        blocks: [...document.querySelectorAll("pre")].map((block) => ({
          clientWidth: block.clientWidth,
          scrollWidth: block.scrollWidth,
          overflowX: getComputedStyle(block).overflowX,
        })),
      }));
      assert.ok(codeLayout.pageWidth <= codeLayout.viewportWidth, "code examples do not widen the page viewport");
      assert.ok(codeLayout.blocks.every((block) => block.scrollWidth <= block.clientWidth || ["auto", "scroll"].includes(block.overflowX)));

      await page.goto(`${server.origin}${localPath(basePath, "/examples/")}`, { waitUntil: "load" });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${viewport.name} examples have no horizontal page overflow`);
      const cards = page.locator("article.demo-card");
      assert.equal(await cards.count(), 2);
      assert.deepEqual(await cards.evaluateAll((items) => items.map((item) => item.dataset.state)), ["waiting", "waiting"]);
      const firstCardText = await cards.first().innerText();
      for (const slottedText of [
        "01",
        "Separate state, shared source",
        "This paragraph was supplied by the page and lands in the default body slot.",
        "This named assignment joins it in source order.",
      ]) {
        assert.ok(firstCardText.includes(slottedText), `the first card renders its slot content: ${slottedText}`);
      }
      const initialStyles = await cards.first().evaluate((card) => ({
        accentToken: getComputedStyle(card).getPropertyValue("--demo-accent").trim(),
        nestedAccent: getComputedStyle(card.querySelector(".demo-stamp")).color,
        activeStateColor: getComputedStyle(card.querySelector("[data-state-output] p")).color,
      }));
      assert.ok(initialStyles.accentToken, "fragment CSS sets its authored root custom property");
      assert.equal(initialStyles.nestedAccent, "rgb(191, 86, 63)", "custom properties inherit into nested fragment roots");
      assert.equal(initialStyles.activeStateColor, "rgb(88, 125, 141)", "the initially active waiting utility is rendered");
      await cards.first().getByRole("button", { name: "Cycle state" }).focus();
      for (const [state, expectedColor] of [
        ["ready", "rgb(65, 109, 89)"],
        ["empty", "rgb(167, 122, 49)"],
        ["error", "rgb(191, 86, 63)"],
      ]) {
        await page.keyboard.press("Enter");
        await page.waitForFunction((expectedState) => document.querySelector("article.demo-card")?.dataset.state === expectedState, state);
        assert.equal(await cards.first().locator("[data-state-output] p").evaluate((element) => getComputedStyle(element).color), expectedColor, `the ${state} utility is rendered`);
      }
      assert.equal(await cards.nth(1).getAttribute("data-state"), "waiting", "repeated instances keep independent UI state");

      const image = page.locator('img[src*="instance-lab.png"]');
      await image.waitFor({ state: "visible" });
      assert.equal(await image.evaluate((element) => element.complete && element.naturalWidth > 0), true, "the example image loads");
      assert.ok(new URL(await image.getAttribute("src"), page.url()).pathname.startsWith(basePath), "the example asset uses the deployment prefix");
      await page.waitForLoadState("networkidle");

      const repeatedStarted = performance.now();
      const repeatedResponse = await page.goto(homeUrl, { waitUntil: "load" });
      const repeatedElapsedMs = performance.now() - repeatedStarted;
      assert.equal(repeatedResponse.status(), 200);
      const navigation = await page.evaluate(() => {
        const entry = performance.getEntriesByType("navigation").at(-1);
        return { durationMs: entry.duration, transferSizeBytes: entry.transferSize };
      });
      measurements.push({
        basePath,
        viewport,
        cold: { wallClockMs: Number(coldElapsedMs.toFixed(2)) },
        repeated: { wallClockMs: Number(repeatedElapsedMs.toFixed(2)), navigation: { durationMs: Number(navigation.durationMs.toFixed(2)), transferSizeBytes: navigation.transferSizeBytes } },
        conditions: "Fresh browser context for cold navigation; repeated navigation reuses that context; default Chromium cache; localhost HTTP; no throttling; page load event.",
      });

      assert.deepEqual(pageErrors, [], "no browser JavaScript exceptions");
      assert.deepEqual(consoleErrors, [], "no browser console errors");
      assert.deepEqual(failedRequests, [], "no failed network requests");
      assert.deepEqual(badResponses, [], "no HTTP error responses");
      if (viewport.name === "desktop") {
        await page.screenshot({ path: path.join(screenshotRoot, `docs-${outputName}-desktop.png`), fullPage: true });
      } else {
        await page.screenshot({ path: path.join(screenshotRoot, `docs-${outputName}-mobile.png`), fullPage: true });
      }
      await context.close();
    }
  }

  process.stdout.write(`RELEASE_MEASUREMENTS ${JSON.stringify({
    browser: `Chromium ${browser.version()}`,
    viewports: ["1440x1000 desktop", "390x844 mobile"],
    network: "localhost HTTP, unthrottled, browser cache enabled",
    dynamicDataWait: "not applicable: documentation issues no API requests; example state changes are local UI interactions",
    measurements,
    screenshots: path.relative(projectRoot, screenshotRoot).replaceAll(path.sep, "/"),
  })}\n`);
});