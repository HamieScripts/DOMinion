import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const starterFiles = new Map([
  ["dominion.config.json", `{
  "basePath": "/"
}
`],
  ["package.json", `{
  "name": "dominion-site",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "dominion build",
    "dev": "dominion dev"
  },
  "devDependencies": {
    "dominion": "^0.1.0"
  },
  "engines": {
    "node": ">=20"
  }
}
`],
  ["tailwind.css", `@theme {
  --color-brand: #176f5c;
  --font-display: Georgia, serif;
}
`],
  ["src/index.html", `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DOMinion starter</title>
</head>
<body class="bg-stone-50 text-stone-950">
  <dominion-navigation></dominion-navigation>
  <main class="mx-auto max-w-3xl px-6 py-16">
    <p class="font-semibold uppercase tracking-wide text-brand">A static site starter</p>
    <h1 class="mt-3 font-display text-5xl">Welcome to DOMinion</h1>
    <p class="mt-5 max-w-xl text-lg leading-8 text-stone-700">Build complete HTML pages from native markup, shared fragments, and Tailwind utilities.</p>
    <a class="mt-8 inline-flex rounded-sm bg-brand px-5 py-3 font-semibold text-white" href="/about/">About this project</a>
  </main>
</body>
</html>
`],
  ["src/about/index.html", `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>About | DOMinion starter</title>
</head>
<body class="bg-stone-50 text-stone-950">
  <dominion-navigation></dominion-navigation>
  <main class="mx-auto max-w-3xl px-6 py-16">
    <h1 class="font-display text-4xl">About this example</h1>
    <p class="mt-5 max-w-xl text-lg leading-8 text-stone-700">This page and the home page are separate HTML documents. Their navigation is expanded from one shared fragment at build time.</p>
    <img class="mt-8 h-16 w-16" src="/images/mark.svg" alt="DOMinion mark">
  </main>
</body>
</html>
`],
  ["shared/navigation.html", `<header class="border-b border-stone-200 bg-white">
  <nav class="mx-auto flex max-w-3xl items-center justify-between px-6 py-4" aria-label="Main navigation">
    <a class="font-display text-xl font-bold text-brand" href="/">DOMinion</a>
    <a class="font-medium text-stone-700 underline-offset-4 hover:underline" href="/about/">About</a>
  </nav>
</header>
`],
  ["public/images/mark.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-labelledby="title">
  <title id="title">DOMinion mark</title>
  <rect width="64" height="64" rx="8" fill="#176f5c"/>
  <path d="M16 17h15c11 0 18 6 18 15s-7 15-18 15H16V17zm14 23c6 0 10-3 10-8s-4-8-10-8h-5v16h5z" fill="#fff"/>
</svg>
`],
]);

export async function initProject({ rootDir = process.cwd(), force = false } = {}) {
  const conflicts = [];
  const checkedDirectories = new Set();
  for (const relativePath of starterFiles.keys()) {
    let parentPath = rootDir;
    let relativeParent = "";
    for (const segment of path.dirname(relativePath).split(path.sep).filter((part) => part !== ".")) {
      parentPath = path.join(parentPath, segment);
      relativeParent = path.posix.join(relativeParent, segment);
      if (checkedDirectories.has(relativeParent)) {
        continue;
      }
      checkedDirectories.add(relativeParent);
      try {
        const info = await lstat(parentPath);
        if (info.isSymbolicLink()) {
          throw new Error(`Refusing to write project files through a symbolic link: ${relativeParent}/`);
        }
        if (!info.isDirectory()) {
          throw new Error(`Refusing to write project files through a non-directory path: ${relativeParent}`);
        }
      } catch (error) {
        if (error.code === "ENOENT") {
          break;
        }
        throw error;
      }
    }

    try {
      const info = await lstat(path.join(rootDir, relativePath));
      if (!info.isFile() || info.isSymbolicLink() || !force) {
        conflicts.push(relativePath);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  if (conflicts.length > 0) {
    throw new Error(`Refusing to overwrite existing project files: ${conflicts.join(", ")}. Use --force to replace scaffold files.`);
  }

  for (const [relativePath, contents] of starterFiles) {
    const destination = path.join(rootDir, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }

  return { fileCount: starterFiles.size };
}