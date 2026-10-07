const { dirname, resolve } = require("node:path");
const {
  LocalApiHttpError,
  POLL_INTERVAL_MS,
  getOperation,
  printOperationSteps,
  requestJson,
  writeLine,
} = require("./local-api");

// The server checks the VM before it starts a switch; each check can take 15 seconds.
const START_TIMEOUT_MS = 120_000;

class GitCommandRefusedError extends Error {}

async function findProject(fetchImpl, baseUrl, path) {
  let candidate = resolve(path);
  for (;;) {
    try {
      const project = await requestJson(
        fetchImpl,
        baseUrl,
        `/api/projects/by-path?path=${encodeURIComponent(candidate)}`,
      );
      if (!project || typeof project.id !== "string") {
        throw new Error("DevChain returned an invalid project.");
      }
      return project;
    } catch (error) {
      if (!(error instanceof LocalApiHttpError) || error.status !== 404)
        throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new GitCommandRefusedError(
        `No registered project contains ${resolve(path)}.`,
      );
    }
    candidate = parent;
  }
}

function recoveryCommand(owner, force, projectPath) {
  const command =
    owner === "home"
      ? `devchain git take${force ? " --force" : ""}`
      : "devchain git return";
  return projectPath
    ? `${command} --project '${projectPath.replace(/'/g, "'\\''")}'`
    : command;
}

function ownerMessage(owner, remoteName, already = false) {
  const side = owner === "home" ? "this PC" : `the VM '${remoteName}'`;
  return `Git for this project is ${already ? "already " : ""}on ${side}.`;
}

function printStatus(status, stdout, projectPath) {
  writeLine(
    stdout,
    status.connected
      ? ownerMessage(status.owner, status.remoteName)
      : "This project is not connected to a VM.",
  );
  if (!status.open) return;
  const open = status.open;
  writeLine(stdout, `Git switch ${open.operationId}: ${open.state}.`);
  writeLine(
    stdout,
    `Target: ${open.owner === "home" ? "this PC" : `the VM '${status.remoteName}'`}.`,
  );
  if (open.step) writeLine(stdout, `Step: ${open.step}.`);
  if (open.error)
    writeLine(
      stdout,
      `Error: ${open.error.message}${open.error.code ? ` (${open.error.code})` : ""}`,
    );
  writeLine(
    stdout,
    `To finish the switch, run \`${recoveryCommand(open.owner, open.force, projectPath)}\`.`,
  );
}

function printDetails(operation, seen, stderr) {
  const details = operation.details ?? {};
  const emit = (line) => {
    if (seen.has(line)) return;
    seen.add(line);
    writeLine(stderr, line);
  };
  const unknownAgents = details.unknownAgents ?? [];
  if (unknownAgents.length > 0)
    emit(
      "These agents on the VM have an unknown state. They do not block the switch:",
    );
  for (const agent of unknownAgents) {
    emit(`  - ${agent.agentName} (state unknown)`);
  }
  for (const warning of [details.guardWarning, details.vmGuardWarning]) {
    if (warning) emit(`WARNING: ${warning}`);
  }
  for (const [field, side] of [
    ["pcGuardRemove", "PC"],
    ["vmGuardRemove", "VM"],
  ]) {
    const result = details[field];
    if (!result) continue;
    if (result.warning) emit(`WARNING: ${result.warning}`);
    if (result.indexRefreshed !== true)
      emit(`WARNING: The ${side} Git index was not rebuilt.`);
  }
}

function printBusyAgents(error, remoteName, context, projectPath) {
  const agents = error.details?.agents ?? [];
  writeLine(
    context.stderr,
    `Git stays on the VM '${remoteName}': ${agents.length} ${agents.length === 1 ? "agent is" : "agents are"} working in this project.`,
  );
  for (const agent of agents) {
    const elapsed = context.wallNow() - Date.parse(agent.since);
    const minutes = Number.isFinite(elapsed)
      ? Math.max(0, Math.floor(elapsed / 60_000))
      : null;
    const duration =
      minutes === null
        ? "time unknown"
        : minutes < 1
          ? "less than 1 min"
          : `${minutes} min`;
    const state =
      agent.state === "busy" ? `busy for ${duration}` : `starting, ${duration}`;
    writeLine(context.stderr, `  - ${agent.agentName} (${state})`);
  }
  writeLine(
    context.stderr,
    `Wait until they finish, then run \`${recoveryCommand("home", false, projectPath)}\` again.`,
  );
  writeLine(
    context.stderr,
    `To stop this project's agent sessions on the VM now, run \`${recoveryCommand("home", true, projectPath)}\`.`,
  );
}

async function runGitOwnerCommand(command, options = {}, dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const context = {
    stdout: stderr,
    stderr,
    secrets: [],
    now: dependencies.now ?? (() => performance.now()),
    wallNow: dependencies.wallNow ?? Date.now,
    sleep:
      dependencies.sleep ??
      ((ms) => new Promise((done) => setTimeout(done, ms))),
  };
  let status;
  try {
    if (dependencies.getMachineRole?.() === "remote VM") {
      throw new GitCommandRefusedError(
        "Run this command on the PC that connected this project.",
      );
    }
    if (
      !["status", "take", "return"].includes(command) ||
      (command !== "take" && options.force)
    ) {
      throw new GitCommandRefusedError(
        "Use devchain git status, take [--force], or return.",
      );
    }
    const baseUrl = await dependencies.getLocalApiBaseUrl?.();
    if (!baseUrl) {
      writeLine(stderr, "Start DevChain first (devchain start).");
      return 1;
    }
    const project = await findProject(
      fetchImpl,
      baseUrl,
      options.project ?? dependencies.cwd ?? process.cwd(),
    );
    status = await requestJson(
      fetchImpl,
      baseUrl,
      `/api/remotes/git-owner?projectId=${encodeURIComponent(project.id)}`,
    );
    if (command === "status") {
      printStatus(status, stdout, options.project);
      return 0;
    }
    if (!status.connected || !status.remoteId) {
      throw new GitCommandRefusedError(
        "This project is not connected to a VM.",
      );
    }
    const owner = command === "take" ? "home" : "vm";
    let operation = await requestJson(
      fetchImpl,
      baseUrl,
      `/api/remotes/${encodeURIComponent(status.remoteId)}/git-owner`,
      {
        method: "POST",
        body: { projectId: project.id, owner, force: options.force === true },
        timeoutMs: START_TIMEOUT_MS,
      },
    );
    if (operation?.changed === false) {
      if (operation.cancelledOperationId) {
        writeLine(
          stdout,
          `Cancelled the failed switch ${operation.cancelledOperationId}.`,
        );
      }
      writeLine(stdout, ownerMessage(operation.owner, status.remoteName, true));
      return 0;
    }
    const steps = new Map();
    const details = new Set();
    let announced = false;
    for (;;) {
      if (
        !operation ||
        typeof operation.id !== "string" ||
        !Array.isArray(operation.steps) ||
        !["running", "failed", "done", "cancelled"].includes(operation.state)
      ) {
        throw new Error("DevChain returned an invalid Git switch operation.");
      }
      const target = operation.details?.owner ?? owner;
      const repeat = recoveryCommand(
        target,
        operation.details?.force === true,
        options.project,
      );
      context.recoveryHint = `Run \`${repeat}\` again to follow or retry operation ${operation.id}.`;
      if (!announced) {
        writeLine(stderr, `Git switch started (operation ${operation.id}).`);
        announced = true;
      }
      printOperationSteps(operation, steps, context);
      printDetails(operation, details, stderr);
      if (operation.state === "done") {
        writeLine(stdout, ownerMessage(target, status.remoteName));
        return 0;
      }
      if (operation.state === "failed" || operation.state === "cancelled") {
        const failed = operation.steps.find((step) => step.state === "failed");
        writeLine(
          stderr,
          failed?.error?.message ?? `Git switch ${operation.state}.`,
        );
        writeLine(stderr, context.recoveryHint);
        return 1;
      }
      await context.sleep(POLL_INTERVAL_MS);
      operation = await getOperation(fetchImpl, baseUrl, operation.id, context);
    }
  } catch (error) {
    const code = error.details?.code ?? error.code;
    if (code === "GIT_TAKE_AGENTS_BUSY") {
      printBusyAgents(error, status?.remoteName, context, options.project);
      return 2;
    }
    writeLine(stderr, error.message ?? "Git command failed.");
    if (
      code === "REMOTE_OPERATION_CANCEL_FAILED" ||
      (error instanceof LocalApiHttpError && error.status >= 500)
    ) {
      writeLine(stderr, "Run the same command again.");
      return 1;
    }
    if (
      error instanceof GitCommandRefusedError ||
      (error instanceof LocalApiHttpError &&
        [400, 403, 404, 409, 422].includes(error.status))
    )
      return 2;
    return 1;
  }
}

module.exports = { runGitOwnerCommand };
