#!/usr/bin/env node
// Only syntax every Node can parse here: on an old Node the bundle itself fails to load with a
// cryptic error (npm only warns about `engines`), so say what's needed before loading it.
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(
    `clockout: needs Node 22.12 or newer; this is Node ${process.versions.node}. Update Node (https://nodejs.org) and run it again.`,
  );
  process.exit(1);
}
await import("./main");

export {};
