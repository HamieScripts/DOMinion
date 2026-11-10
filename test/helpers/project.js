import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function createProject(t, projectType = "build") {
  const root = mkdtempSync(path.join(os.tmpdir(), `dominion-${projectType}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

export function writeProjectFile(root, relativePath, contents) {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}