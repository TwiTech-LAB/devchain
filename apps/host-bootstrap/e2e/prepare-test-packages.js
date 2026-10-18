"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const repo = path.resolve(__dirname, "../../..");
const output = path.resolve(process.argv[2]);
const versions = process.argv.slice(3);
if (
  versions.length !== 2 ||
  versions.some((v) => !/^\d+\.\d+\.\d+-e2e\.\d+$/.test(v))
)
  throw new Error(
    "Usage: prepare-test-packages.js <output-dir> <x.y.z-e2e.1> <x.y.z-e2e.2>",
  );
fs.mkdirSync(output, { recursive: true });
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "devchain-e2e-package-"));
try {
  for (const name of [
    "dist",
    "prebuilds",
    "scripts/postinstall.js",
    "README.md",
    "LICENSE",
  ]) {
    fs.mkdirSync(path.dirname(path.join(staging, name)), { recursive: true });
    fs.cpSync(path.join(repo, name), path.join(staging, name), {
      recursive: true,
    });
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, "package.json")));
  const lock = JSON.parse(
    fs.readFileSync(path.join(repo, "npm-shrinkwrap.json")),
  );
  const catalog = {
    name: manifest.name,
    "dist-tags": { latest: versions[1] },
    versions: {},
  };
  for (const version of versions) {
    manifest.version = lock.version = lock.packages[""].version = version;
    fs.writeFileSync(
      path.join(staging, "package.json"),
      JSON.stringify(manifest, null, 2),
    );
    fs.writeFileSync(
      path.join(staging, "npm-shrinkwrap.json"),
      JSON.stringify(lock, null, 2),
    );
    const packed = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", output],
        { cwd: staging },
      ),
    );
    const filename = packed[0].filename;
    const bytes = fs.readFileSync(path.join(output, filename));
    catalog.versions[version] = {
      ...manifest,
      dist: {
        filename,
        shasum: crypto.createHash("sha1").update(bytes).digest("hex"),
        integrity:
          "sha512-" +
          crypto.createHash("sha512").update(bytes).digest("base64"),
      },
    };
  }
  fs.writeFileSync(path.join(output, "catalog.json"), JSON.stringify(catalog));
  process.stdout.write(
    "Prepared scratch versions " + versions.join(", ") + "\n",
  );
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
