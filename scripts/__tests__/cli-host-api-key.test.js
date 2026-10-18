const fs = require("node:fs");
const {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  lstatSync,
  symlinkSync,
  rmSync,
  readdirSync,
} = require("node:fs");
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
    writeFileSync(
      join(etcDir, "claim.json"),
      JSON.stringify({ userName: "vmuser", homePath }),
    );
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
    env: {
      DEVCHAIN_HOST_ETC_DIR: vm.etcDir,
      ...(getuid() === 0 ? { SUDO_USER: "vmuser" } : {}),
    },
    getuid,
    getUserInfo: () => ({ username: getuid() === 0 ? "root" : "vmuser" }),
    lookupAccount: () => ACCOUNT,
    log: jest.fn(),
    error: jest.fn(),
    ...rest,
  });
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// Real temporary files prove caller selection and that another instance's key stays intact.
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
    expect(error).toHaveBeenCalledWith(
      "This machine is not a claimed DevChain VM.",
    );
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

  it("under sudo, hands the key file and a newly created key dir to the calling user", () => {
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
    expect(fs.readFileSync(vm.keyFile, "utf8")).toBe(
      `${sha256(log.mock.calls[0][0])}\n`,
    );
  });

  it("under sudo with an existing key dir, chowns only the temp key file", () => {
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
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("symbolic link"),
    );
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
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Cannot read the claim record"),
    );
    expect(fs.existsSync(vm.keyDir)).toBe(false);
  });

  function sharedVm() {
    const vm = makeVm();
    vms.push(vm);
    const joinedEtc = join(vm.etcDir, "instances", "bob");
    const joinedHome = join(vm.root, "home", "bob");
    const joinedKey = join(joinedHome, ".devchain", "host-api-key");
    mkdirSync(joinedEtc, { recursive: true });
    mkdirSync(joinedHome, { recursive: true });
    writeFileSync(
      join(joinedEtc, "claim.json"),
      JSON.stringify({ userName: "bob", homePath: joinedHome }),
    );
    mkdirSync(vm.keyDir);
    writeFileSync(vm.keyFile, "legacy digest\n");
    mkdirSync(join(joinedHome, ".devchain"));
    writeFileSync(joinedKey, "joined digest\n");
    return { ...vm, joinedEtc, joinedKey };
  }

  it.each([
    ["root", 0, "vmuser", false],
    ["bob", 1001, "vmuser", true],
  ])(
    "resets only the caller's instance as %s uid=%i sudo=%p scoped=%p",
    (caller, uid, sudoUser, scoped) => {
      const vm = sharedVm();
      const log = jest.fn();
      const selectedUser = uid === 0 ? sudoUser : caller;
      const selectedKey = selectedUser === "bob" ? vm.joinedKey : vm.keyFile;
      const otherKey = selectedUser === "bob" ? vm.keyFile : vm.joinedKey;
      const otherBefore = readFileSync(otherKey, "utf8");
      expect(
        run(vm, {
          env: {
            DEVCHAIN_HOST_ETC_DIR: scoped ? vm.joinedEtc : vm.etcDir,
            SUDO_USER: sudoUser,
          },
          getuid: () => uid,
          getUserInfo: () => ({ username: caller }),
          lookupAccount: (name) =>
            name === "bob" ? { uid: 1001, gid: 1001 } : ACCOUNT,
          chownSync: jest.fn(),
          log,
        }),
      ).toBe(0);
      expect(readFileSync(selectedKey, "utf8")).toBe(
        `${sha256(log.mock.calls[0][0])}\n`,
      );
      expect(readFileSync(otherKey, "utf8")).toBe(otherBefore);
    },
  );

  it.each([1001, 0])(
    "resolves the caller's joined instance without app env under uid=%i",
    (uid) => {
      const vm = sharedVm();
      const read = fs.readFileSync;
      const list = fs.readdirSync;
      const inVm = (file) =>
        String(file).replace(/^\/etc\/devchain-host(?=\/|$)/, vm.etcDir);
      const readSpy = jest
        .spyOn(fs, "readFileSync")
        .mockImplementation((file, ...args) => read(inVm(file), ...args));
      const listSpy = jest
        .spyOn(fs, "readdirSync")
        .mockImplementation((file, ...args) => list(inVm(file), ...args));
      const log = jest.fn();
      try {
        expect(
          run(vm, {
            env: uid === 0 ? { SUDO_USER: "bob" } : {},
            getuid: () => uid,
            getUserInfo: () => ({ username: uid === 0 ? "root" : "bob" }),
            lookupAccount: () => ({ uid: 1001, gid: 1001 }),
            chownSync: jest.fn(),
            log,
          }),
        ).toBe(0);
        expect(read(vm.joinedKey, "utf8")).toBe(
          `${sha256(log.mock.calls[0][0])}\n`,
        );
        expect(read(vm.keyFile, "utf8")).toBe("legacy digest\n");
      } finally {
        readSpy.mockRestore();
        listSpy.mockRestore();
      }
    },
  );

  it.each([
    ["root", 0, undefined],
    ["root", 0, "admin"],
    ["admin", 1234, undefined],
  ])(
    "refuses an unregistered caller %s uid=%i sudo=%p and names instance users",
    (caller, uid, sudoUser) => {
      const vm = sharedVm();
      const error = jest.fn();
      const log = jest.fn();
      expect(
        run(vm, {
          env: { DEVCHAIN_HOST_ETC_DIR: vm.etcDir, SUDO_USER: sudoUser },
          getuid: () => uid,
          getUserInfo: () => ({ username: caller }),
          error,
          log,
        }),
      ).toBe(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("Instance users: bob, vmuser"),
      );
      expect(log).not.toHaveBeenCalled();
      expect(readFileSync(vm.keyFile, "utf8")).toBe("legacy digest\n");
      expect(readFileSync(vm.joinedKey, "utf8")).toBe("joined digest\n");
    },
  );

  it("refuses an instance whose claim names another user without falling back to legacy", () => {
    const vm = sharedVm();
    writeFileSync(
      join(vm.joinedEtc, "claim.json"),
      JSON.stringify({ userName: "vmuser", homePath: vm.homePath }),
    );
    const error = jest.fn();
    expect(run(vm, { error })).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('does not match instance user "bob"'),
    );
    expect(readFileSync(vm.keyFile, "utf8")).toBe("legacy digest\n");
    expect(readFileSync(vm.joinedKey, "utf8")).toBe("joined digest\n");
  });

  it("refuses a missing joined claim without resetting the legacy key", () => {
    const vm = sharedVm();
    fs.unlinkSync(join(vm.joinedEtc, "claim.json"));
    const error = jest.fn();
    expect(
      run(vm, {
        getUserInfo: () => ({ username: "bob" }),
        getuid: () => 1001,
        error,
      }),
    ).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('No DevChain instance belongs to "bob"'),
    );
    expect(readFileSync(vm.keyFile, "utf8")).toBe("legacy digest\n");
  });
});
