const fs = require("node:fs");
const path = require("node:path");
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats");

const schemaPath = path.join(
  __dirname,
  "../../apps/host-image/manifest.schema.json",
);
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

function commonManifest() {
  return {
    schemaVersion: 1,
    imageVersion: "0.24.0",
    builtAt: "2026-09-26T00:00:00.000Z",
    arch: "amd64",
    base: { name: "ubuntu-24.04-minimal-cloudimg-amd64" },
    npmRegistry: "https://registry.npmjs.org/",
    bootstrap: { package: "devchain-host-bootstrap", version: "0.1.0" },
    packages: {
      tmux: "3.4-1",
      git: "1:2.43.0-1",
      curl: "8.5.0-2",
      "build-essential": "12.10ubuntu1",
      python3: "3.12.3-0ubuntu2",
      "ca-certificates": "20240203",
      "xz-utils": "5.6.1-1",
      syncthing: "2.1.5",
    },
    runtimes: { node: "24.21.0", npm: "11.0.0" },
    syncthingCli: "syncthing v2.1.5",
  };
}

function isValid(manifest) {
  return validate(manifest);
}

describe("host image manifest schema", () => {
  it("accepts image manifests with image provenance and QEMU guest tools", () => {
    const manifest = commonManifest();
    manifest.base.serial = "20260905";
    manifest.base.sha256 = "a".repeat(64);
    manifest.packages["qemu-guest-agent"] = "1:8.2-0ubuntu1";

    expect(isValid(manifest)).toBe(true);
  });

  it("accepts installed VMware hosts with only a base name", () => {
    const manifest = commonManifest();
    manifest.base = { name: "ubuntu-24.04-installed" };
    manifest.install = {
      method: "devchain-host-install",
      devchainVersion: "0.24.0",
      installedAt: "2026-09-26T00:00:00.000Z",
    };
    manifest.packages["open-vm-tools"] = "2:12.4.5-1";

    expect(isValid(manifest)).toBe(true);
  });

  it("accepts installed hosts without guest tools", () => {
    const manifest = commonManifest();
    manifest.base = { name: "debian-12-installed" };
    manifest.install = {
      method: "devchain-host-install",
      devchainVersion: "0.24.0",
      installedAt: "2026-09-26T00:00:00.000Z",
    };

    expect(isValid(manifest)).toBe(true);
  });

  it("rejects image manifests missing image provenance", () => {
    const manifest = commonManifest();

    expect(isValid(manifest)).toBe(false);
    expect(validate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instancePath: "/base",
          keyword: "required",
          params: expect.objectContaining({ missingProperty: "serial" }),
        }),
      ]),
    );
  });
});
