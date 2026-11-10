import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import parseSrcset from "parse-srcset";
import { parse, serialize } from "parse5";
import { expandSharedFragments } from "./fragments.js";

const URL_ATTRIBUTES = new Set([
  "action",
  "archive",
  "background",
  "cite",
  "codebase",
  "data",
  "formaction",
  "href",
  "longdesc",
  "manifest",
  "poster",
  "src",
  "usemap",
  "xlink:href",
]);

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

export function normalizeBasePath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    throw new Error("basePath must be an absolute URL path such as /project/ or /");
  }

  const parsed = new URL(value, "https://dominion.invalid");
  if (parsed.origin !== "https://dominion.invalid" || parsed.search || parsed.hash) {
    throw new Error("basePath must not include a query string, fragment, or external host");
  }

  return parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
}

async function listFiles(directory, relativeDirectory = "", optional = false) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" && optional && relativeDirectory === "") {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    const relativePath = relativeDirectory ? path.posix.join(relativeDirectory, entry.name) : entry.name;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic links are not supported in build inputs: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolutePath, relativePath)));
    } else if (entry.isFile()) {
      files.push({ absolutePath, relativePath });
    }
  }
  return files;
}

function addOutput(outputs, outputPath, sourcePath, kind) {
  const normalizedPath = outputPath.split(path.sep).join("/");
  const key = normalizedPath.toLowerCase();
  const existing = outputs.get(key);
  if (existing) {
    throw new Error(`Output collision at ${normalizedPath}: ${existing.sourcePath} and ${sourcePath}`);
  }
  outputs.set(key, { outputPath: normalizedPath, sourcePath, kind });
}

function assertNoFileDirectoryCollisions(outputs) {
  const sortedOutputs = [...outputs.values()].sort((left, right) => compareText(left.outputPath, right.outputPath));
  for (const output of sortedOutputs) {
    const segments = output.outputPath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const directoryPath = segments.slice(0, index).join("/");
      const existing = outputs.get(directoryPath.toLowerCase());
      if (existing) {
        throw new Error(`Output collision: ${existing.sourcePath} conflicts with directory required by ${output.sourcePath}`);
      }
    }
  }
}

function rewriteRootUrls(html, basePath) {
  if (!basePath) {
    return html;
  }

  const document = parse(html);
  const rewriteUrl = (value) => {
    const trimmed = value.trim();
    return trimmed.startsWith("/") && !trimmed.startsWith("//")
      ? `${basePath}${trimmed}`
      : value;
  };

  function visit(node) {
    if (node.attrs) {
      for (const attribute of node.attrs) {
        if (URL_ATTRIBUTES.has(attribute.name)) {
          attribute.value = rewriteUrl(attribute.value);
        } else if (attribute.name === "srcset") {
          const candidates = parseSrcset(attribute.value.trim());
          if (candidates.length > 0) {
            attribute.value = candidates.map((candidate) => {
              const descriptors = [
                candidate.w && `${candidate.w}w`,
                candidate.h && `${candidate.h}h`,
                candidate.d && `${candidate.d}x`,
              ].filter(Boolean).join(" ");
              return `${rewriteUrl(candidate.url)}${descriptors ? ` ${descriptors}` : ""}`;
            }).join(", ");
          }
        }
      }
    }
    for (const child of node.childNodes ?? []) {
      visit(child);
    }
    if (node.content) {
      visit(node.content);
    }
  }
  visit(document);
  return serialize(document);
}

async function planOutputs(rootDir, basePath, pipeline) {
  const sourceRoot = path.join(rootDir, "src");
  const sourceInfo = await lstat(sourceRoot).catch((error) => {
    if (error.code === "ENOENT") {
      throw new Error("Project source directory not found: src/");
    }
    throw error;
  });
  if (!sourceInfo.isDirectory()) {
    throw new Error("Project source path must be a directory: src/");
  }

  const pages = (await listFiles(sourceRoot)).filter((file) => file.relativePath.toLowerCase().endsWith(".html"));
  const publicFiles = await listFiles(path.join(rootDir, "public"), "", true);
  const outputs = new Map();

  for (const page of pages) {
    addOutput(outputs, page.relativePath, `src/${page.relativePath}`, "page");
  }
  for (const file of publicFiles) {
    addOutput(outputs, file.relativePath, `public/${file.relativePath}`, "asset");
  }
  assertNoFileDirectoryCollisions(outputs);

  const sortedOutputs = [...outputs.values()].sort((left, right) => compareText(left.outputPath, right.outputPath));
  const planned = [];
  for (const output of sortedOutputs) {
    const sourcePath = output.kind === "page"
      ? path.join(sourceRoot, output.outputPath)
      : path.join(rootDir, "public", output.outputPath);
    let contents = await readFile(sourcePath);
    if (output.kind === "page") {
      let html = contents.toString("utf8");
      const context = { sourcePath: output.sourcePath, outputPath: output.outputPath, basePath };
      html = await pipeline.expandFragments(html, context);
      html = await pipeline.emitScripts(html, context);
      html = await pipeline.generatePageCss(html, context);
      contents = Buffer.from(rewriteRootUrls(html, basePath));
    }
    planned.push({ outputPath: output.outputPath, contents });
  }
  return { planned, pageCount: pages.length, assetCount: publicFiles.length };
}

async function replaceOutput(outputDir, planned) {
  const parentDir = path.dirname(outputDir);
  const outputName = path.basename(outputDir);
  const stageDir = await mkdtemp(path.join(parentDir, `.${outputName}-stage-`));
  const backupDir = path.join(parentDir, `.${outputName}-backup-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  let backedUp = false;

  try {
    for (const output of planned) {
      const destination = path.join(stageDir, output.outputPath);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, output.contents);
    }

    try {
      await rename(outputDir, backupDir);
      backedUp = true;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    try {
      await rename(stageDir, outputDir);
    } catch (error) {
      if (backedUp) {
        await rename(backupDir, outputDir);
        backedUp = false;
      }
      throw error;
    }

    if (backedUp) {
      await rm(backupDir, { recursive: true, force: true });
    }
  } catch (error) {
    await rm(stageDir, { recursive: true, force: true });
    throw error;
  }
}

export async function buildProject({ rootDir = process.cwd(), basePath = "", pipeline = {} } = {}) {
  const stages = {
    expandFragments: pipeline.expandFragments ?? (async (html, context) => expandSharedFragments(html, rootDir, context)),
    emitScripts: pipeline.emitScripts ?? (async (html) => html),
    generatePageCss: pipeline.generatePageCss ?? (async (html) => html),
  };
  const normalizedBasePath = normalizeBasePath(basePath || "/");
  const outputDir = path.join(rootDir, "dist");
  const { planned, pageCount, assetCount } = await planOutputs(rootDir, normalizedBasePath, stages);
  await replaceOutput(outputDir, planned);
  return { pageCount, assetCount };
}