const { __test__ } = require("../cli");

describe("start without a terminal (systemd)", () => {
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    process.stdin.isTTY = undefined;
  });

  afterEach(() => {
    process.stdin.isTTY = originalIsTTY;
    jest.restoreAllMocks();
  });

  it("skips the update check instead of prompting", async () => {
    const fetchMock = jest.spyOn(global, "fetch");
    const ask = jest.fn();

    await __test__.checkForUpdates({ blank: jest.fn(), warn: jest.fn(), info: jest.fn() }, ask);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it("answers a yes/no prompt with its default instead of exiting", async () => {
    const exit = jest.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    await expect(__test__.askYesNo("Proceed?", true)).resolves.toBe(true);
    await expect(__test__.askYesNo("Proceed?", false)).resolves.toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("the start update check", () => {
  it("runs in the parent process of a normal start", () => {
    expect(__test__.shouldCheckForUpdates({ updateCheck: true })).toBe(true);
  });

  it.each([
    ["--no-update-check", { updateCheck: false }],
    ["--dev", { updateCheck: true, dev: true }],
    ["the detached child", { updateCheck: true, internalDetachedChild: true }],
  ])("is skipped for %s", (_label, opts) => {
    expect(__test__.shouldCheckForUpdates(opts)).toBe(false);
  });
});
