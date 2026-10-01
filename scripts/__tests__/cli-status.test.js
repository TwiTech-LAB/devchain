const { mkdtempSync, writeFileSync, rmSync } = require("fs");
const { tmpdir } = require("os");
const { join } = require("path");
const { __test__ } = require("../cli");

describe("devchain status", () => {
  let etcDir;

  beforeEach(() => {
    etcDir = mkdtempSync(join(tmpdir(), "devchain-host-"));
  });

  afterEach(() => {
    rmSync(etcDir, { recursive: true, force: true });
  });

  it("reports a remote VM when the claim record exists", () => {
    writeFileSync(join(etcDir, "claim.json"), "{}");

    expect(__test__.getMachineRole({ DEVCHAIN_HOST_ETC_DIR: etcDir })).toBe("remote VM");
  });

  it("reports home without a claim record", () => {
    expect(__test__.getMachineRole({ DEVCHAIN_HOST_ETC_DIR: etcDir })).toBe("home");
  });
});

describe("devchain status sudo line", () => {
  const failWith = (code) => () => {
    throw Object.assign(new Error("sudo failed"), { code });
  };
  const check = (options) =>
    __test__.getSudoStatus({ platformName: "linux", getuid: () => 1000, ...options });

  it("reports sudo without a password when sudo -n succeeds", () => {
    const execFileSyncFn = jest.fn();

    expect(check({ execFileSyncFn })).toBe("yes (no password)");
    expect(execFileSyncFn).toHaveBeenCalledWith(
      "sudo",
      ["-n", "true"],
      expect.objectContaining({ stdio: "ignore", timeout: 5000 }),
    );
  });

  it("reports that sudo needs a password when sudo -n fails", () => {
    expect(check({ execFileSyncFn: failWith(undefined) })).toBe("needs a password");
  });

  it("reports sudo as not installed when the command is missing", () => {
    expect(check({ execFileSyncFn: failWith("ENOENT") })).toBe("not installed");
  });

  it("reports an unknown state when sudo does not answer in time", () => {
    expect(check({ execFileSyncFn: failWith("ETIMEDOUT") })).toBe(
      "unknown (sudo did not answer in 5 s)",
    );
  });

  it("reports root without running sudo", () => {
    const execFileSyncFn = jest.fn();

    expect(check({ getuid: () => 0, execFileSyncFn })).toBe("yes (running as root)");
    expect(execFileSyncFn).not.toHaveBeenCalled();
  });

  it("reports Windows without running sudo", () => {
    const execFileSyncFn = jest.fn();

    expect(check({ platformName: "win32", execFileSyncFn })).toBe("not available on Windows");
    expect(execFileSyncFn).not.toHaveBeenCalled();
  });
});
