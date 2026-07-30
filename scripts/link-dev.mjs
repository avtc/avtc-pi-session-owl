#!/usr/bin/env node
// Link avtc-pi-* dependencies to sibling dev folders for local development.
// Run once after clone + npm install. Re-run after rm -rf node_modules.
// See: dependency-tree-and-pi-install.md → "Dev workflow: link-dev symlinks"
import fs from "node:fs";
import path from "node:path";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const deps = Object.keys(pkg.dependencies || {}).filter((d) => d.startsWith("avtc-pi-"));
const isWin = process.platform === "win32";
const type = isWin ? "junction" : "dir";

if (!fs.existsSync("node_modules")) {
  console.error("node_modules not found. Run `npm install` first.");
  process.exit(1);
}

let linked = 0,
  skipped = 0;
for (const dep of deps) {
  const target = path.resolve(`../${dep}`);
  const link = path.resolve(`node_modules/${dep}`);

  if (!fs.existsSync(path.join(target, "package.json"))) {
    console.log(`  skip   ${dep} (no sibling folder)`);
    skipped++;
    continue;
  }

  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(target, link, type);
  console.log(`  linked ${dep} -> ../${dep}`);
  linked++;
}
console.log(`\nDone: ${linked} linked, ${skipped} skipped.`);
