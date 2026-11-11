const { spawn } = require("node:child_process");
const { createServer } = require("node:http");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const SECRET = "canary-vault-exec-7f3a";
const SESSION = "6f1c2a9e-3b7d-4e21-9a0c-5d8e7f6a1b2c";

// A CLI subprocess against a real loopback server: Commander parsing, the HTTP call,
// the child's env, exit status and signals meet only there.
describe("devchain vault exec CLI", () => {
  const cli = join(__dirname, "..", "cli.js");
  let server;
  let apiUrl;
  let requests;
  let respond;
  let home;

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        requests.push({
          method: request.method,
          url: request.url,
          body: parsed,
        });
        const [status, payload] = respond(parsed);
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      });
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    apiUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((done) => server.close(done)));

  beforeEach(() => {
    requests = [];
    respond = () => [
      200,
      { env: { API_TOKEN: SECRET }, files: { KEY_FILE: "/run/key" } },
    ];
    home = mkdtempSync(join(tmpdir(), "devchain-vault-exec-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function start(args, env = {}) {
    const child = spawn(process.execPath, [cli, ...args], {
      env: {
        ...process.env,
        HOME: home,
        DEVCHAIN_SESSION_ID: SESSION,
        DEVCHAIN_API_URL: apiUrl,
        ...env,
      },
    });
    const result = { stdout: "", stderr: "", child };
    child.stdout.on("data", (chunk) => (result.stdout += chunk));
    child.stderr.on("data", (chunk) => (result.stderr += chunk));
    result.done = new Promise((done) =>
      child.on("close", (status) => done({ ...result, status })),
    );
    return result;
  }
  const run = (args, env) => start(args, env).done;
  const refuse = (status, code) => () => [
    status,
    {
      statusCode: status,
      code: "forbidden",
      message: "Refused.",
      details: { code },
    },
  ];

  it("gives the values to the child only, over inherited values, and never prints them", async () => {
    const result = await run(
      [
        "vault",
        "exec",
        "--",
        "sh",
        "-c",
        'printf "%s" "$API_TOKEN" | wc -c; echo "$KEY_FILE"',
      ],
      { API_TOKEN: "inherited" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.split("\n").map((line) => line.trim())).toEqual([
      String(SECRET.length),
      "/run/key",
      "",
    ]);
    expect(result.stderr).toBe("");
    expect(requests).toEqual([
      {
        method: "POST",
        url: "/api/vault/sessions/resolve",
        body: { sessionId: SESSION },
      },
    ]);
  });

  it("asks only for the --only names", async () => {
    const result = await run([
      "vault",
      "exec",
      "--only",
      "API_TOKEN, KEY_FILE,API_TOKEN",
      "--",
      "true",
    ]);

    expect(result.status).toBe(0);
    expect(requests[0].body).toEqual({
      sessionId: SESSION,
      names: ["API_TOKEN", "KEY_FILE"],
    });
  });

  it.each([
    [
      403,
      "VAULT_ENTRY_NOT_GRANTED",
      "These Vault entries are not granted to this session: MISSING_KEY, OTHER. Ask the user to grant them in the Vault page of DevChain.",
    ],
    [
      409,
      "VAULT_USE_APPROVAL_PENDING",
      "The user must approve access to MISSING_KEY, OTHER. Ask the user, then run the command again.",
    ],
    [
      403,
      "VAULT_USE_DENIED",
      "The user denied this session access to MISSING_KEY, OTHER. Do not run the command again for it. Ask the user if you still need it.",
    ],
  ])(
    "prints the names of a %s %s refusal from its details, with one call, and runs nothing",
    async (status, code, message) => {
      respond = () => [
        status,
        {
          statusCode: status,
          code: "refused",
          message: "Refused.",
          details: { code, names: ["MISSING_KEY", "OTHER"] },
        },
      ];

      const result = await run([
        "vault",
        "exec",
        "--only",
        "API_TOKEN,MISSING_KEY,OTHER",
        "--",
        "sh",
        "-c",
        "echo ran",
      ]);

      expect(result.status).toBe(125);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(`devchain vault exec: ${message}\n`);
      // One resolve only: a per-name probe would spend one-shot approvals and write files.
      expect(requests).toHaveLength(1);
    },
  );

  it("runs the command and names the entries a call without --only left out for approval", async () => {
    respond = () => [
      200,
      { env: { API_TOKEN: SECRET }, files: {}, needsApproval: ["DEPLOY_KEY"] },
    ];

    const result = await run(["vault", "exec", "--", "sh", "-c", "echo ran"]);

    expect([result.status, result.stdout]).toEqual([0, "ran\n"]);
    expect(result.stderr).toBe(
      "devchain vault exec: DEPLOY_KEY needs approval: run with --only DEPLOY_KEY to ask.\n",
    );
  });

  it("refuses an --only value that is not an entry name", async () => {
    const result = await run([
      "vault",
      "exec",
      "--only",
      "API_TOKEN,bad-name",
      "--",
      "true",
    ]);

    expect(result.status).toBe(125);
    expect(result.stderr).toContain('"bad-name" is not a valid entry name');
    expect(requests).toEqual([]);
  });

  it.each([
    ["exit code", "exit 7", 7],
    ["signal as 128 + its number", "kill -TERM $$", 143],
  ])("passes the child's %s through", async (_label, script, status) => {
    expect(
      (await run(["vault", "exec", "--", "sh", "-c", script])).status,
    ).toBe(status);
  });

  it("forwards SIGTERM to the child", async () => {
    const running = start([
      "vault",
      "exec",
      "--",
      "sh",
      "-c",
      'trap "echo got-term; exit 3" TERM; echo ready; while :; do sleep 0.1; done',
    ]);
    await new Promise((ready) => {
      const check = () =>
        running.stdout.includes("ready") ? ready() : setTimeout(check, 20);
      check();
    });
    running.child.kill("SIGTERM");

    const result = await running.done;
    expect(result.stdout).toContain("got-term");
    expect(result.status).toBe(143);
  });

  it("dies with the wrapped command when the caller's process group is killed", async () => {
    // An agent shell tool cancels a call by SIGKILLing its process group (Codex
    // does). The wrapped command must be in that group, not detached: it must
    // not survive as an orphan with the secrets in its environment.
    const child = spawn(
      process.execPath,
      [
        cli,
        "vault",
        "exec",
        "--",
        "sh",
        "-c",
        "echo pid=$$; while :; do sleep 0.1; done",
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          DEVCHAIN_SESSION_ID: SESSION,
          DEVCHAIN_API_URL: apiUrl,
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    const shPid = await new Promise((found) => {
      const check = () => {
        const match = stdout.match(/pid=(\d+)/);
        return match ? found(Number(match[1])) : setTimeout(check, 20);
      };
      check();
    });

    process.kill(-child.pid, "SIGKILL");

    const deadline = Date.now() + 5000;
    const gone = await new Promise((done) => {
      const check = () => {
        try {
          process.kill(shPid, 0);
        } catch (error) {
          return done(error.code === "ESRCH");
        }
        return Date.now() > deadline ? done(false) : setTimeout(check, 20);
      };
      check();
    });
    expect(gone).toBe(true);
  });

  it("requires a command after the separator", async () => {
    for (const args of [
      ["vault", "exec"],
      ["vault", "exec", "--"],
      ["vault", "exec", "ls", "--", "x"],
    ]) {
      const result = await run(args);
      expect([args, result.status]).toEqual([args, 1]);
      expect(result.stderr).toContain("usage: devchain vault exec");
    }
    expect(requests).toEqual([]);
  });

  it.each([
    [
      "VAULT_LOCKED",
      409,
      "The Vault is locked, or this VM does not have the values from home yet.",
    ],
    ["VAULT_NOT_ENABLED", 403, "The Vault is off for this project."],
    [
      "VAULT_ACCESS_DENIED",
      403,
      "Agents of this role have no Vault access in this project.",
    ],
    [
      "VAULT_ENTRY_NOT_GRANTED",
      403,
      "A requested Vault entry is not granted to this session.",
    ],
    [
      "VAULT_PEER_REFUSED",
      403,
      "does not come from the app's own machine. Run the command on the machine of the DevChain app. See docs/vault.md, section Resolve route.",
    ],
    [
      "VAULT_SESSION_ID_INVALID",
      400,
      "DEVCHAIN_SESSION_ID is not a full session id.",
    ],
    [
      "VAULT_SESSION_NOT_ACTIVE",
      403,
      "DEVCHAIN_SESSION_ID does not name a running DevChain agent session.",
    ],
    ["VAULT_AGENT_SESSION_REQUIRED", 403, "This session has no agent."],
  ])("explains the refusal %s", async (code, status, message) => {
    respond = refuse(status, code);

    const result = await run([
      "vault",
      "exec",
      "--only",
      "API_TOKEN",
      "--",
      "sh",
      "-c",
      "echo ran",
    ]);

    expect(result.status).toBe(125);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
    expect(result.stderr.startsWith("devchain vault exec: ")).toBe(true);
  });

  it("does not forward SIGINT, so a group interrupt reaches the child once", async () => {
    // The tty delivers Ctrl-C to the whole foreground group; a forwarded copy would
    // be a second interrupt, which tools like terraform treat as "abort now".
    const script = [
      "count=0",
      "trap 'count=$((count+1))' INT",
      "echo ready",
      'while [ "$count" -eq 0 ]; do sleep 0.05; done',
      "sleep 0.5",
      'echo "ints=$count"',
      "exit 9",
    ].join("\n");
    const child = spawn(
      process.execPath,
      [cli, "vault", "exec", "--", "sh", "-c", script],
      {
        env: {
          ...process.env,
          HOME: home,
          DEVCHAIN_SESSION_ID: SESSION,
          DEVCHAIN_API_URL: apiUrl,
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    const done = new Promise((resolve) =>
      child.on("close", (status) => resolve(status)),
    );
    await new Promise((ready) => {
      const check = () =>
        stdout.includes("ready") ? ready() : setTimeout(check, 20);
      check();
    });

    process.kill(-child.pid, "SIGINT");

    const status = await done;
    expect(stdout).toContain("ints=1");
    // The CLI recorded the interrupt and reports it, not the child's own exit code.
    expect(status).toBe(130);
  });

  it("falls back to the pid file's app when the DEVCHAIN_API_URL app is gone", async () => {
    // DevChain restarted on another port while the tmux session survived: the env
    // URL is dead, and the pid file names the app that runs now.
    mkdirSync(join(home, ".devchain"), { recursive: true });
    writeFileSync(
      join(home, ".devchain", "devchain.pid"),
      JSON.stringify({
        pid: process.pid,
        port: server.address().port,
        host: "127.0.0.1",
        timestamp: Date.now(),
      }),
    );

    const result = await run(
      ["vault", "exec", "--", "sh", "-c", 'printf %s "$API_TOKEN"'],
      {
        DEVCHAIN_API_URL: "http://127.0.0.1:9",
      },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(SECRET);
  });

  it.each([
    [
      "no session id",
      { DEVCHAIN_SESSION_ID: "" },
      "DEVCHAIN_SESSION_ID is not set. Run devchain vault exec inside a DevChain agent session.",
    ],
    [
      "an unreachable app",
      { DEVCHAIN_API_URL: "http://127.0.0.1:9" },
      "Cannot reach the DevChain app at http://127.0.0.1:9. Make sure DevChain runs. In Codex, the default sandbox has no network: launch Codex with --dangerously-bypass-approvals-and-sandbox.",
    ],
    [
      "no app URL and no running app",
      { DEVCHAIN_API_URL: "" },
      "Cannot find the DevChain app: DEVCHAIN_API_URL is not set and no DevChain app runs for this user.",
    ],
  ])("explains %s", async (_label, env, message) => {
    const result = await run(
      ["vault", "exec", "--", "sh", "-c", "echo ran"],
      env,
    );

    expect(result.status).toBe(125);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
  });
});
