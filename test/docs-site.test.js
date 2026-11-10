import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { parse } from "parse5";
import { buildProject } from "../src/build.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pagePaths = [
  "index.html",
  "guide/project-structure/index.html",
  "guide/routing/index.html",
  "guide/fragments-and-slots/index.html",
  "guide/styling/index.html",
  "guide/script-timing/index.html",
  "guide/deployment/index.html",
  "examples/index.html",
];
const browserPath = process.env.DOMINION_CHROME
  ?? chromium.executablePath();
const runtimeFreePages = new Set([
  "index.html",
  "guide/project-structure/index.html",
  "guide/routing/index.html",
  "guide/fragments-and-slots/index.html",
  "guide/styling/index.html",
  "guide/deployment/index.html",
]);

function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes ?? []) {
    walk(child, visit);
  }
  if (node.content) {
    walk(node.content, visit);
  }
}

function listOutputFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(prefix, entry.name);
    return entry.isDirectory()
      ? listOutputFiles(path.join(directory, entry.name), relativePath)
      : [relativePath.replaceAll(path.sep, "/")];
  });
}

function localOutputPath(target, basePath) {
  const prefix = basePath === "/" ? "" : basePath.replace(/\/$/, "");
  assert.ok(target.pathname === prefix || target.pathname.startsWith(`${prefix}/`), `${target.pathname} stays under ${basePath}`);
  const outputUrlPath = target.pathname.slice(prefix.length) || "/";
  const targetRelativePath = outputUrlPath === "/"
    ? "index.html"
    : outputUrlPath.endsWith("/")
      ? `${outputUrlPath.slice(1)}index.html`
      : outputUrlPath.slice(1);
  return path.join(projectRoot, "dist", targetRelativePath);
}

function inspectPage(outputPath, basePath) {
  const html = readFileSync(outputPath, "utf8");
  const tree = parse(html);
  const elements = [];
  walk(tree, (node) => {
    if (node.tagName) {
      elements.push(node);
    }
  });
  const title = elements.find((element) => element.tagName === "title")?.childNodes
    .map((node) => node.value ?? "")
    .join("")
    .trim();
  const ids = new Set(elements.flatMap((element) => (
    element.attrs?.filter((attribute) => attribute.name === "id").map((attribute) => attribute.value) ?? []
  )));
  const idCount = elements.reduce((count, element) => count + (element.attrs?.filter((attribute) => attribute.name === "id").length ?? 0), 0);
  const relativeRoute = path.relative(path.join(projectRoot, "dist"), outputPath)
    .replaceAll(path.sep, "/")
    .replace(/index\.html$/, "");
  const pageUrl = `https://docs.example${basePath}${relativeRoute}`;

  assert.ok(title, `${outputPath} has a descriptive title`);
  assert.ok(elements.some((element) => element.tagName === "main"), `${outputPath} has a main landmark`);
  assert.ok(elements.some((element) => element.tagName === "h1"), `${outputPath} has a primary heading`);
  const headings = elements.filter((element) => /^h[1-6]$/.test(element.tagName));
  assert.ok(headings.every((heading) => heading.attrs?.some((attribute) => attribute.name === "id")), `${outputPath} gives each heading an anchor`);
  assert.equal(ids.size, idCount, `${outputPath} uses unique ids`);
  assert.ok(elements.some((element) => element.tagName === "nav" && element.attrs?.some((attribute) => (
    attribute.name === "aria-label" && attribute.value.trim()
  ))), `${outputPath} has a labeled navigation landmark`);
  assert.ok(!elements.some((element) => element.tagName.startsWith("dominion-")), `${outputPath} has no unexpanded fragments`);
  assert.ok(!elements.some((element) => element.tagName === "slot"), `${outputPath} has no unexpanded content slots`);
  assert.ok(!elements.some((element) => element.attrs?.some((attribute) => attribute.name.startsWith("#"))), `${outputPath} has no build directives`);
  assert.doesNotMatch(html, /\{\{\s*[^{}]+\s*\}\}/, `${outputPath} has no unresolved template placeholders`);
  if (runtimeFreePages.has(path.relative(path.join(projectRoot, "dist"), outputPath).replaceAll(path.sep, "/"))) {
    assert.equal(elements.filter((element) => element.tagName === "script").length, 0, `${outputPath} needs no browser JavaScript`);
  }

  for (const anchor of elements.filter((element) => element.tagName === "a")) {
    const href = anchor.attrs?.find((attribute) => attribute.name === "href")?.value;
    if (!href) {
      continue;
    }
    const target = new URL(href, pageUrl);
    if (target.origin !== "https://docs.example") {
      continue;
    }
    const targetPath = localOutputPath(target, basePath);
    assert.ok(existsSync(targetPath), `${href} resolves to ${path.relative(path.join(projectRoot, "dist"), targetPath)}`);
    if (target.hash && targetPath.endsWith(".html")) {
      const targetTree = parse(readFileSync(targetPath, "utf8"));
      const targetIds = new Set();
      walk(targetTree, (node) => {
        for (const attribute of node.attrs ?? []) {
          if (attribute.name === "id") {
            targetIds.add(attribute.value);
          }
        }
      });
      assert.ok(targetIds.has(decodeURIComponent(target.hash.slice(1))), `${href} resolves to a heading anchor`);
    }
  }

  for (const image of elements.filter((element) => element.tagName === "img")) {
    const src = image.attrs?.find((attribute) => attribute.name === "src")?.value;
    if (src) {
      const target = new URL(src, pageUrl);
      if (target.origin === "https://docs.example") {
        assert.ok(existsSync(localOutputPath(target, basePath)), `${src} resolves to a copied asset`);
      }
    }
  }

  const images = elements.filter((element) => element.tagName === "img").map((image) => ({
    src: image.attrs?.find((attribute) => attribute.name === "src")?.value,
    alt: image.attrs?.find((attribute) => attribute.name === "alt")?.value,
  }));

  return { title, ids, html, images };
}

test("documentation builds as accessible, linked pages at root and the GitHub Pages prefix", async () => {
  for (const basePath of ["/", "/DOMinion/"]) {
    const result = await buildProject({ rootDir: projectRoot, basePath });
    assert.equal(result.pageCount, pagePaths.length);
    assert.equal(result.assetCount, 1);
    assert.deepEqual(
      listOutputFiles(path.join(projectRoot, "dist")).sort(),
      [...pagePaths, "images/instance-lab.png"].sort(),
      "the deployable output contains only documentation pages and the public image asset",
    );

    const pages = pagePaths.map((pagePath) => inspectPage(path.join(projectRoot, "dist", pagePath), basePath));
    assert.equal(new Set(pages.map((page) => page.title)).size, pagePaths.length, "page titles are unique");
    assert.ok(pages.every((page) => page.ids.size > 0), "pages expose heading anchors");
    assert.match(pages.at(-1).html, /<template[\s>]/, "examples include statically authored runtime states");
    const imagePrefix = basePath === "/" ? "" : basePath.slice(0, -1);
    assert.ok(pages.at(-1).images.some((image) => (
      image.src === `${imagePrefix}/images/instance-lab.png` && image.alt?.includes("fragment instances")
    )), "examples show the instance lab with useful alternative text at each deployment prefix");
  }
});

test("compiled examples initialize repeated instances and run every timing policy in a browser", { skip: !browserPath }, async () => {
  await buildProject({ rootDir: projectRoot, basePath: "/" });
  const readBrowserDom = (relativePath) => {
    const result = spawnSync(browserPath, [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--allow-file-access-from-files",
      "--timeout=5000",
      "--virtual-time-budget=5000",
      "--dump-dom",
      pathToFileURL(path.join(projectRoot, "dist", relativePath)).href,
    ], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout;
  };

  const exampleDom = readBrowserDom("examples/index.html");
  const exampleTree = parse(exampleDom);
  const exampleElements = [];
  const exampleText = [];
  walk(exampleTree, (node) => {
    if (node.tagName) {
      exampleElements.push(node);
    }
    if (node.nodeName === "#text") {
      exampleText.push(node.value);
    }
  });
  const cards = exampleElements.filter((element) => element.tagName === "article" && element.attrs?.some((attribute) => (
    attribute.name === "class" && attribute.value.includes("demo-card")
  )));
  assert.equal(cards.length, 2);
  assert.ok(cards.every((card) => card.attrs.some((attribute) => attribute.name === "data-state" && attribute.value === "waiting")));
  assert.ok(!exampleText.some((text) => text.includes("border-inline-start: 2px")), "fragment CSS is not visible document text");

});