const http = require("node:http");
const { execFileSync, spawn } = require("node:child_process");
const { mkdtemp, mkdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { PassThrough, Readable, Writable } = require("node:stream");
const { runHostInstallCommand, __test__ } = require("../lib/host-install");

const {
  ESTIMATE_REQUEST_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  promptLine,
  promptSecret,
  requestJson,
} = __test__;

const CLI_PATH = join(__dirname, "../cli.js");
const providerSkips = [
  "claude=skip",
  "copilot=skip",
  "codex=skip",
  "agy=skip",
  "opencode=skip",
];

function outputCapture() {
  let value = "";
  const stream = new Writable({
    write(chunk, _encoding, done) {
      value += chunk.toString();
      done();
    },
  });
  return { stream, text: () => value };
}

function makeOperation(state, steps) {
  return {
    id: "operation-1",
    kind: "install_host",
    state,
    steps,
    details: {},
  };
}

function makeStep(id, label, state, error = null) {
  return { id, label, state, error };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

async function startFakeServer(handler) {
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      let body = {};
      if (chunks.length > 0) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          response.writeHead(400).end();
          return;
        }
      }
      try {
        const result = await handler({
          method: request.method,
          path: request.url,
          body,
        });
        response.writeHead(result.status ?? 200, {
          "Content-Type": "application/json",
        });
        response.end(JSON.stringify(result.body ?? {}));
      } catch (error) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ message: error.message }));
      }
    });
  });

  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      }),
  };
}

const SERVER_IDENTITY = { user: "devchain", homePath: "/home/devchain" };

/** The VM address a test passes: the fake server's origin, over https as the CLI requires. */
function vmAddress(origin) {
  return origin.replace(/^http:/, "https:");
}

function nonInteractiveOptions(address, extra = {}) {
  return {
    address,
    sshUser: "ubuntu",
    providerAuth: providerSkips,
    ...extra,
  };
}

function fakeTtyInput() {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.isRaw = false;
  stream.setRawMode = jest.fn((mode) => {
    stream.isRaw = Boolean(mode);
  });
  return stream;
}

describe("devchain host install command", () => {
  it("shows the interactive and non-interactive options in command help", () => {
    const help = execFileSync(
      process.execPath,
      [CLI_PATH, "host", "install", "--help"],
      { encoding: "utf8" },
    );

    for (const option of [
      "--address",
      "--ssh-user",
      "--password-stdin",
      "--key",
      "--passphrase-stdin",
      "--sudo-password-stdin",
      "--projects",
      "--provider-auth",
      "--no-docker",
    ]) {
      expect(help).toContain(option);
    }
    expect(help).not.toContain("--linux-user");
    expect(help).not.toContain("--home-path");
    expect(help).not.toContain("--password <");
  });

  it("asks the user to start DevChain when no local API is running", async () => {
    const stdout = outputCapture();
    const stderr = outputCapture();
    const exitCode = await runHostInstallCommand(
      {},
      {
        getLocalApiBaseUrl: async () => null,
        stdout: stdout.stream,
        stderr: stderr.stream,
        stdin: Readable.from([]),
        isInteractive: false,
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("Start DevChain first (devchain start).");
  });

  it("exits before prompting when the real command has no running-app pid", async () => {
    const root = await mkdtemp(join(tmpdir(), "devchain-host-install-no-app-"));

    try {
      const child = spawn(process.execPath, [CLI_PATH, "host", "install"], {
        env: { ...process.env, HOME: root },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.stdin.end();
      const exitCode = await new Promise((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("close", resolveExit);
      });

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("Start DevChain first (devchain start).");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs the operation and prints step states without exposing the SSH password", async () => {
    const password = "not-in-argv-or-output";
    const installRequests = [];
    const server = await startFakeServer(async ({ method, path, body }) => {
      if (method === "GET" && path === "/api/provider-auth") {
        return { body: { items: [] } };
      }
      if (method === "GET" && path === "/api/remotes/host-install/identity") {
        return { body: SERVER_IDENTITY };
      }
      if (method === "POST" && path === "/api/remotes/host-install") {
        installRequests.push(body);
        return {
          status: 202,
          body: makeOperation("running", [
            makeStep("ssh_connect", "Connect to the VM over SSH", "running"),
            makeStep("check", "Check the VM", "pending"),
          ]),
        };
      }
      if (method === "GET" && path === "/api/remotes/operations/operation-1") {
        return {
          body: makeOperation("done", [
            makeStep("ssh_connect", "Connect to the VM over SSH", "done"),
            makeStep("check", "Check the VM", "done"),
          ]),
        };
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    });
    const stdout = outputCapture();
    const stderr = outputCapture();

    try {
      const exitCode = await runHostInstallCommand(
        nonInteractiveOptions(vmAddress(server.baseUrl), { passwordStdin: true }),
        {
          getLocalApiBaseUrl: async () => server.baseUrl,
          stdin: Readable.from([`${password}\n`]),
          stdout: stdout.stream,
          stderr: stderr.stream,
          isInteractive: false,
          sleep: async () => undefined,
        },
      );

      expect(exitCode).toBe(0);
      expect(installRequests).toHaveLength(1);
      expect(installRequests[0].ssh.password).toBe(password);
      expect(installRequests[0].minDiskGib).toBe(8);
      expect(installRequests[0].installDocker).toBe(true);
      // The VM always receives the running home server's identity; the CLI
      // prints it and sends no user or home fields.
      expect(installRequests[0].userName).toBeUndefined();
      expect(installRequests[0].homePath).toBeUndefined();
      expect(stdout.text()).toContain(
        "Claiming the VM as devchain with home /home/devchain (this PC's identity).",
      );
      expect(stdout.text()).toContain("Check the VM: done");
      expect(stdout.text()).toContain("Host installation complete.");
      expect(`${stdout.text()}${stderr.text()}`).not.toContain(password);
    } finally {
      await server.close();
    }
  });

  // The command-level fake HTTP flow verifies warning deduplication across polling responses.
  it("prints each check warning once across repeated operation polls", async () => {
    let polls = 0;
    const warning = "The VM has 1 vCPU. 2 or more are recommended for agent sessions.";
    const fetchImpl = jest.fn(async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === "/api/provider-auth") return jsonResponse({ items: [] });
      if (path === "/api/remotes/host-install/identity")
        return jsonResponse(SERVER_IDENTITY);
      if (path === "/api/remotes/host-install" && init.method === "POST") {
        return jsonResponse(makeOperation("running", [makeStep("check", "Check the VM", "running")]), 202);
      }
      if (path === "/api/remotes/operations/operation-1") {
        const operation = makeOperation(++polls >= 3 ? "done" : "running", [makeStep("check", "Check the VM", "done")]);
        operation.details.checkWarnings = [warning, "ufw is active."];
        return jsonResponse(operation);
      }
      throw new Error(`Unexpected request ${path}`);
    });
    const stdout = outputCapture();
    const exitCode = await runHostInstallCommand(
      nonInteractiveOptions("https://localhost:3000", { passwordStdin: true }),
      {
        fetch: fetchImpl,
        getLocalApiBaseUrl: async () => "http://localhost:3000",
        stdin: Readable.from(["password\n"]), stdout: stdout.stream,
        stderr: outputCapture().stream, isInteractive: false, sleep: async () => undefined,
      },
    );
    expect(exitCode).toBe(0);
    expect(polls).toBe(3);
    expect(stdout.text().split(`WARNING: ${warning}`)).toHaveLength(2);
    expect(stdout.text().split("WARNING: ufw is active.")).toHaveLength(2);
  });

  it("prints check refusal lines and exits with code 2", async () => {
    const server = await startFakeServer(async ({ method, path }) => {
      if (method === "GET" && path === "/api/provider-auth")
        return { body: { items: [] } };
      if (method === "GET" && path === "/api/remotes/host-install/identity")
        return { body: SERVER_IDENTITY };
      if (method === "POST" && path === "/api/remotes/host-install") {
        return {
          status: 202,
          body: makeOperation("running", [
            makeStep("check", "Check the VM", "running"),
          ]),
        };
      }
      if (method === "GET" && path === "/api/remotes/operations/operation-1") {
        return {
          body: makeOperation("failed", [
            makeStep("check", "Check the VM", "failed", {
              code: "HOST_INSTALL_CHECK_FAILED",
              message: "Not enough free memory.\nNo changes were made.",
            }),
          ]),
        };
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    });
    const stderr = outputCapture();

    try {
      const exitCode = await runHostInstallCommand(
        nonInteractiveOptions(vmAddress(server.baseUrl), { passwordStdin: true }),
        {
          getLocalApiBaseUrl: async () => server.baseUrl,
          stdin: Readable.from(["ssh-password\n"]),
          stdout: outputCapture().stream,
          stderr: stderr.stream,
          isInteractive: false,
          sleep: async () => undefined,
        },
      );

      expect(exitCode).toBe(2);
      expect(stderr.text()).toContain("Not enough free memory.");
      expect(stderr.text()).toContain("No changes were made.");
    } finally {
      await server.close();
    }
  });

  it("refuses a plain http VM address before contacting the app", async () => {
    const fetchImpl = jest.fn();
    const stderr = outputCapture();
    const exitCode = await runHostInstallCommand(
      nonInteractiveOptions("http://192.0.2.20:3000", { passwordStdin: true }),
      {
        fetch: fetchImpl,
        getLocalApiBaseUrl: async () => "http://127.0.0.1:1",
        stdin: Readable.from(["ssh-password\n"]),
        stdout: outputCapture().stream,
        stderr: stderr.stream,
        isInteractive: false,
        sleep: async () => undefined,
      },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr.text()).toContain("Enter the VM address as https://host:3000.");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("estimates only explicitly selected projects and sends the returned disk requirement", async () => {
    let estimateRequest;
    let installRequest;
    const server = await startFakeServer(async ({ method, path, body }) => {
      if (method === "GET" && path === "/api/provider-auth") {
        return { body: { items: [] } };
      }
      if (method === "GET" && path === "/api/remotes/host-install/identity") {
        return { body: SERVER_IDENTITY };
      }
      if (method === "POST" && path === "/api/remotes/host-install/estimate") {
        estimateRequest = body;
        return {
          body: {
            projects: [
              {
                id: "project-a",
                name: "Example",
                bytes: 5 * 1024 ** 3,
                approximate: false,
              },
            ],
            requiredDiskGib: 16,
          },
        };
      }
      if (method === "POST" && path === "/api/remotes/host-install") {
        installRequest = body;
        return {
          status: 202,
          body: makeOperation("done", [
            makeStep("check", "Check the VM", "done"),
          ]),
        };
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    });
    const stdout = outputCapture();

    try {
      const exitCode = await runHostInstallCommand(
        nonInteractiveOptions(vmAddress(server.baseUrl), {
          passwordStdin: true,
          projects: ["project-a", "project-b"],
        }),
        {
          getLocalApiBaseUrl: async () => server.baseUrl,
          stdin: Readable.from(["ssh-password\n"]),
          stdout: stdout.stream,
          stderr: outputCapture().stream,
          isInteractive: false,
          sleep: async () => undefined,
        },
      );

      expect(exitCode).toBe(0);
      expect(estimateRequest).toEqual({
        projectIds: ["project-a", "project-b"],
      });
      expect(installRequest.minDiskGib).toBe(16);
      expect(stdout.text()).toContain("Estimated minimum disk: 16 GiB.");
    } finally {
      await server.close();
    }
  });

  it("sends no Docker install with --no-docker", async () => {
    let installRequest;
    const server = await startFakeServer(async ({ method, path, body }) => {
      if (method === "GET" && path === "/api/provider-auth") {
        return { body: { items: [] } };
      }
      if (method === "GET" && path === "/api/remotes/host-install/identity") {
        return { body: SERVER_IDENTITY };
      }
      if (method === "POST" && path === "/api/remotes/host-install") {
        installRequest = body;
        return {
          status: 202,
          body: makeOperation("done", [
            makeStep("check", "Check the VM", "done"),
          ]),
        };
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    });

    try {
      const exitCode = await runHostInstallCommand(
        nonInteractiveOptions(vmAddress(server.baseUrl), {
          passwordStdin: true,
          docker: false,
        }),
        {
          getLocalApiBaseUrl: async () => server.baseUrl,
          stdin: Readable.from(["ssh-password\n"]),
          stdout: outputCapture().stream,
          stderr: outputCapture().stream,
          isInteractive: false,
          sleep: async () => undefined,
        },
      );

      expect(exitCode).toBe(0);
      expect(installRequest).not.toHaveProperty("installDocker");
    } finally {
      await server.close();
    }
  });

  it("reuses the only saved provider entry and prompts when a provider has several", async () => {
    const uniqueCodex = "11111111-1111-4111-8111-111111111111";
    const uniqueCopilot = "22222222-2222-4222-8222-222222222222";
    const claudeSecond = "33333333-3333-4333-8333-333333333333";
    let installRequest;
    const server = await startFakeServer(async ({ method, path, body }) => {
      if (method === "GET" && path === "/api/remotes/host-install/identity") {
        return { body: SERVER_IDENTITY };
      }
      if (method === "GET" && path === "/api/provider-auth") {
        return {
          body: {
            items: [
              {
                id: uniqueCodex,
                provider: "codex",
                kind: "family",
                label: "Work",
              },
              {
                id: uniqueCopilot,
                provider: "copilot",
                kind: "static",
                label: "Copilot",
              },
              {
                id: "44444444-4444-4444-8444-444444444444",
                provider: "claude",
                kind: "family",
                label: "Personal",
              },
              {
                id: claudeSecond,
                provider: "claude",
                kind: "family",
                label: "Work",
              },
            ],
          },
        };
      }
      if (method === "POST" && path === "/api/remotes/host-install") {
        installRequest = body;
        return {
          status: 202,
          body: makeOperation("done", [
            makeStep("check", "Check the VM", "done"),
          ]),
        };
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    });
    const linePrompts = [];

    try {
      const exitCode = await runHostInstallCommand(
        nonInteractiveOptions(vmAddress(server.baseUrl), {
          providerAuth: ["agy=skip", "opencode=skip"],
        }),
        {
          getLocalApiBaseUrl: async () => server.baseUrl,
          isInteractive: true,
          stdin: { isTTY: true },
          stdout: outputCapture().stream,
          stderr: outputCapture().stream,
          promptLine: async (question, defaultValue) => {
            linePrompts.push(question);
            return question.startsWith("Provider login for claude")
              ? "2"
              : defaultValue || "password";
          },
          promptSecret: async (question) =>
            question === "SSH password" ? "ssh-secret" : "",
          sleep: async () => undefined,
        },
      );

      expect(exitCode).toBe(0);
      expect(installRequest.providerAuth).toEqual({
        claude: `reuse:${claudeSecond}`,
        codex: `reuse:${uniqueCodex}`,
        copilot: `reuse:${uniqueCopilot}`,
      });
      const providerPrompts = linePrompts.filter((question) =>
        question.startsWith("Provider login for"),
      );
      expect(providerPrompts).toHaveLength(1);
      expect(providerPrompts[0]).toContain("1) Reuse Personal");
      expect(providerPrompts[0]).toContain("2) Reuse Work");
    } finally {
      await server.close();
    }
  });

  it("re-prompts for SSH credentials and retries when the app has restarted", async () => {
    let statusReads = 0;
    let retryBody;
    const server = await startFakeServer(async ({ method, path, body }) => {
      if (method === "GET" && path === "/api/provider-auth")
        return { body: { items: [] } };
      if (method === "GET" && path === "/api/remotes/host-install/identity")
        return { body: SERVER_IDENTITY };
      if (method === "POST" && path === "/api/remotes/host-install") {
        return { status: 202, body: makeOperation("running", []) };
      }
      if (method === "GET" && path === "/api/remotes/operations/operation-1") {
        statusReads += 1;
        if (statusReads === 1) {
          return {
            body: makeOperation("failed", [
              makeStep("ssh_connect", "Connect to the VM over SSH", "failed", {
                code: "SSH_CREDENTIALS_REQUIRED",
                message: "SSH credentials are required again.",
              }),
            ]),
          };
        }
        return {
          body: makeOperation("done", [
            makeStep("ssh_connect", "Connect to the VM over SSH", "done"),
          ]),
        };
      }
      if (
        method === "POST" &&
        path === "/api/remotes/operations/operation-1/retry"
      ) {
        retryBody = body;
        return { status: 202, body: makeOperation("running", []) };
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    });
    const passwordPrompts = [];
    const linePrompts = [];
    const stdout = outputCapture();
    const stderr = outputCapture();

    try {
      const exitCode = await runHostInstallCommand(
        nonInteractiveOptions(vmAddress(server.baseUrl)),
        {
          getLocalApiBaseUrl: async () => server.baseUrl,
          isInteractive: true,
          stdin: { isTTY: true },
          stdout: stdout.stream,
          stderr: stderr.stream,
          promptLine: async (question, defaultValue) => {
            linePrompts.push(question);
            return defaultValue || "password";
          },
          promptSecret: async (question) => {
            if (question === "SSH password") {
              const value = `ssh-password-${passwordPrompts.length + 1}`;
              passwordPrompts.push(value);
              return value;
            }
            return "";
          },
          sleep: async () => undefined,
        },
      );

      expect(exitCode).toBe(0);
      expect(passwordPrompts).toEqual(["ssh-password-1", "ssh-password-2"]);
      expect(
        linePrompts.filter((question) =>
          question.includes("SSH authentication method"),
        ),
      ).toHaveLength(2);
      expect(retryBody.ssh.password).toBe("ssh-password-2");
      expect(`${stdout.text()}${stderr.text()}`).not.toContain(
        "ssh-password-2",
      );
    } finally {
      await server.close();
    }
  });

  it("uses key, key-passphrase and sudo-password stdin flags without prompting", async () => {
    const root = await mkdtemp(join(tmpdir(), "devchain-host-install-key-"));
    const keyPath = join(root, "id_ed25519");
    await writeFile(keyPath, "PRIVATE KEY MATERIAL\n");
    const requests = [];
    const server = await startFakeServer(async ({ method, path, body }) => {
      if (method === "GET" && path === "/api/provider-auth")
        return { body: { items: [] } };
      if (method === "GET" && path === "/api/remotes/host-install/identity")
        return { body: SERVER_IDENTITY };
      if (method === "POST" && path === "/api/remotes/host-install") {
        requests.push(body);
        return {
          status: 202,
          body: makeOperation("done", [
            makeStep("ssh_connect", "Connect to the VM over SSH", "done"),
          ]),
        };
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    });
    const promptLine = jest.fn();
    const promptSecret = jest.fn();

    try {
      const exitCode = await runHostInstallCommand(
        nonInteractiveOptions(vmAddress(server.baseUrl), {
          key: keyPath,
          passphraseStdin: true,
          sudoPasswordStdin: true,
        }),
        {
          getLocalApiBaseUrl: async () => server.baseUrl,
          stdin: Readable.from(["key-passphrase\nsudo-password\n"]),
          stdout: outputCapture().stream,
          stderr: outputCapture().stream,
          isInteractive: false,
          promptLine,
          promptSecret,
          sleep: async () => undefined,
        },
      );

      expect(exitCode).toBe(0);
      expect(requests[0].ssh).toEqual({
        user: "ubuntu",
        privateKey: "PRIVATE KEY MATERIAL\n",
        passphrase: "key-passphrase",
        sudoPassword: "sudo-password",
      });
      expect(promptLine).not.toHaveBeenCalled();
      expect(promptSecret).not.toHaveBeenCalled();
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts stdin credentials through the real Commander flags without placing them in argv", async () => {
    const password = "stdin-only-cli-password";
    const root = await mkdtemp(join(tmpdir(), "devchain-host-install-cli-"));
    const devchainDir = join(root, ".devchain");
    await mkdir(devchainDir, { recursive: true });
    const requests = [];
    const server = await startFakeServer(async ({ method, path, body }) => {
      if (method === "GET" && path === "/api/provider-auth")
        return { body: { items: [] } };
      if (method === "GET" && path === "/api/remotes/host-install/identity")
        return { body: SERVER_IDENTITY };
      if (method === "POST" && path === "/api/remotes/host-install") {
        requests.push(body);
        return {
          status: 202,
          body: makeOperation("done", [
            makeStep("check", "Check the VM", "done"),
          ]),
        };
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    });

    try {
      await writeFile(
        join(devchainDir, "devchain.pid"),
        JSON.stringify({
          pid: process.pid,
          host: "127.0.0.1",
          port: new URL(server.baseUrl).port,
        }),
      );
      const args = [
        CLI_PATH,
        "host",
        "install",
        "--address",
        vmAddress(server.baseUrl),
        "--ssh-user",
        "ubuntu",
        "--password-stdin",
        ...providerSkips.flatMap((choice) => ["--provider-auth", choice]),
      ];
      const child = spawn(process.execPath, args, {
        env: { ...process.env, HOME: root },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.stdin.end(`${password}\n`);
      const exitCode = await new Promise((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("close", resolveExit);
      });

      expect(exitCode).toBe(0);
      expect(requests[0].ssh.password).toBe(password);
      expect(child.spawnargs).not.toContain(password);
      expect(`${stdout}${stderr}`).not.toContain(password);
      expect(stdout).toContain("Host installation complete.");
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows a project estimate to outlive the ordinary request budget", async () => {
    jest.useFakeTimers();
    const estimateDelayMs = REQUEST_TIMEOUT_MS + 1_000;
    const fetchImpl = jest.fn((url, { signal }) => {
      const { pathname } = new URL(url);
      if (pathname === "/api/provider-auth") {
        return Promise.resolve(jsonResponse({ items: [] }));
      }
      if (pathname === "/api/remotes/host-install/identity") {
        return Promise.resolve(jsonResponse(SERVER_IDENTITY));
      }
      if (pathname === "/api/remotes/host-install/estimate") {
        return new Promise((resolveResponse, rejectResponse) => {
          const delay = setTimeout(
            () =>
              resolveResponse(
                jsonResponse({ projects: [], requiredDiskGib: 8 }),
              ),
            estimateDelayMs,
          );
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(delay);
              rejectResponse(signal.reason);
            },
            { once: true },
          );
        });
      }
      if (pathname === "/api/remotes/host-install") {
        return Promise.resolve(
          jsonResponse(
            makeOperation("done", [makeStep("check", "Check the VM", "done")]),
            202,
          ),
        );
      }
      return Promise.reject(new Error(`Unexpected request ${pathname}`));
    });

    try {
      const command = runHostInstallCommand(
        nonInteractiveOptions("https://127.0.0.1:3000", {
          passwordStdin: true,
          projects: ["project-a"],
        }),
        {
          fetch: fetchImpl,
          getLocalApiBaseUrl: async () => "http://127.0.0.1:3000",
          stdin: Readable.from(["ssh-password\n"]),
          stdout: outputCapture().stream,
          stderr: outputCapture().stream,
          isInteractive: false,
        },
      );

      await jest.advanceTimersByTimeAsync(estimateDelayMs);

      await expect(command).resolves.toBe(0);
      expect(estimateDelayMs).toBeLessThan(ESTIMATE_REQUEST_TIMEOUT_MS);
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps the deadline active while reading a stalled response body", async () => {
    jest.useFakeTimers();
    const timeoutMs = 50;
    let signal;
    const request = requestJson(
      async (_url, init) => {
        signal = init.signal;
        return {
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolveBody, rejectBody) => {
              signal.addEventListener(
                "abort",
                () => rejectBody(signal.reason),
                {
                  once: true,
                },
              );
            }),
        };
      },
      "http://127.0.0.1:3000",
      "/api/remotes/host-install/estimate",
      { timeoutMs },
    );
    const rejection = expect(request).rejects.toThrow(
      "Could not reach the running DevChain app.",
    );

    try {
      await jest.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(signal.aborted).toBe(false);

      await jest.advanceTimersByTimeAsync(1);

      await rejection;
      expect(signal.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("retains the short ordinary deadline for operation status requests", async () => {
    jest.useFakeTimers();
    let signal;
    const request = requestJson(
      (_url, init) => {
        signal = init.signal;
        return new Promise((_resolveResponse, rejectResponse) => {
          signal.addEventListener(
            "abort",
            () => rejectResponse(signal.reason),
            { once: true },
          );
        });
      },
      "http://127.0.0.1:3000",
      "/api/remotes/operations/operation-1",
    );
    const rejection = expect(request).rejects.toThrow(
      "Could not reach the running DevChain app.",
    );

    try {
      await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
      expect(signal.aborted).toBe(false);

      await jest.advanceTimersByTimeAsync(1);

      await rejection;
      expect(signal.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("pauses stdin and restores raw mode when a secret prompt ends", async () => {
    const input = fakeTtyInput();
    const output = outputCapture();
    const secret = promptSecret("SSH password", {
      input,
      output: output.stream,
      allowEmpty: false,
    });

    input.write("ssh-secret\r");

    await expect(secret).resolves.toBe("ssh-secret");
    expect(input.isPaused()).toBe(true);
    expect(input.isRaw).toBe(false);
  });

  it("rejects Ctrl-C at a secret prompt with exit code 130 and pauses stdin", async () => {
    const input = fakeTtyInput();
    const output = outputCapture();
    const secret = promptSecret("SSH password", {
      input,
      output: output.stream,
      allowEmpty: false,
    });

    input.write("\u0003");

    await expect(secret).rejects.toMatchObject({ exitCode: 130 });
    expect(input.isPaused()).toBe(true);
    expect(input.isRaw).toBe(false);
  });

  it("pauses stdin after a line prompt is answered", async () => {
    const input = fakeTtyInput();
    const output = outputCapture();
    output.stream.isTTY = true;
    const prompt = promptLine("VM address", "", {
      input,
      output: output.stream,
    });

    input.write("192.168.1.20\r");

    await expect(prompt).resolves.toBe("192.168.1.20");
    expect(input.isPaused()).toBe(true);
  });

  it("rejects Ctrl-C at a line prompt with exit code 130 and pauses stdin", async () => {
    const input = fakeTtyInput();
    const output = outputCapture();
    output.stream.isTTY = true;
    const prompt = promptLine("VM address", "", {
      input,
      output: output.stream,
    });

    input.write("\u0003");

    await expect(prompt).rejects.toMatchObject({ exitCode: 130 });
    expect(input.isPaused()).toBe(true);
  });

  it("prints the operation id before the first step and waits out a home restart", async () => {
    let statusReads = 0;
    const sleeps = [];
    let now = 0;
    const installBodies = [];
    const fetchImpl = jest.fn(async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === "/api/provider-auth") return jsonResponse({ items: [] });
      if (path === "/api/remotes/host-install/identity")
        return jsonResponse(SERVER_IDENTITY);
      if (path === "/api/remotes/host-install" && init.method === "POST") {
        installBodies.push(JSON.parse(init.body));
        return jsonResponse(
          makeOperation("running", [makeStep("check", "Check the VM", "running")]),
          202,
        );
      }
      if (path === "/api/remotes/operations/operation-1") {
        statusReads += 1;
        if (statusReads <= 20) throw new Error("connect ECONNREFUSED");
        return jsonResponse(
          makeOperation("done", [makeStep("check", "Check the VM", "done")]),
        );
      }
      throw new Error(`Unexpected request ${path}`);
    });
    const stdout = outputCapture();
    const stderr = outputCapture();

    const exitCode = await runHostInstallCommand(
      nonInteractiveOptions("https://localhost:3000", { passwordStdin: true }),
      {
        fetch: fetchImpl,
        getLocalApiBaseUrl: async () => "http://localhost:3000",
        stdin: Readable.from(["ssh-password\n"]),
        stdout: stdout.stream,
        stderr: stderr.stream,
        isInteractive: false,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
          sleeps.push(ms);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(installBodies).toHaveLength(1);
    expect(statusReads).toBe(21);
    // One main-loop poll interval plus the twenty waits inside getOperation.
    expect(sleeps).toHaveLength(21);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(10_000);
    const text = stdout.text();
    expect(text).toContain("Host installation started (operation operation-1).");
    expect(text.indexOf("operation-1")).toBeLessThan(
      text.indexOf("Check the VM"),
    );
    expect(text).toContain("Host installation complete.");
    expect(stderr.text()).toContain(
      "DevChain is temporarily unavailable; waiting for it to come back.",
    );
    expect(`${text}${stderr.text()}`).not.toContain(
      "Could not reach the running DevChain app.",
    );
  });

  it("gives up after the 3-minute restart budget and points at the operation", async () => {
    const sleeps = [];
    let now = 0;
    const fetchImpl = jest.fn(async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === "/api/provider-auth") return jsonResponse({ items: [] });
      if (path === "/api/remotes/host-install/identity")
        return jsonResponse(SERVER_IDENTITY);
      if (path === "/api/remotes/host-install" && init.method === "POST") {
        return jsonResponse(
          makeOperation("running", [makeStep("check", "Check the VM", "running")]),
          202,
        );
      }
      throw new Error("connect ECONNREFUSED");
    });
    const stdout = outputCapture();
    const stderr = outputCapture();

    const exitCode = await runHostInstallCommand(
      nonInteractiveOptions("https://localhost:3000", { passwordStdin: true }),
      {
        fetch: fetchImpl,
        getLocalApiBaseUrl: async () => "http://localhost:3000",
        stdin: Readable.from(["ssh-password\n"]),
        stdout: stdout.stream,
        stderr: stderr.stream,
        isInteractive: false,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
          sleeps.push(ms);
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain(
      "DevChain did not come back within 3 minutes. Resume operation operation-1 from the Cloud page.",
    );
    expect(stdout.text()).toContain(
      "Host installation started (operation operation-1).",
    );
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(10_000);
    expect(sleeps.reduce((total, ms) => total + ms, 0)).toBe(181_000);
    expect(sleeps.at(-1)).toBe(5_000);
  });

  // Fake time and fetch exercise the command's deadline without a real outage.
  it.each([0, 12_000])(
    "bounds refused or slow failed requests (%i ms) to 3 minutes",
    async (failureDelay) => {
      jest.useFakeTimers();
      const statusStarts = [];
      const statusEnds = [];
      const stderr = outputCapture();
      const fetchImpl = jest.fn(async (url, { signal } = {}) => {
        const path = new URL(url).pathname;
        if (path === "/api/provider-auth") return jsonResponse({ items: [] });
      if (path === "/api/remotes/host-install/identity")
        return jsonResponse(SERVER_IDENTITY);
        if (path === "/api/remotes/host-install") {
          return jsonResponse(makeOperation("running", []), 202);
        }
        statusStarts.push(performance.now());
        return new Promise((_resolve, reject) => {
          const fail = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", fail);
            statusEnds.push(performance.now());
            reject(new Error("connect ECONNREFUSED"));
          };
          const timer = setTimeout(fail, failureDelay);
          signal.addEventListener("abort", fail, { once: true });
        });
      });

      try {
        let finished = false;
        const command = runHostInstallCommand(
          nonInteractiveOptions("https://localhost:3000"),
          {
            fetch: fetchImpl,
            getLocalApiBaseUrl: async () => "http://localhost:3000",
            stdin: fakeTtyInput(),
            isInteractive: true,
            promptLine: async (_question, defaultValue) => defaultValue,
            promptSecret: async () => "ssh-secret",
            stdout: outputCapture().stream,
            stderr: stderr.stream,
          },
        ).then((code) => {
          finished = true;
          return code;
        });

        await jest.advanceTimersByTimeAsync(180_999);
        expect(finished).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
        await expect(command).resolves.toBe(1);
        expect(statusStarts[0]).toBe(1_000);
        expect(performance.now() - statusStarts[0]).toBe(180_000);
        expect(statusStarts.every((start) => start < 181_000)).toBe(true);
        if (failureDelay) {
          expect(statusEnds.at(-1) - statusStarts.at(-1)).toBeLessThan(
            failureDelay,
          );
          expect(statusEnds.at(-1)).toBe(181_000);
        }
        expect(stderr.text()).toContain(
          "DevChain did not come back within 3 minutes. Resume operation operation-1 from the Cloud page.",
        );
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  // Command-level fakes capture retry bodies and prompt defaults across recovery paths.
  it("retains replacement SSH identity and sudo credentials across retries and a home restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "devchain-host-install-reauth-"));
    const keyPath = join(root, "replacement-key");
    const privateKey = "REPLACEMENT PRIVATE KEY";
    await writeFile(keyPath, privateKey);
    const retryBodies = [];
    const defaults = [];
    const stdout = outputCapture();
    const stderr = outputCapture();
    let now = 0;
    let restartAt;
    const failed = (code) =>
      makeOperation("failed", [
        makeStep("install", "Install", "failed", { code }),
      ]);
    const fetchImpl = jest.fn(async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === "/api/provider-auth") return jsonResponse({ items: [] });
      if (path === "/api/remotes/host-install/identity")
        return jsonResponse(SERVER_IDENTITY);
      if (path === "/api/remotes/host-install") {
        return jsonResponse(failed("SSH_CREDENTIALS_REQUIRED"), 202);
      }
      if (path.endsWith("/retry")) {
        retryBodies.push(JSON.parse(init.body));
        if (retryBodies.length === 1) {
          return jsonResponse(failed("SSH_SUDO_PASSWORD_REQUIRED"));
        }
        if (retryBodies.length === 2) {
          restartAt = now;
          return jsonResponse(makeOperation("running", []));
        }
        return jsonResponse(
          makeOperation("done", [
            makeStep(
              "install",
              `${privateKey} replacement-passphrase sudo-secret original-password`,
              "done",
            ),
          ]),
        );
      }
      if (now - restartAt < 60_000) throw new Error("connect ECONNREFUSED");
      return jsonResponse(failed("SSH_CREDENTIALS_REQUIRED"));
    });

    try {
      const exitCode = await runHostInstallCommand(
        nonInteractiveOptions("https://localhost:3000"),
        {
          fetch: fetchImpl,
          getLocalApiBaseUrl: async () => "http://localhost:3000",
          stdin: fakeTtyInput(),
          stdout: stdout.stream,
          stderr: stderr.stream,
          isInteractive: true,
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
          promptLine: async (question, defaultValue) => {
            defaults.push({ question, defaultValue });
            if (question === "SSH user")
              return retryBodies.length ? defaultValue : "replacement-user";
            if (question === "SSH authentication method (password or key)") {
              return defaults.filter((item) => item.question === question)
                .length === 1
                ? "password"
                : "key";
            }
            if (question === "SSH private key file")
              return retryBodies.length ? defaultValue : keyPath;
            return defaultValue;
          },
          promptSecret: async (question) => {
            if (question === "SSH password") return "original-password";
            if (question === "SSH key passphrase (optional)")
              return "replacement-passphrase";
            if (question === "Sudo password") return "sudo-secret";
            return "";
          },
        },
      );

      expect(exitCode).toBe(0);
      const replacement = {
        user: "replacement-user",
        privateKey,
        passphrase: "replacement-passphrase",
      };
      expect(retryBodies).toEqual([
        { ssh: replacement },
        { ssh: { ...replacement, sudoPassword: "sudo-secret" } },
        { ssh: { ...replacement, sudoPassword: "sudo-secret" } },
      ]);
      expect(
        defaults.filter((item) => item.question === "SSH user").at(-1)
          .defaultValue,
      ).toBe("replacement-user");
      expect(
        defaults
          .filter((item) => item.question === "SSH private key file")
          .at(-1).defaultValue,
      ).toBe(keyPath);
      expect(now - restartAt).toBeGreaterThanOrEqual(60_000);
      expect(stderr.text()).toContain("waiting for it to come back");
      const output = `${stdout.text()}${stderr.text()}`;
      for (const secret of [
        privateKey,
        "replacement-passphrase",
        "sudo-secret",
        "original-password",
      ]) {
        expect(output).not.toContain(secret);
      }
      expect(output).toContain("[redacted]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("expands ~ in --key against this PC's home and reads the key", async () => {
    const root = await mkdtemp(join(tmpdir(), "devchain-host-install-tilde-"));
    await mkdir(join(root, ".ssh"), { recursive: true });
    await writeFile(join(root, ".ssh", "id_ed25519"), "TILDE KEY MATERIAL\n");
    const installBodies = [];
    const fetchImpl = jest.fn(async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === "/api/provider-auth") return jsonResponse({ items: [] });
      if (path === "/api/remotes/host-install/identity")
        return jsonResponse(SERVER_IDENTITY);
      if (path === "/api/remotes/host-install" && init.method === "POST") {
        installBodies.push(JSON.parse(init.body));
        return jsonResponse(
          makeOperation("done", [makeStep("check", "Check the VM", "done")]),
          202,
        );
      }
      throw new Error(`Unexpected request ${path}`);
    });

    try {
      const exitCode = await runHostInstallCommand(
        nonInteractiveOptions("https://localhost:3000", {
          key: "~/.ssh/id_ed25519",
        }),
        {
          fetch: fetchImpl,
          getLocalApiBaseUrl: async () => "http://localhost:3000",
          stdin: Readable.from([]),
          stdout: outputCapture().stream,
          stderr: outputCapture().stream,
          isInteractive: false,
          homeDefaults: { user: "devchain", path: root },
          sleep: async () => undefined,
        },
      );

      expect(exitCode).toBe(0);
      expect(installBodies[0].ssh.privateKey).toBe("TILDE KEY MATERIAL\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("expands ~ entered at the SSH private key file prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "devchain-host-install-prompt-"));
    await mkdir(join(root, ".ssh"), { recursive: true });
    await writeFile(join(root, ".ssh", "id_ed25519"), "PROMPT KEY MATERIAL\n");
    const installBodies = [];
    const fetchImpl = jest.fn(async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === "/api/provider-auth") return jsonResponse({ items: [] });
      if (path === "/api/remotes/host-install/identity")
        return jsonResponse(SERVER_IDENTITY);
      if (path === "/api/remotes/host-install" && init.method === "POST") {
        installBodies.push(JSON.parse(init.body));
        return jsonResponse(
          makeOperation("done", [makeStep("check", "Check the VM", "done")]),
          202,
        );
      }
      throw new Error(`Unexpected request ${path}`);
    });

    try {
      const exitCode = await runHostInstallCommand(
        nonInteractiveOptions("https://localhost:3000"),
        {
          fetch: fetchImpl,
          getLocalApiBaseUrl: async () => "http://localhost:3000",
          stdin: { isTTY: true },
          stdout: outputCapture().stream,
          stderr: outputCapture().stream,
          isInteractive: true,
          homeDefaults: { user: "devchain", path: root },
          promptLine: async (question, defaultValue) =>
            question === "SSH authentication method (password or key)"
              ? "key"
              : question === "SSH private key file"
                ? "~/.ssh/id_ed25519"
                : (defaultValue ?? ""),
          promptSecret: async () => "",
          sleep: async () => undefined,
        },
      );

      expect(exitCode).toBe(0);
      expect(installBodies[0].ssh.privateKey).toBe("PROMPT KEY MATERIAL\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a missing key file with exit code 2 and the resolved path", async () => {
    const root = await mkdtemp(join(tmpdir(), "devchain-host-install-nokey-"));
    const fetchImpl = jest.fn();
    const stderr = outputCapture();

    try {
      const exitCode = await runHostInstallCommand(
        nonInteractiveOptions("https://localhost:3000", {
          key: "~/missing-key",
        }),
        {
          fetch: fetchImpl,
          getLocalApiBaseUrl: async () => "http://localhost:3000",
          stdin: Readable.from([]),
          stdout: outputCapture().stream,
          stderr: stderr.stream,
          isInteractive: false,
          homeDefaults: { user: "devchain", path: root },
          sleep: async () => undefined,
        },
      );

      expect(exitCode).toBe(2);
      expect(stderr.text()).toContain(
        `Cannot read the SSH private key file ${join(root, "missing-key")}.`,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prints the server's 400 account refusal and exits with code 2", async () => {
    const fetchImpl = jest.fn(async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === "/api/provider-auth") return jsonResponse({ items: [] });
      if (path === "/api/remotes/host-install/identity")
        return jsonResponse(SERVER_IDENTITY);
      if (path === "/api/remotes/host-install" && init.method === "POST") {
        return jsonResponse(
          {
            statusCode: 400,
            code: "validation_error",
            message: '"first.last" is not a valid user name.',
            details: { reason: "install_user_name_invalid", field: "userName" },
          },
          400,
        );
      }
      throw new Error(`Unexpected request ${path}`);
    });
    const stderr = outputCapture();

    const exitCode = await runHostInstallCommand(
      nonInteractiveOptions("https://localhost:3000", { passwordStdin: true }),
      {
        fetch: fetchImpl,
        getLocalApiBaseUrl: async () => "http://localhost:3000",
        stdin: Readable.from(["ssh-password\n"]),
        stdout: outputCapture().stream,
        stderr: stderr.stream,
        isInteractive: false,
        sleep: async () => undefined,
      },
    );

    expect(exitCode).toBe(2);
    expect(stderr.text()).toContain('"first.last" is not a valid user name.');
  });

  it("prompts for the sudo password and retries on SSH_SUDO_PASSWORD_REQUIRED", async () => {
    let statusReads = 0;
    let retryBody;
    const fetchImpl = jest.fn(async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === "/api/provider-auth") return jsonResponse({ items: [] });
      if (path === "/api/remotes/host-install/identity")
        return jsonResponse(SERVER_IDENTITY);
      if (path === "/api/remotes/host-install" && init.method === "POST") {
        return jsonResponse(
          makeOperation("running", [makeStep("check", "Check the VM", "running")]),
          202,
        );
      }
      if (path === "/api/remotes/operations/operation-1") {
        statusReads += 1;
        if (statusReads === 1) {
          return jsonResponse(
            makeOperation("failed", [
              makeStep("check", "Check the VM", "failed", {
                code: "SSH_SUDO_PASSWORD_REQUIRED",
                message:
                  "sudo on the VM needs a password for ubuntu. Enter the sudo password and retry.",
              }),
            ]),
          );
        }
        return jsonResponse(
          makeOperation("done", [makeStep("check", "Check the VM", "done")]),
        );
      }
      if (path === "/api/remotes/operations/operation-1/retry") {
        retryBody = JSON.parse(init.body);
        return jsonResponse(
          makeOperation("running", [makeStep("check", "Check the VM", "running")]),
          202,
        );
      }
      throw new Error(`Unexpected request ${path}`);
    });
    const secretPrompts = [];
    const stdout = outputCapture();
    const stderr = outputCapture();

    const exitCode = await runHostInstallCommand(
      nonInteractiveOptions("https://localhost:3000", { passwordStdin: true }),
      {
        fetch: fetchImpl,
        getLocalApiBaseUrl: async () => "http://localhost:3000",
        stdin: Readable.from(["ssh-password\n"]),
        stdout: stdout.stream,
        stderr: stderr.stream,
        isInteractive: true,
        promptLine: async (_question, defaultValue) => defaultValue ?? "",
        promptSecret: async (question) => {
          secretPrompts.push(question);
          return question === "Sudo password" ? "sudo-secret" : "";
        },
        sleep: async () => undefined,
      },
    );

    expect(exitCode).toBe(0);
    expect(secretPrompts).toContain("Sudo password");
    expect(retryBody.ssh).toEqual({
      user: "ubuntu",
      password: "ssh-password",
      sudoPassword: "sudo-secret",
    });
    expect(`${stdout.text()}${stderr.text()}`).not.toContain("sudo-secret");
  });

  it("exits with code 1 and the message on SSH_SUDO_PASSWORD_REQUIRED without a terminal", async () => {
    const retryRequests = [];
    const fetchImpl = jest.fn(async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === "/api/provider-auth") return jsonResponse({ items: [] });
      if (path === "/api/remotes/host-install/identity")
        return jsonResponse(SERVER_IDENTITY);
      if (path === "/api/remotes/host-install" && init.method === "POST") {
        return jsonResponse(
          makeOperation("running", [makeStep("check", "Check the VM", "running")]),
          202,
        );
      }
      if (path === "/api/remotes/operations/operation-1/retry") {
        retryRequests.push(init.body);
        return jsonResponse(makeOperation("running", []), 202);
      }
      return jsonResponse(
        makeOperation("failed", [
          makeStep("check", "Check the VM", "failed", {
            code: "SSH_SUDO_PASSWORD_REQUIRED",
            message: "The VM refused the sudo password for ubuntu.",
          }),
        ]),
      );
    });
    const stderr = outputCapture();

    const exitCode = await runHostInstallCommand(
      nonInteractiveOptions("https://localhost:3000", { passwordStdin: true }),
      {
        fetch: fetchImpl,
        getLocalApiBaseUrl: async () => "http://localhost:3000",
        stdin: Readable.from(["ssh-password\n"]),
        stdout: outputCapture().stream,
        stderr: stderr.stream,
        isInteractive: false,
        sleep: async () => undefined,
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain(
      "The VM refused the sudo password for ubuntu.",
    );
    expect(retryRequests).toHaveLength(0);
  });
});
