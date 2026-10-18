const http = require("node:http");
const { spawn } = require("node:child_process");
const { mkdtemp, mkdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { runGitStatusCommand } = require("../lib/git-owner");

const CLI = join(__dirname, "../cli.js");
const PROJECT = { id: "p1", rootPath: resolve("/work/project") };
const CHECKPOINT_AT = Date.parse("2026-10-05T21:00:00Z");
const STATUS = {
  connected: true,
  remoteId: "r1",
  remoteName: "netbox-vm",
  owner: "home",
  generation: 7,
  live: true,
  homeWrites: 2,
  vmHolds: 1,
  transition: null,
  checkpoint: {
    writeId: "w0",
    generation: 6,
    refsDigest: "abc",
    at: CHECKPOINT_AT,
  },
  warnings: [],
};

function response(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
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

function setup(status = STATUS) {
  const stdout = capture();
  const stderr = capture();
  const fetch = jest.fn(async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/projects/by-path") return response(PROJECT);
    if (path === "/api/remotes/git-owner") return response(status);
    throw new Error(`Unexpected request ${path}`);
  });
  const dependencies = {
    fetch,
    stdout,
    stderr,
    cwd: PROJECT.rootPath,
    getMachineRole: () => "home",
    getLocalApiBaseUrl: async () => "http://127.0.0.1:3000",
  };
  return { dependencies, fetch, stdout, stderr };
}

// Command-level fetch fakes test HTTP contracts, output and exit codes without a running VM.
describe("devchain git status", () => {
  it("walks to the nearest project from a subfolder and prints the owner, generation, writes and checkpoint", async () => {
    const test = setup();
    const nested = join(PROJECT.rootPath, "src", "lib");
    const lookedUp = [];
    const requested = test.dependencies.fetch;
    test.dependencies.fetch = async (url, init) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/api/projects/by-path") {
        const path = parsed.searchParams.get("path");
        lookedUp.push(path);
        return response(
          path === PROJECT.rootPath ? PROJECT : { message: "Not found" },
          path === PROJECT.rootPath ? 200 : 404,
        );
      }
      return requested(url, init);
    };
    expect(
      await runGitStatusCommand({ project: nested }, test.dependencies),
    ).toBe(0);
    expect(lookedUp).toEqual([nested, dirname(nested), PROJECT.rootPath]);
    expect(requested.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:3000/api/remotes/git-owner?projectId=p1",
    ]);
    expect(test.stdout.text()).toBe(
      [
        "Git for this project is on this PC.",
        "Generation: 7",
        "In-flight writes: 2 on this PC, 1 on the VM",
        "Last checkpoint: generation 6 at 2026-10-05T21:00:00.000Z (write w0)",
        "",
      ].join("\n"),
    );
    expect(test.stderr.text()).toBe("");
  });

  it("prints the transition, warnings and a missing checkpoint, and marks a cached owner", async () => {
    const test = setup({
      ...STATUS,
      owner: "vm",
      live: false,
      checkpoint: null,
      transition: { kind: "handover", phase: "vm-receiving" },
      warnings: ["The VM could not be reached."],
    });
    expect(await runGitStatusCommand({}, test.dependencies)).toBe(0);
    expect(test.stdout.text()).toBe(
      [
        "Git for this project is on the VM 'netbox-vm' (last known; the VM was not reached).",
        "Generation: 7",
        "In-flight writes: 2 on this PC, 1 on the VM",
        "Last checkpoint: none",
        "Transition: handover, vm-receiving",
        "WARNING: The VM could not be reached.",
        "",
      ].join("\n"),
    );
  });

  it("says so when the project is not connected", async () => {
    const test = setup({ ...STATUS, connected: false, remoteId: null });
    expect(await runGitStatusCommand({}, test.dependencies)).toBe(0);
    expect(test.stdout.text()).toBe("This project is not connected to a VM.\n");
  });

  it("refuses an unregistered folder after reaching the filesystem root", async () => {
    const test = setup();
    test.dependencies.fetch = jest.fn(async () =>
      response({ message: "Not found" }, 404),
    );
    expect(await runGitStatusCommand({ project: "/" }, test.dependencies)).toBe(
      2,
    );
    expect(test.dependencies.fetch).toHaveBeenCalledTimes(1);
    expect(test.stderr.text()).toContain("No registered project contains");
  });

  it.each([
    ["DevChain is not running", async () => null, "Start DevChain first"],
    [
      "the app cannot be reached",
      async () => {
        throw new Error("Could not reach the running DevChain app.");
      },
      "Could not reach",
    ],
  ])("exits 1 when %s", async (_, getLocalApiBaseUrl, message) => {
    const test = setup();
    test.dependencies.getLocalApiBaseUrl = getLocalApiBaseUrl;
    expect(await runGitStatusCommand({}, test.dependencies)).toBe(1);
    expect(test.stderr.text()).toContain(message);
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

  it("lists status and no longer lists take or return", async () => {
    const help = await runCli(["git", "--help"], { HOME: root });
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/^\s+status\b/m);
    expect(help.stdout).not.toMatch(/^\s+(take|return)\b/m);
    for (const command of ["take", "return"]) {
      const result = await runCli(["git", command], { HOME: root });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(`unknown command '${command}'`);
    }
  });

  it("refuses git status on a claimed VM without a terminal", async () => {
    await writeFile(join(root, "claim.json"), "{}");
    const result = await runCli(["git", "status"], {
      DEVCHAIN_HOST_ETC_DIR: root,
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(
      "Run this command on the PC that connected this project.\n",
    );
    expect(result.stdout).toBe("");
  });

  it("runs status from a subfolder against the discovered local app", async () => {
    const projectRoot = join(root, "project");
    const subfolder = join(projectRoot, "src");
    await mkdir(subfolder, { recursive: true });
    await mkdir(join(root, ".devchain"));
    const requested = [];
    const server = http.createServer((request, reply) => {
      const url = new URL(request.url, "http://localhost");
      requested.push(url.pathname + url.search);
      reply.setHeader("Content-Type", "application/json");
      if (url.pathname === "/api/projects/by-path") {
        reply.statusCode =
          url.searchParams.get("path") === projectRoot ? 200 : 404;
        reply.end(JSON.stringify({ id: "p1", rootPath: projectRoot }));
      } else {
        reply.end(JSON.stringify(STATUS));
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
        ["git", "status"],
        { HOME: root, DEVCHAIN_HOST_ETC_DIR: root },
        subfolder,
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Git for this project is on this PC.");
      expect(result.stdout).toContain("Generation: 7");
      expect(requested.at(-1)).toBe("/api/remotes/git-owner?projectId=p1");
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
});
