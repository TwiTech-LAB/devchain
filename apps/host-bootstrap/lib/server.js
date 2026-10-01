"use strict";

const https = require("node:https");
const { randomUUID } = require("node:crypto");
const { BootstrapError, validateClaim } = require("./validate");
const { performClaim, readClaim, readManifest } = require("./claim");
const { createSystem } = require("./system");
const { loadTls } = require("./tls");

const MAX_BODY_BYTES = 1024 * 1024;
const HANDOVER_TIMEOUT_MS = 5 * 60_000;
const HANDOVER_POLL_MS = 1_000;

/** JSON log lines for journald. Request bodies carry credentials and are never logged. */
function log(level, msg, extra) {
  process.stdout.write(
    `${JSON.stringify({ level, msg, time: new Date().toISOString(), ...extra })}\n`,
  );
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendError(res, error) {
  const status = error instanceof BootstrapError ? error.status : 500;
  const code = error instanceof BootstrapError ? error.code : "INTERNAL_ERROR";
  send(res, status, {
    statusCode: status,
    code,
    message: error.message,
    ...(error.step ? { details: { step: error.step } } : {}),
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(
          new BootstrapError(
            413,
            "BODY_TOO_LARGE",
            "The claim body is too large.",
          ),
        );
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(
          new BootstrapError(
            400,
            "INVALID_JSON",
            "The claim body is not valid JSON.",
          ),
        );
      }
    });
    req.on("error", reject);
  });
}

/** Resolves once DevChain on `port` answers /api/runtime with `version`. */
async function waitForDevChain(port, version, sys, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Plaintext stays on loopback: DevChain refuses it from any other peer.
      const response = await sys.fetch(`http://127.0.0.1:${port}/api/runtime`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok && (await response.json()).version === version)
        return true;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, HANDOVER_POLL_MS));
  }
  return false;
}

/**
 * The unclaimed VM's only service, HTTPS only with the VM's certificate:
 * `GET /api/runtime` and one `POST /api/host/claim`. Throws when the
 * certificate is missing. After a claim it frees the port, starts
 * `devchain-host.service` (which conflicts with this one, so systemd stops
 * this service meanwhile) and answers the claim once DevChain is up there.
 */
function createBootstrap({
  sys = createSystem(),
  claimFn = performClaim,
  handoverTimeoutMs = HANDOVER_TIMEOUT_MS,
  onDone,
} = {}) {
  const { key, cert } = loadTls(sys);
  const bootId = randomUUID();
  let state = "unclaimed";
  let imageVersion = null;
  try {
    imageVersion = readManifest(sys).imageVersion ?? null;
  } catch (error) {
    log("warn", "Image manifest unreadable", { error: error.message });
  }

  const server = https.createServer({ key, cert }, (req, res) => {
    const url = new URL(req.url, "http://bootstrap");
    if (req.method === "GET" && url.pathname === "/api/runtime") {
      // `version: null` keeps home's version gate closed until DevChain answers.
      send(res, 200, { state, version: null, imageVersion, bootId });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/host/claim") {
      handleClaim(req, res).catch((error) => sendError(res, error));
      return;
    }
    send(res, 404, {
      statusCode: 404,
      code: "NOT_FOUND",
      message: "Not found.",
    });
  });

  async function handleClaim(req, res) {
    if (state !== "unclaimed" || readClaim(sys)) {
      throw new BootstrapError(
        409,
        "ALREADY_CLAIMED",
        "This VM is already claimed or a claim is running.",
      );
    }
    const claim = validateClaim(await readJson(req));
    if (state !== "unclaimed") {
      throw new BootstrapError(
        409,
        "ALREADY_CLAIMED",
        "A claim is already running.",
      );
    }
    state = "claiming";
    log("info", "claim started", {
      userName: claim.userName,
      homePath: claim.homePath,
      version: claim.version,
    });
    let record;
    try {
      record = await claimFn(claim, sys, log);
    } catch (error) {
      state = "unclaimed";
      log("error", "claim failed", {
        code: error.code,
        step: error.step,
        error: error.message,
      });
      throw error;
    }

    state = "handover";
    // Stop listening first so DevChain can bind the port; this response's
    // connection stays open until it is answered.
    server.close();
    try {
      await sys.run("systemctl", [
        "start",
        "--no-block",
        "devchain-host.service",
      ]);
      const up = await waitForDevChain(
        claim.port,
        claim.version,
        sys,
        handoverTimeoutMs,
      );
      if (up) {
        log("info", "claim completed", {
          version: claim.version,
          port: claim.port,
        });
        send(res, 200, { claimed: true, ...record });
      } else {
        log("error", "DevChain did not start in time", { port: claim.port });
        send(res, 504, {
          statusCode: 504,
          code: "HOST_START_TIMEOUT",
          message: `The claim is recorded but DevChain did not answer on port ${claim.port}; see journalctl -u devchain-host.`,
        });
      }
    } finally {
      let finished = false;
      const finish = () => {
        if (!finished) onDone?.();
        finished = true;
      };
      if (res.writableFinished) finish();
      else res.once("finish", finish);
    }
  }

  return {
    server,
    get state() {
      return state;
    },
  };
}

function main() {
  const port = Number(process.env.DEVCHAIN_BOOTSTRAP_PORT ?? 3000);
  const sys = createSystem();
  if (readClaim(sys)) {
    log("info", "VM already claimed; bootstrap not needed");
    return;
  }
  let bootstrap;
  try {
    bootstrap = createBootstrap({ sys, onDone: () => process.exit(0) });
  } catch (error) {
    log("error", "bootstrap cannot start", { error: error.message });
    process.exitCode = 1;
    return;
  }
  // systemd stops this service when devchain-host.service starts; during the
  // handover the pending claim answer must still go out.
  process.on("SIGTERM", () => {
    if (bootstrap.state === "handover") {
      log(
        "info",
        "SIGTERM during handover; exiting once the claim is answered",
      );
      return;
    }
    process.exit(0);
  });
  bootstrap.server.listen(port, "0.0.0.0", () =>
    log("info", "bootstrap listening", { port, protocol: "https" }),
  );
}

module.exports = { createBootstrap, main };
