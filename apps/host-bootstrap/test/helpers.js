"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { installClis } = require("../lib/clis");
const { createSystem } = require("../lib/system");
const defaultPins = require("../../../scripts/host-cli-pins.json");

/**
 * Makes two unrelated test-only EC P-256 pairs with the same openssl command as
 * lib/tls.js, so no private key is committed. The pairs are cached per OS user in
 * the temp directory; the Local App tests use the same cache
 * (apps/local-app/src/common/test/tls-fixture.ts). Concurrent test processes race
 * safely: each builds in its own staging directory, and the first rename wins.
 */
function testTlsRoot() {
  const uid = process.getuid ? process.getuid() : "user";
  const root = path.join(os.tmpdir(), `devchain-test-tls-${uid}-v1`);
  const complete = () =>
    fs.existsSync(path.join(root, "tls-other", "cert.pem"));
  if (complete()) return root;
  const staging = fs.mkdtempSync(`${root}.tmp-`);
  try {
    for (const pair of ["tls", "tls-other"]) {
      fs.mkdirSync(path.join(staging, pair));
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:prime256v1",
          "-nodes",
          "-sha256",
          "-days",
          "3650",
          "-subj",
          "/CN=devchain-host",
          "-addext",
          "subjectAltName=DNS:devchain-host",
          "-keyout",
          path.join(staging, pair, "key.pem"),
          "-out",
          path.join(staging, pair, "cert.pem"),
        ],
        { stdio: "ignore" },
      );
    }
    fs.renameSync(staging, root);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (!complete()) throw error;
  }
  return root;
}

const TLS_ROOT = testTlsRoot();
const FIXTURE_TLS = path.join(TLS_ROOT, "tls");
const OTHER_TLS = path.join(TLS_ROOT, "tls-other");
const fixtureTls = {
  key: fs.readFileSync(path.join(FIXTURE_TLS, "key.pem")),
  cert: fs.readFileSync(path.join(FIXTURE_TLS, "cert.pem")),
};

/** Puts a key and certificate into `dir` the way the bootstrap leaves them. */
function installTls(dir, source = FIXTURE_TLS) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  fs.copyFileSync(path.join(source, "key.pem"), path.join(dir, "key.pem"));
  fs.chmodSync(path.join(dir, "key.pem"), 0o600);
  fs.copyFileSync(path.join(source, "cert.pem"), path.join(dir, "cert.pem"));
}

/**
 * A system rooted in a temp directory: commands are recorded, `useradd`
 * creates the home, `npm install` "installs" the version `devchain` reports,
 * `openssl req` writes the fixture pair. With `tls` (the default) the VM
 * already has its certificate.
 */
function fakeSystem({
  tls = true,
  users = [],
  groups = [],
  failOn,
  pinsByVersion = {},
  missingPins = false,
  registryCatalog = null,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-bootstrap-"));
  const paths = {
    etcDir: path.join(root, "etc/devchain-host"),
    profileDir: path.join(root, "etc/profile.d"),
    tlsDir: path.join(root, "etc/devchain-host/tls"),
    manifestFile: path.join(root, "manifest.json"),
    systemdDir: path.join(root, "systemd"),
    sudoersDir: path.join(root, "sudoers.d"),
    binDir: path.join(root, "bin"),
    cliPrefix: path.join(root, "usr/local"),
    installRoot: path.join(root, "opt"),
  };
  for (const dir of [paths.systemdDir, paths.sudoersDir, paths.binDir])
    fs.mkdirSync(dir);
  fs.writeFileSync(
    paths.manifestFile,
    JSON.stringify({
      imageVersion: "1.0.0",
      npmRegistry: "https://registry.example/",
    }),
  );
  if (tls) installTls(paths.tlsDir);
  const accounts = new Map(users.map((user) => [user.name, user]));
  const primaryGroups = new Map([
    ...users.map((user) => [user.name, { name: user.name, gid: user.gid }]),
    ...groups.map((group) => [group.name, group]),
  ]);
  const calls = [];
  const callDetails = [];
  const owners = new Map();
  let installed = null;
  // With registryCatalog (registry URL -> package names it serves), an
  // install from a registry without the package fails like npm's E404;
  // without it every registry serves everything.
  const registryArg = (args, spec) => {
    if (spec.startsWith("@")) {
      const scope = spec.slice(0, spec.indexOf("/"));
      const scoped = args.find((arg) => arg.startsWith(`--${scope}:registry=`));
      if (scoped) return scoped.slice(`--${scope}:registry=`.length);
    }
    const plain = args.find((arg) => arg.startsWith("--registry="));
    return plain ? plain.slice("--registry=".length) : null;
  };
  const run = async (command, args, options = {}) => {
    calls.push([command, ...args]);
    callDetails.push({ command, args: [...args], options });
    if (failOn && failOn(command, args)) throw new Error(`${command} failed`);
    if (command === "bash" && !options.env?.HOME)
      throw new Error("HOME missing");
    if (command === "openssl") {
      fs.copyFileSync(
        path.join(FIXTURE_TLS, "key.pem"),
        args[args.indexOf("-keyout") + 1],
      );
      fs.copyFileSync(
        path.join(FIXTURE_TLS, "cert.pem"),
        args[args.indexOf("-out") + 1],
      );
    }
    if (command === "groupadd") {
      const name = args.at(-1);
      const gidIndex = args.indexOf("-g");
      let gid = gidIndex === -1 ? 1001 : Number(args[gidIndex + 1]);
      while (
        gidIndex === -1 &&
        [...primaryGroups.values()].some((group) => group.gid === gid)
      )
        gid++;
      primaryGroups.set(name, { name, gid });
    }
    if (command === "useradd") {
      const home = args[args.indexOf("-d") + 1];
      const name = args.at(-1);
      const uidIndex = args.indexOf("-u");
      let uid = uidIndex === -1 ? 1001 : Number(args[uidIndex + 1]);
      while (
        uidIndex === -1 &&
        [...accounts.values()].some((account) => account.uid === uid)
      )
        uid++;
      const gid = Number(args[args.indexOf("-g") + 1]);
      fs.mkdirSync(home);
      accounts.set(name, { name, uid, gid, home });
    }
    if (command === "npm") {
      const spec = args.at(-1);
      const version = spec.split("@").at(-1);
      const prefix = args
        .find((arg) => arg.startsWith("--prefix="))
        .slice("--prefix=".length);
      if (registryCatalog && !spec.endsWith(".tgz")) {
        const pkg = spec.slice(0, spec.lastIndexOf("@"));
        const registry = registryArg(args, spec);
        if (!(registryCatalog[registry] ?? []).includes(pkg))
          throw new Error(
            `npm install ${spec}: 404 not found at ${registry ?? "the default registry"}`,
          );
      }
      if (spec.startsWith("devchain-cli@")) {
        installed = version;
        fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
        fs.writeFileSync(path.join(prefix, "bin", "devchain"), installed);
        const helperDir = path.join(
          prefix,
          "lib/node_modules/devchain-cli/dist/host-install",
        );
        fs.mkdirSync(helperDir, { recursive: true });
        fs.writeFileSync(
          path.join(helperDir, "devchain-host-bootstrap.tgz"),
          "helper archive",
        );
        fs.writeFileSync(
          path.join(helperDir, "pins.json"),
          JSON.stringify({
            bootstrap: {
              sha256: createHash("sha256")
                .update("helper archive")
                .digest("hex"),
            },
          }),
        );
        if (!missingPins) {
          const file = path.join(
            prefix,
            "lib/node_modules/devchain-cli/dist/host-cli-pins.json",
          );
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(
            file,
            JSON.stringify(pinsByVersion[version] ?? defaultPins),
          );
        }
      } else if (!spec.endsWith(".tgz")) {
        const pkg = spec.slice(0, spec.lastIndexOf("@"));
        const name = Object.keys(defaultPins).find(
          (key) => defaultPins[key].package === pkg,
        );
        const file = path.join(prefix, "lib/node_modules", pkg, "package.json");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ version }));
        fs.writeFileSync(path.join(paths.binDir, name), version);
      }
    }
    if (command === "bash")
      fs.writeFileSync(
        path.join(args[args.indexOf("--dir") + 1], "agy"),
        "1.0.0",
      );
    if (
      command === path.join(paths.binDir, "devchain-host-update") &&
      args[0] === "--clis"
    ) {
      const cliVersions = await installClis(args[1], sys);
      return { stdout: JSON.stringify({ cliVersions }) + "\n", stderr: "" };
    }
    if (command === "id") {
      const account = accounts.get(args.at(-1));
      const group = [...primaryGroups.values()].find(
        (group) => group.gid === account?.gid,
      );
      return { stdout: `${group?.name ?? args.at(-1)}\n`, stderr: "" };
    }
    if (command.endsWith("/agy")) return { stdout: "agy 1.0.0\n", stderr: "" };
    if (command.endsWith("/devchain"))
      return { stdout: `${installed}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const sys = createSystem({
    paths,
    run,
    lookupUser: async (name) => accounts.get(name) ?? null,
    lookupUid: async (uid) =>
      [...accounts.values()].find((account) => account.uid === uid) ?? null,
    lookupGroup: async (nameOrGid) =>
      (typeof nameOrGid === "number"
        ? [...primaryGroups.values()].find((group) => group.gid === nameOrGid)
        : primaryGroups.get(nameOrGid)) ?? null,
    listUsers: async () => [...accounts.values()],
    chown: (file, uid, gid) => owners.set(file, `${uid}:${gid}`),
    now: () => new Date("2026-09-24T10:00:00.000Z"),
  });
  return {
    sys,
    root,
    calls,
    callDetails,
    owners,
    accounts,
    groups: primaryGroups,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

/** The CLI versions a claim or update records when the fake installs every pin. */
function pinnedCliVersions() {
  return {
    claude: defaultPins.claude.version,
    codex: defaultPins.codex.version,
    copilot: defaultPins.copilot.version,
    opencode: defaultPins.opencode.version,
    agy: "agy 1.0.0",
  };
}

// The manifest registry mirrors only devchain-cli; the provider CLIs are
// public packages served by the public registry.
const manifestOnlyDevchainCatalog = {
  "https://registry.example/": ["devchain-cli"],
  "https://registry.npmjs.org/": [
    "@anthropic-ai/claude-code",
    "@openai/codex",
    "@github/copilot",
    "opencode-ai",
  ],
};

/**
 * devchain-cli installed from the manifest registry, and every pinned provider
 * CLI from the public registry with its scoped registry flag.
 */
function assertProviderClisInstalledFromPublicRegistry(callDetails) {
  const installs = callDetails.filter(
    ({ command, args }) => command === "npm" && args[0] === "install",
  );
  const devchain = installs.find(({ args }) =>
    args.at(-1).startsWith("devchain-cli@"),
  );
  assert.deepEqual(
    devchain.args.filter((arg) => arg.includes("registry")),
    ["--registry=https://registry.example/"],
  );
  for (const pin of Object.values(defaultPins)) {
    if (!pin.package) continue;
    const call = installs.find(({ args }) =>
      args.at(-1).startsWith(`${pin.package}@`),
    );
    assert.ok(call, `${pin.package} was installed`);
    assert.ok(
      call.args.includes("--registry=https://registry.npmjs.org/"),
      `${pin.package} installs from the public registry`,
    );
    if (pin.package.startsWith("@")) {
      const scope = pin.package.slice(0, pin.package.indexOf("/"));
      assert.ok(
        call.args.includes(`--${scope}:registry=https://registry.npmjs.org/`),
        `${pin.package} carries its scoped registry flag`,
      );
    }
  }
}

module.exports = {
  fakeSystem,
  fixtureTls,
  installTls,
  FIXTURE_TLS,
  OTHER_TLS,
  mode,
  pins: defaultPins,
  pinnedCliVersions,
  manifestOnlyDevchainCatalog,
  assertProviderClisInstalledFromPublicRegistry,
};
