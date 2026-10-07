const http = require("node:http");
const { spawn } = require("node:child_process");
const { mkdtemp, mkdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { runGitOwnerCommand } = require("../lib/git-owner");

const CLI = join(__dirname, "../cli.js");
const PROJECT = { id: "p1", rootPath: resolve("/work/project") };
const STATUS = {
  connected: true,
  remoteId: "r1",
  remoteName: "netbox-vm",
  owner: "vm",
  open: null,
};
const NOW = Date.parse("2026-10-05T21:00:00Z");

function response(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

function operation(state = "done", details = {}, steps = []) {
  return {
    id: "op1",
    state,
    details: { owner: "home", force: false, ...details },
    steps,
  };
}

function capture() {
  let text = "";
  return {
    write: (line) => {
      text += line;
    },
    text: () => text,
  };
}

function setup({
  status = STATUS,
  result = operation(),
  postStatus = 202,
} = {}) {
  const stdout = capture();
  const stderr = capture();
  let elapsed = 0;
  const fetch = jest.fn(async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === "/api/projects/by-path") return response(PROJECT);
    if (path === "/api/remotes/git-owner") return response(status);
    if (path === "/api/remotes/r1/git-owner" && init.method === "POST")
      return response(result, postStatus);
    throw new Error(`Unexpected request ${path}`);
  });
  const dependencies = {
    fetch,
    stdout,
    stderr,
    cwd: PROJECT.rootPath,
    getMachineRole: () => "home",
    getLocalApiBaseUrl: async () => "http://127.0.0.1:3000",
    wallNow: () => NOW,
    now: () => elapsed,
    sleep: async (ms) => {
      elapsed += ms;
    },
  };
  return { dependencies, fetch, stdout, stderr, elapsed: () => elapsed };
}

// Command-level fetch fakes test HTTP contracts, output and exit codes without a running VM.
describe("Git control commands", () => {
  it("walks to the nearest project from a subfolder, starts take, and prints progress and unknown agents", async () => {
    const test = setup();
    const nested = join(PROJECT.rootPath, "src", "lib");
    const lookedUp = [];
    const posted = [];
    let polls = 0;
    test.dependencies.fetch = async (url, init = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/api/projects/by-path") {
        const path = parsed.searchParams.get("path");
        lookedUp.push(path);
        return response(
          path === PROJECT.rootPath ? PROJECT : { message: "Not found" },
          path === PROJECT.rootPath ? 200 : 404,
        );
      }
      if (parsed.pathname === "/api/remotes/git-owner") return response(STATUS);
      if (init.method === "POST") {
        posted.push(JSON.parse(init.body));
        return response(
          operation(
            "running",
            { unknownAgents: [{ agentName: "Old session", state: "unknown" }] },
            [{ id: "git_flip", label: "Move Git control", state: "running" }],
          ),
          202,
        );
      }
      polls++;
      return response(
        operation("done", {}, [
          { id: "git_flip", label: "Move Git control", state: "done" },
        ]),
      );
    };
    expect(
      await runGitOwnerCommand("take", { project: nested }, test.dependencies),
    ).toBe(0);
    expect(lookedUp).toEqual([nested, dirname(nested), PROJECT.rootPath]);
    expect(posted).toEqual([{ projectId: "p1", owner: "home", force: false }]);
    expect(polls).toBe(1);
    expect(test.stderr.text()).toContain("Move Git control: running");
    expect(test.stderr.text()).toContain("Move Git control: done");
    expect(test.stderr.text()).toContain(
      "These agents on the VM have an unknown state. They do not block the switch:\n  - Old session (state unknown)",
    );
    expect(test.stdout.text()).toBe("Git for this project is on this PC.\n");
  });

  it("waits longer than the default request timeout while the server checks the VM", async () => {
    jest.useFakeTimers();
    try {
      const test = setup();
      const fetch = test.dependencies.fetch;
      let signal;
      test.dependencies.fetch = async (url, init = {}) => {
        if (init.method === "POST") {
          signal = init.signal;
          await new Promise((resolve) => setTimeout(resolve, 60_000));
        }
        return fetch(url, init);
      };
      const run = runGitOwnerCommand("take", {}, test.dependencies);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(await run).toBe(0);
      expect(signal.aborted).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("prints busy and starting agents with their ages and force hint, then exits 2", async () => {
    const test = setup({
      postStatus: 409,
      result: {
        code: "GIT_TAKE_AGENTS_BUSY",
        message: "Busy agents",
        details: {
          agents: [
            {
              agentName: "Coder",
              state: "busy",
              since: new Date(NOW - 4 * 60_000).toISOString(),
            },
            {
              agentName: "Reviewer",
              state: "starting",
              since: new Date(NOW - 60_000).toISOString(),
            },
          ],
        },
      },
    });
    expect(await runGitOwnerCommand("take", {}, test.dependencies)).toBe(2);
    expect(test.stderr.text()).toBe(
      "Git stays on the VM 'netbox-vm': 2 agents are working in this project.\n  - Coder (busy for 4 min)\n  - Reviewer (starting, 1 min)\nWait until they finish, then run `devchain git take` again.\nTo stop this project's agent sessions on the VM now, run `devchain git take --force`.\n",
    );
    expect(test.fetch).toHaveBeenCalledTimes(3);
    expect(test.stdout.text()).toBe("");
  });

  it.each([
    [{ ...STATUS, owner: "home" }, "Git for this project is on this PC."],
    [STATUS, "Git for this project is on the VM 'netbox-vm'."],
    [
      { ...STATUS, connected: false, remoteId: null },
      "This project is not connected to a VM.",
    ],
  ])("prints status without a mutation for %p", async (status, expected) => {
    const test = setup({ status });
    expect(await runGitOwnerCommand("status", {}, test.dependencies)).toBe(0);
    expect(test.stdout.text()).toBe(`${expected}\n`);
    expect(test.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["home", true, "devchain git take --force"],
    ["vm", false, "devchain git return"],
  ])(
    "prints the failed switch, step, error and recovery for %s",
    async (owner, force, command) => {
      const test = setup({
        status: {
          ...STATUS,
          open: {
            operationId: "failed1",
            owner,
            force,
            state: "failed",
            step: "git_flip",
            error: { message: "Peer is offline", code: "PEER_OFFLINE" },
          },
        },
      });
      expect(
        await runGitOwnerCommand(
          "status",
          { project: "/work/project" },
          test.dependencies,
        ),
      ).toBe(0);
      const output = test.stdout.text();
      expect(output).toContain("Git switch failed1: failed.");
      expect(output).toContain("Step: git_flip.");
      expect(output).toContain("Error: Peer is offline (PEER_OFFLINE)");
      expect(output).toContain(`${command} --project '/work/project'`);
    },
  );

  it.each(["take", "return"])(
    "prints cancellation before an already-owner result for %s",
    async (command) => {
      const owner = command === "take" ? "home" : "vm";
      const test = setup({
        postStatus: 200,
        result: { owner, changed: false, cancelledOperationId: "old1" },
      });
      expect(await runGitOwnerCommand(command, {}, test.dependencies)).toBe(0);
      expect(test.stdout.text()).toBe(
        `Cancelled the failed switch old1.\nGit for this project is already on ${owner === "home" ? "this PC" : "the VM 'netbox-vm'"}.\n`,
      );
      expect(test.fetch).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    ["take", { force: true }, "home", true],
    ["return", {}, "vm", false],
  ])(
    "sends the owner and force flags for %s",
    async (command, options, owner, force) => {
      const test = setup({ result: operation("done", { owner, force }) });
      expect(
        await runGitOwnerCommand(command, options, test.dependencies),
      ).toBe(0);
      const [, init] = test.fetch.mock.calls.at(-1);
      expect(JSON.parse(init.body)).toEqual({ projectId: "p1", owner, force });
    },
  );

  it.each([
    [{ guardWarning: "PC guard skipped" }, "PC guard skipped"],
    [{ vmGuardWarning: "VM guard skipped" }, "VM guard skipped"],
    [
      {
        pcGuardRemove: { indexRefreshed: false, warning: "PC refresh failed" },
      },
      "PC refresh failed",
    ],
    [
      { vmGuardRemove: { indexRefreshed: null, warning: null } },
      "The VM Git index was not rebuilt.",
    ],
  ])(
    "prints guard/index failures and returns 1: %p",
    async (details, warning) => {
      const test = setup({
        result: operation("failed", details, [
          {
            id: "cleanup",
            label: "Enable Git",
            state: "failed",
            error: { message: "Cleanup failed" },
          },
        ]),
      });
      expect(await runGitOwnerCommand("take", {}, test.dependencies)).toBe(1);
      expect(test.stderr.text()).toContain(`WARNING: ${warning}`);
      expect(test.stderr.text()).toContain("Cleanup failed");
      expect(test.stderr.text()).toContain("Run `devchain git take` again");
      expect(test.stdout.text()).toBe("");
    },
  );

  it.each([
    [
      {
        code: "GIT_SWITCH_UNFINISHED",
        message: "Repeat `devchain git return` to finish it.",
      },
      409,
      2,
    ],
    [
      {
        code: "conflict",
        message: "Cancel failed",
        details: { code: "REMOTE_OPERATION_CANCEL_FAILED" },
      },
      409,
      1,
    ],
    [{ code: "internal_error", message: "Rollback failed" }, 500, 1],
  ])(
    "prints server refusal or cancel failure with the correct exit code: %p",
    async (result, postStatus, expected) => {
      const test = setup({ result, postStatus });
      expect(await runGitOwnerCommand("take", {}, test.dependencies)).toBe(
        expected,
      );
      expect(test.stderr.text()).toContain(result.message);
      if (expected === 1)
        expect(test.stderr.text()).toContain("Run the same command again.");
      expect(test.stdout.text()).toBe("");
    },
  );

  it("follows the actual target of an already-running opposite switch", async () => {
    const test = setup({ result: operation("done", { owner: "vm" }) });
    expect(await runGitOwnerCommand("take", {}, test.dependencies)).toBe(0);
    expect(test.stdout.text()).toBe(
      "Git for this project is on the VM 'netbox-vm'.\n",
    );
  });

  it.each([false, true])(
    "exits 1 when DevChain is stopped or unreachable (%s)",
    async (unreachable) => {
      const test = setup();
      if (unreachable)
        test.dependencies.fetch = async () => {
          throw new Error("offline");
        };
      else test.dependencies.getLocalApiBaseUrl = async () => null;
      expect(await runGitOwnerCommand("take", {}, test.dependencies)).toBe(1);
      expect(test.stderr.text()).toContain(
        unreachable ? "Could not reach" : "Start DevChain first",
      );
    },
  );

  it("refuses an unregistered folder after reaching the filesystem root", async () => {
    const test = setup();
    test.dependencies.fetch = jest.fn(async () =>
      response({ message: "Not found" }, 404),
    );
    expect(
      await runGitOwnerCommand("take", { project: "/" }, test.dependencies),
    ).toBe(2);
    expect(test.dependencies.fetch).toHaveBeenCalledTimes(1);
    expect(test.stderr.text()).toContain("No registered project contains");
  });

  it("waits through a restart with backoff and resumes the operation", async () => {
    const test = setup({ result: operation("running") });
    const initialFetch = test.fetch;
    let polls = 0;
    test.dependencies.fetch = async (url, init) => {
      if (new URL(url).pathname === "/api/remotes/operations/op1") {
        if (++polls < 4) throw new Error("offline");
        return response(operation());
      }
      return initialFetch(url, init);
    };
    expect(await runGitOwnerCommand("take", {}, test.dependencies)).toBe(0);
    expect(test.elapsed()).toBe(8_000);
    expect(
      test.stderr.text().match(/waiting for it to come back/g),
    ).toHaveLength(1);
  });

  it("bounds an outage to three minutes and preserves the force/project recovery command", async () => {
    const test = setup({ result: operation("running", { force: true }) });
    const initialFetch = test.fetch;
    const delays = [];
    // Keep virtual time in the same context used by the shared restart helper.
    let time = 0;
    test.dependencies.now = () => time;
    test.dependencies.sleep = async (ms) => {
      delays.push(ms);
      time += ms;
    };
    test.dependencies.fetch = async (url, init) => {
      if (new URL(url).pathname === "/api/remotes/operations/op1")
        throw new Error("offline");
      return initialFetch(url, init);
    };
    expect(
      await runGitOwnerCommand(
        "take",
        { force: true, project: "/work/project" },
        test.dependencies,
      ),
    ).toBe(1);
    expect(time).toBe(181_000);
    expect(Math.max(...delays)).toBe(10_000);
    expect(test.stderr.text()).toContain("did not come back within 3 minutes");
    expect(test.stderr.text()).toContain(
      "devchain git take --force --project '/work/project'",
    );
  });
});

function runCli(args, env, cwd) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

// Subprocesses verify Commander wiring and real claim/PID discovery, which fetch fakes cannot exercise.
describe("Git CLI wiring", () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "devchain-git-cli-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(["status", "take", "return"])(
    "refuses git %s on a claimed VM without a terminal",
    async (command) => {
      await writeFile(join(root, "claim.json"), "{}");
      const result = await runCli(["git", command], {
        DEVCHAIN_HOST_ETC_DIR: root,
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toBe(
        "Run this command on the PC that connected this project.\n",
      );
      expect(result.stdout).toBe("");
    },
  );

  it("runs take --force from a subfolder against the discovered local app", async () => {
    const projectRoot = join(root, "project");
    const subfolder = join(projectRoot, "src");
    await mkdir(subfolder, { recursive: true });
    await mkdir(join(root, ".devchain"));
    const requests = [];
    const server = http.createServer(async (request, reply) => {
      const url = new URL(request.url, "http://localhost");
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push({
        path: url.pathname,
        project: url.searchParams.get("path"),
        body: body ? JSON.parse(body) : null,
      });
      reply.setHeader("Content-Type", "application/json");
      if (url.pathname === "/api/projects/by-path") {
        reply.statusCode =
          url.searchParams.get("path") === projectRoot ? 200 : 404;
        reply.end(JSON.stringify({ id: "p1", rootPath: projectRoot }));
      } else if (url.pathname === "/api/remotes/git-owner") {
        reply.end(JSON.stringify(STATUS));
      } else {
        reply.end(JSON.stringify({ owner: "home", changed: false }));
      }
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    try {
      await writeFile(
        join(root, ".devchain", "devchain.pid"),
        JSON.stringify({
          pid: process.pid,
          host: "0.0.0.0",
          port: server.address().port,
        }),
      );
      const result = await runCli(
        ["git", "take", "--force"],
        { HOME: root, DEVCHAIN_HOST_ETC_DIR: root },
        subfolder,
      );
      expect(result).toEqual({
        code: 0,
        stdout: "Git for this project is already on this PC.\n",
        stderr: "",
      });
      expect(requests.slice(0, 2).map((request) => request.project)).toEqual([
        subfolder,
        projectRoot,
      ]);
      expect(requests.at(-1)).toMatchObject({
        path: "/api/remotes/r1/git-owner",
        body: { projectId: "p1", owner: "home", force: true },
      });
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
});
