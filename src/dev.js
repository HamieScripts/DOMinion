import { watch } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { buildProject, normalizeBasePath } from "./build.js";

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function sendText(response, statusCode, text, headers = {}) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(text);
}

function createOutputQueue() {
  let pending = Promise.resolve();
  return (operation) => {
    const result = pending.then(operation, operation);
    pending = result.then(() => undefined, () => undefined);
    return result;
  };
}

function createRequestHandler(distDir, basePath, withOutputAccess) {
  return async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendText(response, 405, "Method Not Allowed\n", { allow: "GET, HEAD" });
      return;
    }

    let requestPath;
    try {
      requestPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    } catch {
      sendText(response, 400, "Bad Request\n");
      return;
    }
    if (requestPath.includes("\\") || requestPath.includes("\0")) {
      sendText(response, 404, "Not Found\n");
      return;
    }

    if (basePath && requestPath === basePath) {
      response.writeHead(308, { location: `${basePath}/`, "cache-control": "no-store" });
      response.end();
      return;
    }
    if (basePath && !requestPath.startsWith(`${basePath}/`)) {
      sendText(response, 404, "Not Found\n");
      return;
    }

    const mountedPath = basePath ? requestPath.slice(basePath.length) : requestPath;
    const directoryRequest = mountedPath === "" || mountedPath.endsWith("/");
    const relativePath = directoryRequest
      ? path.posix.join(mountedPath, "index.html")
      : mountedPath;
    const outputPath = path.resolve(distDir, `.${relativePath}`);
    const outputRelativePath = path.relative(distDir, outputPath);
    if (outputRelativePath === ".." || outputRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(outputRelativePath)) {
      sendText(response, 404, "Not Found\n");
      return;
    }

    try {
      const contents = await withOutputAccess(() => readFile(outputPath));
      response.writeHead(200, {
        "content-type": contentTypes.get(path.extname(outputPath).toLowerCase()) ?? "application/octet-stream",
        "content-length": contents.length,
        "cache-control": "no-store",
      });
      response.end(request.method === "HEAD" ? undefined : contents);
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code)) {
        sendText(response, 404, "Not Found\n");
        return;
      }
      sendText(response, 500, "Internal Server Error\n");
      process.stderr.write(`dominion dev: preview read failed: ${error.message}\n`);
    }
  };
}

function closeWatchedTree(directory, watchers, directoryWatchers) {
  const absoluteDirectory = path.resolve(directory);
  for (const [watchedDirectory, watcher] of directoryWatchers) {
    if (watchedDirectory === absoluteDirectory || watchedDirectory.startsWith(`${absoluteDirectory}${path.sep}`)) {
      directoryWatchers.delete(watchedDirectory);
      watchers.delete(watcher);
      watcher.close();
    }
  }
}

async function watchTree(directory, onChange, watchers, directoryWatchers) {
  const absoluteDirectory = path.resolve(directory);
  if (directoryWatchers.has(absoluteDirectory)) {
    return;
  }

  let entries;
  try {
    const info = await lstat(absoluteDirectory);
    if (!info.isDirectory()) {
      return;
    }
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  const watcher = watch(absoluteDirectory, (eventType, filename) => {
    onChange();
    if (eventType === "rename" && filename) {
      const changedPath = path.join(absoluteDirectory, filename.toString());
      closeWatchedTree(changedPath, watchers, directoryWatchers);
      void watchTree(changedPath, onChange, watchers, directoryWatchers);
    }
  });
  directoryWatchers.set(absoluteDirectory, watcher);
  watcher.on("error", (error) => {
    if (directoryWatchers.get(absoluteDirectory) === watcher) {
      closeWatchedTree(absoluteDirectory, watchers, directoryWatchers);
    }
    process.stderr.write(`dominion dev: watch failed for ${absoluteDirectory}: ${error.message}\n`);
  });
  watchers.add(watcher);

  await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => watchTree(path.join(absoluteDirectory, entry.name), onChange, watchers, directoryWatchers)));
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server.address().port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

export async function startDevServer({ rootDir = process.cwd(), basePath = "/", port = 3000 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("port must be an integer between 0 and 65535");
  }

  const normalizedBasePath = normalizeBasePath(basePath || "/");
  const distDir = path.join(rootDir, "dist");
  const initialBuild = await buildProject({ rootDir, basePath: normalizedBasePath });
  const withOutputAccess = createOutputQueue();
  const server = createServer(createRequestHandler(distDir, normalizedBasePath, withOutputAccess));
  let actualPort;
  try {
    actualPort = await listen(server, port);
  } catch (error) {
    if (error.code !== "EADDRINUSE") {
      throw error;
    }
    actualPort = await listen(server, 0);
  }

  let buildTimer;
  let building = false;
  let rebuildPending = false;
  let closing = false;
  let activeBuild = Promise.resolve();
  const scheduleBuild = () => {
    if (closing) {
      return;
    }
    clearTimeout(buildTimer);
    buildTimer = setTimeout(() => {
      if (closing) {
        return;
      }
      if (building) {
        rebuildPending = true;
        return;
      }
      activeBuild = rebuild();
    }, 100);
  };
  const rebuild = async () => {
    building = true;
    do {
      rebuildPending = false;
      try {
        const result = await withOutputAccess(() => buildProject({ rootDir, basePath: normalizedBasePath }));
        process.stdout.write(`Rebuilt ${result.pageCount} page(s) and ${result.assetCount} asset(s)\n`);
      } catch (error) {
        process.stderr.write(`dominion dev: build failed: ${error.message}\n`);
      }
    } while (rebuildPending);
    building = false;
  };

  const watchers = new Set();
  const directoryWatchers = new Map();
  const rootWatcher = watch(rootDir, (eventType, filename) => {
    const changedPath = filename?.toString();
    if (changedPath === "tailwind.css" || changedPath === "dominion.config.json") {
      scheduleBuild();
    } else if (["src", "shared", "public"].includes(changedPath)) {
      const directory = path.join(rootDir, changedPath);
      closeWatchedTree(directory, watchers, directoryWatchers);
      void watchTree(directory, scheduleBuild, watchers, directoryWatchers);
      scheduleBuild();
    }
  });
  rootWatcher.on("error", (error) => {
    process.stderr.write(`dominion dev: project watch failed: ${error.message}\n`);
  });
  watchers.add(rootWatcher);
  await Promise.all(["src", "shared", "public"].map((directory) => (
    watchTree(path.join(rootDir, directory), scheduleBuild, watchers, directoryWatchers)
  )));

  const url = `http://127.0.0.1:${actualPort}${normalizedBasePath || ""}/`;
  return {
    ...initialBuild,
    port: actualPort,
    url,
    async close() {
      closing = true;
      clearTimeout(buildTimer);
      for (const watcher of watchers) {
        watcher.close();
      }
      await activeBuild;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}