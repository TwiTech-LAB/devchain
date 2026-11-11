const { spawn } = require("node:child_process");
const { signalCode } = require("./exclusive-run");
const {
  LocalApiHttpError,
  getLocalApiBaseUrl,
  requestJson,
} = require("./local-api");

const RESOLVE_PATH = "/api/vault/sessions/resolve";
const ENTRY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOCS = "docs/vault.md, section Resolve route";
/** Like `env` and `docker run`: 125 is a failure of this command, not of the child. */
const EXIT_VAULT_ERROR = 125;

class VaultExecError extends Error {}
/** The app did not answer at all — another candidate URL may still reach it. */
class VaultUnreachableError extends VaultExecError {}

const FORWARDED_SIGNALS = ["SIGTERM", "SIGHUP"];

/**
 * Spawns the command in the caller's own process group — NOT detached like the
 * queue's runner. An agent shell tool that cancels a call by killing its process
 * group (Codex sends SIGKILL) must take the wrapped command down with the CLI,
 * never leave it orphaned with the secrets in its environment; staying in the
 * group also keeps the caller's controlling tty, so /dev/tty prompts work.
 * Caught signals are forwarded with child.kill(); the first one sets the exit
 * code (128 + signal number), as the queue runner reports it.
 */
function runInCallerGroup({ command, args, env, stderr }) {
  return new Promise((done) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    let received = null;
    // SIGINT is recorded but never forwarded: the tty delivers it to the whole
    // foreground group, so the child already has it, and a forwarded copy would
    // arrive as a second interrupt — tools such as terraform force-abort on that.
    // The handler still keeps the CLI alive to wait for the child and exit 130.
    const handlers = [...FORWARDED_SIGNALS, "SIGINT"].map((signal) => {
      const handler = () => {
        received = received || signal;
        if (signal !== "SIGINT") child.kill(signal);
      };
      process.on(signal, handler);
      return [signal, handler];
    });
    const finish = (code) => {
      for (const [signal, handler] of handlers)
        process.removeListener(signal, handler);
      done(code);
    };
    child.once("error", (error) => {
      stderr.write(
        `devchain vault exec cannot start "${command}": ${error.message}\n`,
      );
      finish(error.code === "ENOENT" ? 127 : 126);
    });
    child.once("exit", (code, signal) => {
      const ended = received ?? signal;
      finish(ended ? signalCode(ended) : (code ?? 0));
    });
  });
}

function parseOnly(value) {
  const names = [...new Set(value.split(",").map((name) => name.trim()))];
  const invalid = names.find((name) => !ENTRY_NAME.test(name));
  if (invalid !== undefined) {
    throw new VaultExecError(
      `--only needs entry names separated by commas, such as API_TOKEN,DB_URL. "${invalid}" is not a valid entry name.`,
    );
  }
  return names;
}

/** The pid file's app; read lazily, because the common case never needs it. */
function pidFileUrl(processDeps) {
  return getLocalApiBaseUrl(processDeps).catch(() => null);
}

function refusalMessage(code, apiUrl, names) {
  switch (code) {
    case "VAULT_LOCKED":
      return "The Vault is locked, or this VM does not have the values from home yet. Ask the user to unlock the Vault in DevChain, then run the command again.";
    case "VAULT_NOT_ENABLED":
      return "The Vault is off for this project. Ask the user to turn it on in the Vault page of DevChain.";
    case "VAULT_ACCESS_DENIED":
      return "Agents of this role have no Vault access in this project. Ask the user to add the role in the Vault page of DevChain.";
    case "VAULT_ENTRY_NOT_GRANTED":
      if (names.length === 0)
        return "A requested Vault entry is not granted to this session. Ask the user to grant it in the Vault page of DevChain.";
      return names.length === 1
        ? `No Vault entry named ${names[0]} is granted to this session. Ask the user to grant it in the Vault page of DevChain.`
        : `These Vault entries are not granted to this session: ${names.join(", ")}. Ask the user to grant them in the Vault page of DevChain.`;
    case "VAULT_USE_APPROVAL_PENDING":
      return `The user must approve access to ${listOrDefault(names, "a requested entry")}. Ask the user, then run the command again.`;
    case "VAULT_USE_DENIED":
      return `The user denied this session access to ${listOrDefault(names, "a requested entry")}. Do not run the command again for it. Ask the user if you still need it.`;
    case "VAULT_PEER_REFUSED":
      return `The DevChain app at ${apiUrl} refused this connection because it does not come from the app's own machine. Run the command on the machine of the DevChain app. See ${DOCS}.`;
    case "VAULT_SESSION_ID_INVALID":
      return "DEVCHAIN_SESSION_ID is not a full session id. Do not change the value that DevChain sets for the agent session.";
    case "VAULT_SESSION_NOT_ACTIVE":
      return "DEVCHAIN_SESSION_ID does not name a running DevChain agent session. Run this command inside a running agent session.";
    case "VAULT_AGENT_SESSION_REQUIRED":
      return "This session has no agent. Only agent sessions can use Vault entries.";
    default:
      return null;
  }
}

function listOrDefault(names, fallback) {
  return names.length > 0 ? names.join(", ") : fallback;
}

function unreachableMessage(apiUrl) {
  return `Cannot reach the DevChain app at ${apiUrl}. Make sure DevChain runs. In Codex, the default sandbox has no network: launch Codex with --dangerously-bypass-approvals-and-sandbox.`;
}

function isStringMap(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function isEntryName(name) {
  return typeof name === "string" && ENTRY_NAME.test(name);
}

function isNameList(value) {
  return Array.isArray(value) && value.every(isEntryName);
}

async function resolve(fetchImpl, apiUrl, sessionId, names) {
  const result = await requestJson(fetchImpl, apiUrl, RESOLVE_PATH, {
    method: "POST",
    body: { sessionId, ...(names && { names }) },
  });
  if (
    !isStringMap(result?.env) ||
    !isStringMap(result?.files) ||
    !(result.needsApproval === undefined || isNameList(result.needsApproval))
  ) {
    throw new VaultExecError(
      `The DevChain app at ${apiUrl} sent an answer this CLI cannot read. Use the CLI of the same DevChain version.`,
    );
  }
  return result;
}

function refusalCode(error) {
  return error.details?.code ?? error.code;
}

/** Entry names a refusal names in `details.names`; anything else is dropped. */
function refusalNames(error) {
  const names = error.details?.names;
  return Array.isArray(names) ? names.filter(isEntryName) : [];
}

async function fetchValues(fetchImpl, apiUrl, sessionId, names) {
  try {
    return await resolve(fetchImpl, apiUrl, sessionId, names);
  } catch (error) {
    if (error instanceof VaultExecError) throw error;
    if (!(error instanceof LocalApiHttpError))
      throw new VaultUnreachableError(unreachableMessage(apiUrl));
    throw new VaultExecError(
      refusalMessage(refusalCode(error), apiUrl, refusalNames(error)) ??
        `The DevChain app refused the request (HTTP ${error.status}): ${error.message}`,
    );
  }
}

/**
 * Runs `command` with the session's granted Vault entries in its environment only.
 * Never writes a value: the shell tool of an agent keeps everything printed here.
 */
async function runVaultExec({
  command,
  args = [],
  only,
  env = process.env,
  fetchImpl = fetch,
  processDeps,
  stderr = process.stderr,
  run = runInCallerGroup,
}) {
  let childEnv;
  try {
    const sessionId = env.DEVCHAIN_SESSION_ID?.trim();
    if (!sessionId) {
      throw new VaultExecError(
        "DEVCHAIN_SESSION_ID is not set. Run devchain vault exec inside a DevChain agent session.",
      );
    }
    const names = only === undefined ? undefined : parseOnly(only);
    // DEVCHAIN_API_URL names the app that launched this session and is tried first.
    // The pid file's app is the fallback: after a DevChain restart on another port, a
    // surviving tmux session still carries the old URL.
    const fromEnv = env.DEVCHAIN_API_URL?.trim();
    let values;
    if (fromEnv) {
      try {
        values = await fetchValues(fetchImpl, fromEnv, sessionId, names);
      } catch (error) {
        if (!(error instanceof VaultUnreachableError)) throw error;
        const fallback = await pidFileUrl(processDeps);
        if (!fallback || fallback === fromEnv) throw error;
        values = await fetchValues(fetchImpl, fallback, sessionId, names);
      }
    } else {
      const url = await pidFileUrl(processDeps);
      if (!url) {
        throw new VaultExecError(
          "Cannot find the DevChain app: DEVCHAIN_API_URL is not set and no DevChain app runs for this user. Run this command inside a DevChain agent session.",
        );
      }
      values = await fetchValues(fetchImpl, url, sessionId, names);
    }
    for (const name of values.needsApproval ?? []) {
      stderr.write(
        `devchain vault exec: ${name} needs approval: run with --only ${name} to ask.\n`,
      );
    }
    // Vault values win over inherited values with the same name.
    childEnv = { ...env, ...values.env, ...values.files };
  } catch (error) {
    if (!(error instanceof VaultExecError)) throw error;
    stderr.write(`devchain vault exec: ${error.message}\n`);
    return EXIT_VAULT_ERROR;
  }
  return run({ command, args, env: childEnv, stderr });
}

module.exports = { EXIT_VAULT_ERROR, runVaultExec };
