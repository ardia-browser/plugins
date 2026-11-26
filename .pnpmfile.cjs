const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const dir = join(__dirname, ".ardia-packages");
const listed = join(dir, "packages.json");
const local = existsSync(listed) ? JSON.parse(readFileSync(listed, "utf8")) : {};
const FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

function readPackage(pkg) {
  for (const field of FIELDS) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const [name, entry] of Object.entries(local)) if (deps[name] !== undefined) deps[name] = `file:${join(dir, entry.file)}`;
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
