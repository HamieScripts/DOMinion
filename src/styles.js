import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { parse } from "parse5";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import { walkTree } from "./tree.js";

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const cliPath = path.join(path.dirname(require.resolve("@tailwindcss/cli/package.json")), "dist", "index.mjs");
const tailwindStylesPath = require.resolve("tailwindcss/index.css");

function findElements(node, tagName) {
  const elements = [];
  walkTree(node, (candidate) => {
    if (candidate.tagName === tagName) {
      elements.push(candidate);
    }
  });
  return elements;
}

function owningInstance(style, instances) {
  return instances
    .filter((instance) => instance.scopeRanges.some((range) => (
      range.start <= style.start && range.end >= style.end
    )))
    .sort((left, right) => (left.endOffset - left.startOffset) - (right.endOffset - right.startOffset))[0];
}

function descendantInstances(instance, instances) {
  const descendants = [];
  const pending = [instance.id];
  while (pending.length > 0) {
    const parentId = pending.pop();
    for (const child of instances.filter((candidate) => candidate.parentInstanceId === parentId)) {
      descendants.push(child);
      pending.push(child.id);
    }
  }
  return descendants;
}

function includeScopeRootSelectors(stylesheet) {
  stylesheet.walkRules((rule) => {
    rule.selector = selectorParser((selectors) => {
      const rootSelectors = [];
      selectors.each((selector) => {
        const rootMatch = selector.clone();
        const pseudoElements = rootMatch.nodes.filter((node) => (
          node.type === "pseudo" && (node.value.startsWith("::") || /^:(before|after|first-line|first-letter)$/i.test(node.value))
        ));
        for (const pseudoElement of pseudoElements) {
          rootMatch.removeChild(pseudoElement);
        }

        const scopeArgument = selectorParser.selector();
        scopeArgument.append(selectorParser.pseudo({ value: ":scope" }));
        const scope = selectorParser.pseudo({ value: ":where" });
        scope.append(scopeArgument);

        const match = selectorParser.pseudo({ value: ":is" });
        match.append(rootMatch);

        const rootSelector = selectorParser.selector();
        rootSelector.append(scope);
        rootSelector.append(match);
        for (const pseudoElement of pseudoElements) {
          rootSelector.append(pseudoElement.clone());
        }
        rootSelectors.push(rootSelector);
      });
      for (const rootSelector of rootSelectors) {
        selectors.append(rootSelector);
      }
    }).processSync(rule.selector);
  });
}

function validateFragmentCss(css, instance) {
  let stylesheet;
  try {
    stylesheet = postcss.parse(css, { from: instance.sourcePath });
  } catch (error) {
    throw new Error(`${instance.sourcePath}: invalid fragment CSS: ${error.message}; include chain: ${instance.includeChain.join(" -> ")}`);
  }

  const localAtRules = new Set(["media", "supports", "container", "starting-style"]);
  stylesheet.walkAtRules((rule) => {
    if (!localAtRules.has(rule.name.toLowerCase())) {
      throw new Error(`${instance.sourcePath}: unsupported nonlocal fragment CSS at-rule @${rule.name}; include chain: ${instance.includeChain.join(" -> ")}`);
    }
  });
  includeScopeRootSelectors(stylesheet);
  return stylesheet.toString();
}

function prepareFragmentStyles(html, instances) {
  const tree = parse(html, { sourceCodeLocationInfo: true });
  const styles = findElements(tree, "style").map((node) => {
    const location = node.sourceCodeLocation;
    if (!location?.startTag || !location.endTag) {
      throw new Error("Style elements must have explicit closing tags");
    }
    const start = location.startOffset;
    const end = location.endOffset;
    const css = html.slice(location.startTag.endOffset, location.endTag.startOffset);
    return { start, end, css, owner: owningInstance({ start, end }, instances) };
  });
  const styledInstances = [...new Set(styles.map((style) => style.owner).filter(Boolean))];
  const relevantInstances = new Map();
  for (const instance of styledInstances) {
    relevantInstances.set(instance.id, instance);
    for (const descendant of descendantInstances(instance, instances)) {
      relevantInstances.set(descendant.id, descendant);
    }
  }

  const existingAttributeNames = new Set();
  walkTree(tree, (node) => {
    for (const attribute of node.attrs ?? []) {
      existingAttributeNames.add(attribute.name.toLowerCase());
    }
  });

  let scopeAttribute = "data-dominion-scope";
  let suffix = 1;
  while (existingAttributeNames.has(scopeAttribute)) {
    scopeAttribute = `data-dominion-scope-${suffix++}`;
  }

  const replacements = styles.map((style) => ({ start: style.start, end: style.end, value: "" }));
  const rootsByRange = new Map();
  walkTree(tree, (node) => {
    const location = node.sourceCodeLocation;
    if (node.tagName && location) {
      rootsByRange.set(`${location.startOffset}:${location.endOffset}`, node);
    }
  });

  const selectorsByInstance = new Map();
  for (const instance of relevantInstances.values()) {
    const selector = `[${scopeAttribute}="${instance.id}"]`;
    selectorsByInstance.set(instance.id, selector);
    for (const range of instance.rootRanges) {
      const root = rootsByRange.get(`${range.startOffset}:${range.endOffset}`);
      const startTag = root?.sourceCodeLocation?.startTag;
      if (!startTag) {
        throw new Error(`${instance.sourcePath}: cannot identify authored fragment root for CSS scope`);
      }
      const tagText = html.slice(startTag.startOffset, startTag.endOffset);
      const insertionOffset = tagText.endsWith("/>") ? startTag.endOffset - 2 : startTag.endOffset - 1;
      replacements.push({
        start: insertionOffset,
        end: insertionOffset,
        value: ` ${scopeAttribute}="${instance.id}"`,
      });
    }
  }

  let rewrittenHtml = html;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    rewrittenHtml = `${rewrittenHtml.slice(0, replacement.start)}${replacement.value}${rewrittenHtml.slice(replacement.end)}`;
  }

  const fragmentRules = [];
  const globalRules = [];
  for (const style of styles) {
    if (!style.owner) {
      globalRules.push(style.css);
      continue;
    }
    const css = validateFragmentCss(style.css, style.owner);
    const limits = descendantInstances(style.owner, instances)
      .filter((instance) => selectorsByInstance.has(instance.id))
      .map((instance) => selectorsByInstance.get(instance.id));
    const limitClause = limits.length ? ` to (${limits.join(",")})` : "";
    fragmentRules.push(`@scope (${selectorsByInstance.get(style.owner.id)})${limitClause}{${css}}`);
  }

  return {
    html: rewrittenHtml,
    fragmentCss: fragmentRules.length ? `@layer components{${fragmentRules.join("")}}` : "",
    globalCss: globalRules.join("\n"),
  };
}

function insertInHead(html, css) {
  const tree = parse(html, { sourceCodeLocationInfo: true });
  const style = `<style>${css}</style>`;
  const head = tree.childNodes.find((node) => node.tagName === "html")?.childNodes.find((node) => node.tagName === "head");
  const headLocation = head?.sourceCodeLocation;
  if (headLocation?.endTag) {
    return `${html.slice(0, headLocation.endTag.startOffset)}${style}${html.slice(headLocation.endTag.startOffset)}`;
  }
  if (headLocation?.startTag) {
    return `${html.slice(0, headLocation.startTag.endOffset)}${style}${html.slice(headLocation.startTag.endOffset)}`;
  }

  const htmlElement = findElements(tree, "html")[0];
  const htmlStart = htmlElement?.sourceCodeLocation?.startTag?.endOffset;
  if (htmlStart !== undefined) {
    return `${html.slice(0, htmlStart)}<head>${style}</head>${html.slice(htmlStart)}`;
  }

  const doctype = tree.childNodes.find((node) => node.nodeName === "#documentType");
  const offset = doctype?.sourceCodeLocation?.endOffset ?? 0;
  return `${html.slice(0, offset)}<head>${style}</head>${html.slice(offset)}`;
}

export async function generatePageCss(html, rootDir, instances = []) {
  const temporaryDirectory = await mkdtemp(path.join(rootDir, ".dominion-tailwind-"));
  const pagePath = path.join(temporaryDirectory, "page.html");
  const inputPath = path.join(temporaryDirectory, "input.css");
  const outputPath = path.join(temporaryDirectory, "output.css");
  const themePath = path.join(rootDir, "tailwind.css");

  try {
    const prepared = prepareFragmentStyles(html, instances);
    await writeFile(pagePath, prepared.html);
    let themeImport = "";
    try {
      const themeInfo = await lstat(themePath);
      if (!themeInfo.isFile()) {
        throw new Error("Project Tailwind theme must be a file: tailwind.css");
      }
      await writeFile(path.join(temporaryDirectory, "theme.css"), await readFile(themePath));
      themeImport = '@import "./theme.css";\n';
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    const tailwindImport = path.relative(temporaryDirectory, tailwindStylesPath).split(path.sep).join("/");
    await writeFile(inputPath, `@import "${tailwindImport}" source(none);\n@source "./page.html";\n${themeImport}${prepared.fragmentCss}\n${prepared.globalCss}`);
    await execFile(process.execPath, [cliPath, "-i", inputPath, "-o", outputPath, "--minify"], {
      cwd: rootDir,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    const css = (await readFile(outputPath, "utf8")).trim();
    return insertInHead(prepared.html, css);
  } catch (error) {
    const detail = error.stderr?.trim();
    throw new Error(`Tailwind CSS generation failed${detail ? `: ${detail}` : `: ${error.message}`}`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}