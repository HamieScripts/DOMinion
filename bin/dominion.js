#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildProject, normalizeBasePath } from "../src/build.js";
import { startDevServer } from "../src/dev.js";
import { initProject } from "../src/init.js";

const help = `DOMinion builds static HTML websites.

Usage:
  dominion init [--force]
  dominion build [--base-path <path>]
  dominion dev [--port <port>]
  dominion --help

Options:
  --force             Replace existing scaffold files when initializing
  --base-path <path>  Deployment prefix for site-root URLs (default: /)
  --port <port>       Local preview port (default: 3000)
  -h, --help          Show this help

Project config:
  dominion.config.json: { "basePath": "/project/" }`;

function parseBuildArgs(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--base-path") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--base-path requires a path");
      }
      options.basePath = value;
      index += 1;
    } else if (argument === "-h" || argument === "--help") {
      return { help: true };
    } else {
      throw new Error(`Unknown build option: ${argument}`);
    }
  }

  return options;
}

function parseDevArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--port") {
      const value = args[index + 1];
      if (!value || value.startsWith("--") || !/^\d+$/.test(value)) {
        throw new Error("--port requires an integer between 0 and 65535");
      }
      options.port = Number(value);
      index += 1;
    } else if (argument === "--base-path") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--base-path requires a path");
      }
      options.basePath = value;
      index += 1;
    } else if (argument === "-h" || argument === "--help") {
      return { help: true };
    } else {
      throw new Error(`Unknown dev option: ${argument}`);
    }
  }
  return options;
}

async function readConfig(rootDir) {
  const configPath = path.join(rootDir, "dominion.config.json");
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in dominion.config.json: ${error.message}`);
    }
    throw error;
  }
  if (!config || Array.isArray(config) || typeof config !== "object") {
    throw new Error("dominion.config.json must contain a JSON object");
  }
  if (Object.hasOwn(config, "basePath") && typeof config.basePath !== "string") {
    throw new Error("dominion.config.json basePath must be a string");
  }
  return config;
}

async function main(args) {
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    process.stdout.write(`${help}\n`);
    return;
  }

  const [command, ...commandArgs] = args;
  if (command === "init") {
    const options = {};
    for (const argument of commandArgs) {
      if (argument === "--force") {
        options.force = true;
      } else {
        throw new Error(`Unknown init option: ${argument}`);
      }
    }
    const result = await initProject({ rootDir: process.cwd(), ...options });
    process.stdout.write(`Created DOMinion project with ${result.fileCount} files. Run npm install, then npm run dev.\n`);
    return;
  }
  if (command === "dev") {
    const options = parseDevArgs(commandArgs);
    if (options.help) {
      process.stdout.write(`${help}\n`);
      return;
    }
    const rootDir = process.cwd();
    const config = await readConfig(rootDir);
    const basePath = normalizeBasePath(options.basePath ?? config.basePath ?? "/");
    const result = await startDevServer({ rootDir, basePath, port: options.port ?? 3000 });
    process.stdout.write(`Built ${result.pageCount} page(s) and ${result.assetCount} asset(s) to dist/\n`);
    process.stdout.write(`Local preview: ${result.url}\n`);
    return;
  }
  if (command !== "build") {
    throw new Error(`Unknown command: ${command}`);
  }

  const options = parseBuildArgs(commandArgs);
  if (options.help) {
    process.stdout.write(`${help}\n`);
    return;
  }

  const rootDir = process.cwd();
  const config = await readConfig(rootDir);
  const basePath = normalizeBasePath(options.basePath ?? config.basePath ?? "/");
  const result = await buildProject({ rootDir, basePath });
  process.stdout.write(`Built ${result.pageCount} page(s) and ${result.assetCount} asset(s) to dist/\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`dominion: ${error.message}\n`);
  process.exitCode = 1;
});