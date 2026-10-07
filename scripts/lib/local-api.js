const POLL_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 15_000;
const RESTART_WAIT_BUDGET_MS = 3 * 60_000;
const RESTART_DELAY_CAP_MS = 10_000;

class LocalApiHttpError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = "LocalApiHttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function writeLine(stream, message, secrets = []) {
  stream.write(`${redact(message, secrets)}\n`);
}

function redact(message, secrets) {
  let safe = String(message);
  const candidates = new Set();
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length === 0) continue;
    candidates.add(secret);
    for (const line of secret.split(/\r?\n/)) {
      if (line) candidates.add(line);
    }
  }
  for (const secret of [...candidates].sort((a, b) => b.length - a.length)) {
    safe = safe.split(secret).join("[redacted]");
  }
  return safe;
}

async function requestJson(
  fetchImpl,
  baseUrl,
  path,
  { method = "GET", body, timeoutMs = REQUEST_TIMEOUT_MS } = {},
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(
      new URL(path, `${baseUrl.replace(/\/+$/, "")}/`),
      {
        method,
        headers:
          body === undefined
            ? { Accept: "application/json" }
            : {
                Accept: "application/json",
                "Content-Type": "application/json",
              },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      },
    );
  } catch {
    clearTimeout(timeout);
    throw new Error("Could not reach the running DevChain app.");
  }

  try {
    let result;
    try {
      result = await response.json();
    } catch {
      if (controller.signal.aborted) {
        throw new Error("Could not reach the running DevChain app.");
      }
      result = null;
    }
    if (!response.ok) {
      const message =
        typeof result?.message === "string"
          ? result.message
          : `DevChain returned HTTP ${response.status}.`;
      throw new LocalApiHttpError(
        response.status,
        result?.code ?? null,
        message,
        result?.details ?? null,
      );
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

function printOperationSteps(operation, states, context) {
  if (Array.isArray(operation.details?.checkWarnings)) {
    for (const warning of operation.details.checkWarnings) {
      if (typeof warning !== "string") continue;
      const key = `check-warning:${warning}`;
      if (states.has(key)) continue;
      states.set(key, true);
      writeLine(context.stdout, `WARNING: ${warning}`, context.secrets);
    }
  }
  for (const step of operation.steps ?? []) {
    if (step.state === "pending") continue;
    if (states.get(step.id) === step.state) continue;
    states.set(step.id, step.state);
    writeLine(
      context.stdout,
      `${step.label || step.id}: ${step.state}`,
      context.secrets,
    );
  }
}

// Include request time as well as backoff in the restart recovery deadline.
async function getOperation(fetchImpl, baseUrl, operationId, context) {
  const deadline = context.now() + RESTART_WAIT_BUDGET_MS;
  let delayMs = POLL_INTERVAL_MS;
  let announced = false;
  for (;;) {
    const remainingMs = deadline - context.now();
    if (remainingMs <= 0) {
      throw new Error(
        `DevChain did not come back within 3 minutes. ${context.recoveryHint ?? `Resume operation ${operationId} from the Cloud page.`}`,
      );
    }
    try {
      return await requestJson(
        fetchImpl,
        baseUrl,
        `/api/remotes/operations/${encodeURIComponent(operationId)}`,
        { timeoutMs: Math.min(REQUEST_TIMEOUT_MS, remainingMs) },
      );
    } catch (error) {
      if (error instanceof LocalApiHttpError) throw error;
      if (!announced) {
        announced = true;
        writeLine(
          context.stderr,
          "DevChain is temporarily unavailable; waiting for it to come back.",
          context.secrets,
        );
      }
      const sleepMs = Math.min(delayMs, deadline - context.now());
      if (sleepMs > 0) await context.sleep(sleepMs);
      delayMs = Math.min(delayMs * 2, RESTART_DELAY_CAP_MS);
    }
  }
}

async function getLocalApiBaseUrl({
  readPidFile,
  isProcessRunning,
  resolveSharedModuleSpecifier,
}) {
  const pidData = readPidFile();
  if (!pidData || !isProcessRunning(pidData.pid)) return null;
  const { HostResolver } = await import(resolveSharedModuleSpecifier());
  return HostResolver.buildInternalBaseUrl({
    host: pidData.host || "127.0.0.1",
    port: pidData.port,
  });
}

module.exports = {
  LocalApiHttpError,
  POLL_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  getLocalApiBaseUrl,
  getOperation,
  printOperationSteps,
  requestJson,
  writeLine,
};
