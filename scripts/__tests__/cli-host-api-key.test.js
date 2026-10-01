const fs = require("node:fs");
const { mkdtempSync, writeFileSync, mkdirSync, readFileSync, lstatSync, symlinkSync, rmSync, readdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const { runHostApiKeyReset } = require("../lib/host-api-key");

const ACCOUNT = { uid: 1000, gid: 1000 };

function makeVm({ claim = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "devchain-apikey-"));
  const etcDir = join(root, "etc");
  const homePath = join(root, "home", "vmuser");
  mkdirSync(etcDir, { recursive: true });
  mkdirSync(homePath, { recursive: true });
  if (claim) {
    writeFileSync(join(etcDir, "claim.json"), JSON.stringify({ userName: "vmuser", homePath }));
  }
  return {
    root,
    etcDir,
    homePath,
    keyDir: join(homePath, ".devchain"),
    keyFile: join(homePath, ".devchain", "host-api-key"),
  };
}

function run(vm, { getuid = () => ACCOUNT.uid, ...rest } = {}) {
  return runHostApiKeyReset({
    env: { DEVCHAIN_HOST_ETC_DIR: vm.etcDir },
    getuid,
    lookupAccount: () => ACCOUNT,
    log: jest.fn(),
    error: jest.fn(),
    ...rest,
  });
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

describe("devchain host api-key reset", () => {
  let vms;

  beforeEach(() => {
    vms = [];
  });

  afterEach(() => {
    for (const vm of vms) rmSync(vm.root, { recursive: true, force: true });
  });

  it("refuses without a claim record and writes nothing", () => {
    const vm = makeVm({ claim: false });
    vms.push(vm);
    const error = jest.fn();

    const exitCode = run(vm, { error });

    expect(exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith("This machine is not a claimed DevChain VM.");
    expect(fs.existsSync(vm.keyDir)).toBe(false);
  });

  it("writes the hash of the printed key as the claimed user", () => {
    const vm = makeVm();
    vms.push(vm);
    const log = jest.fn();

    const exitCode = run(vm, { log });

    expect(exitCode).toBe(0);
    const key = log.mock.calls[0][0];
    expect(key).toMatch(/^dck_[A-Za-z0-9_-]{43}$/);
    expect(fs.readFileSync(vm.keyFile, "utf8")).toBe(`${sha256(key)}\n`);
    expect(lstatSync(vm.keyFile).mode & 0o777).toBe(0o600);
    expect(lstatSync(vm.keyDir).mode & 0o777).toBe(0o700);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1][0]).toContain("Remote VMs → <VM> → Enter API key");
    expect(log.mock.calls[1][0]).not.toContain(key);
  });

  it("refuses as a different non-root user and writes nothing", () => {
    const vm = makeVm();
    vms.push(vm);
    const error = jest.fn();

    const exitCode = run(vm, { getuid: () => 1234, error });

    expect(exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("vmuser"));
    expect(fs.existsSync(vm.keyDir)).toBe(false);
  });

  it("as root, hands the key file and a newly created key dir to the claimed user", () => {
    const vm = makeVm();
    vms.push(vm);
    const chownSync = jest.fn();
    const log = jest.fn();

    const exitCode = run(vm, { getuid: () => 0, chownSync, log });

    expect(exitCode).toBe(0);
    expect(chownSync).toHaveBeenCalledWith(vm.keyDir, ACCOUNT.uid, ACCOUNT.gid);
    expect(chownSync).toHaveBeenCalledWith(
      expect.stringContaining(".host-api-key.tmp-"),
      ACCOUNT.uid,
      ACCOUNT.gid,
    );
    expect(readdirSync(vm.keyDir)).toEqual(["host-api-key"]);
    expect(fs.readFileSync(vm.keyFile, "utf8")).toBe(`${sha256(log.mock.calls[0][0])}\n`);
  });

  it("as root with an existing key dir, chowns only the temp key file", () => {
    const vm = makeVm();
    vms.push(vm);
    mkdirSync(vm.keyDir, { mode: 0o700 });
    const chownSync = jest.fn();

    const exitCode = run(vm, { getuid: () => 0, chownSync });

    expect(exitCode).toBe(0);
    expect(chownSync).toHaveBeenCalledTimes(1);
    expect(chownSync).toHaveBeenCalledWith(
      expect.stringContaining(".host-api-key.tmp-"),
      ACCOUNT.uid,
      ACCOUNT.gid,
    );
  });

  it("refuses a symbolic link at the target", () => {
    const vm = makeVm();
    vms.push(vm);
    mkdirSync(vm.keyDir, { mode: 0o700 });
    symlinkSync("/elsewhere/host-api-key", vm.keyFile);
    const error = jest.fn();

    const exitCode = run(vm, { error });

    expect(exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("symbolic link"));
    expect(lstatSync(vm.keyFile).isSymbolicLink()).toBe(true);
  });

  it("refuses a dangling symbolic link at the target", () => {
    const vm = makeVm();
    vms.push(vm);
    mkdirSync(vm.keyDir, { mode: 0o700 });
    symlinkSync(join(vm.root, "missing"), vm.keyFile);

    const exitCode = run(vm);

    expect(exitCode).toBe(1);
    expect(lstatSync(vm.keyFile).isSymbolicLink()).toBe(true);
  });

  it("two runs print different keys and the file holds the hash of the last one", () => {
    const vm = makeVm();
    vms.push(vm);
    const firstLog = jest.fn();
    const secondLog = jest.fn();

    expect(run(vm, { log: firstLog })).toBe(0);
    expect(run(vm, { log: secondLog })).toBe(0);

    const firstKey = firstLog.mock.calls[0][0];
    const secondKey = secondLog.mock.calls[0][0];
    expect(firstKey).not.toBe(secondKey);
    expect(fs.readFileSync(vm.keyFile, "utf8")).toBe(`${sha256(secondKey)}\n`);
  });

  it("fails closed when the claimed account cannot be resolved", () => {
    const vm = makeVm();
    vms.push(vm);
    const error = jest.fn();

    const exitCode = run(vm, { lookupAccount: () => null, error });

    expect(exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("vmuser"));
    expect(fs.existsSync(vm.keyDir)).toBe(false);
  });

  it("fails closed on a malformed claim record", () => {
    const vm = makeVm();
    vms.push(vm);
    writeFileSync(join(vm.etcDir, "claim.json"), "{not json");
    const error = jest.fn();

    const exitCode = run(vm, { error });

    expect(exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Cannot read the claim record"));
    expect(fs.existsSync(vm.keyDir)).toBe(false);
  });
});
