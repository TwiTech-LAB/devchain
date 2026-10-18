"use strict";

const { spawnSync } = require("node:child_process");
const { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

// Run the real packaging producer in an isolated repo-shaped directory so the
// capability assertion covers the emitted pins, including its bootstrap archive.
test("packaging emits sharedVmProtocol 1 without changing package versions", () => {
  const source = resolve(__dirname, "../..");
  const root = mkdtempSync(join(tmpdir(), "shared-vm-packaging-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "apps/host-image/files"), { recursive: true });
    cpSync(join(source, "scripts/copy-cli.js"), join(root, "scripts/copy-cli.js"));
    writeFileSync(join(root, "scripts/cli.js"), "#!/usr/bin/env node\n");
    cpSync(join(source, "scripts/host-cli-pins.json"), join(root, "scripts/host-cli-pins.json"));
    cpSync(join(source, "apps/host-bootstrap"), join(root, "apps/host-bootstrap"), { recursive: true });
    cpSync(join(source, "apps/host-image/versions.env"), join(root, "apps/host-image/versions.env"));
    for (const name of ["60-devchain-inotify.conf", "devchain-no-session-bus.pref"])
      cpSync(join(source, "apps/host-image/files", name), join(root, "apps/host-image/files", name));
    const before = readFileSync(join(root, "apps/host-bootstrap/package.json"));
    const result = spawnSync(process.execPath, [join(root, "scripts/copy-cli.js")], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(0);
    const pins = JSON.parse(readFileSync(join(root, "dist/host-install/pins.json"), "utf8"));
    expect(pins.sharedVmProtocol).toBe(1);
    expect(pins.bootstrap.version).toBe(JSON.parse(before).version);
    expect(readFileSync(join(root, "apps/host-bootstrap/package.json"))).toEqual(before);
    expect(readFileSync(join(root, "dist/host-install/devchain-host-bootstrap.tgz")).length).toBeGreaterThan(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
