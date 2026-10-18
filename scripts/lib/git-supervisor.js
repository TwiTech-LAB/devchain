const { spawn } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { constants } = require("node:os");
const {
  LocalApiHttpError,
  getLocalApiBaseUrl,
  requestJson,
  writeLine,
} = require("./local-api");
const {
  isProcessRunning,
  readPidFile,
  resolveSharedModuleSpecifier,
} = require("./local-app-process");

const VM_WAIT_MS = 60_000;
// The VM coordinator waits up to 90 s for Git to come back from the PC.
const HOLD_TIMEOUT_MS = 120_000;
const VM_RETRY_MS = 2_000;
// The home API bounds a handover itself; this only stops a hung connection.
const ACQUIRE_TIMEOUT_MS = 10 * 60_000;
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

// The shell is the registered process: it waits for the write id on fd 3, then execs git under
// the same pid and start time. EOF on fd 3 (refused, or the supervisor died) exits without git.
const GATE =
  'IFS= read -r id <&3 || exit 125; exec 3<&-; [ -n "$id" ] && export DEVCHAIN_GIT_HOLD="$id"; exec "$0" "$@"';

class SupervisorError extends Error {}

/**
 * Runs one git write for a connected project: on the PC through the home write API, on the VM
 * under a coordinator hold. The shim passes the project in DEVCHAIN_GIT_PROJECT and the side in
 * DEVCHAIN_GIT_SIDE. argv, stdio and the exit code pass through unchanged;
 * git runs in this process group, never detached, so terminal prompts keep working.
 * See docs/git-coordinator.md (Home writes).
 */
async function runGitSupervisor(args, dependencies = {}) {
  const stderr = dependencies.stderr ?? process.stderr;
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const spawnImpl = dependencies.spawn ?? spawn;
  const signals = dependencies.signals ?? process;
  const cwd = dependencies.cwd ?? process.cwd();
  const env = dependencies.env ?? process.env;
  const git = dependencies.git ?? env.DEVCHAIN_REAL_GIT ?? "git";
  const context = {
    stderr,
    fetchImpl,
    now: dependencies.now ?? Date.now,
    sleep:
      dependencies.sleep ??
      ((ms) => new Promise((done) => setTimeout(done, ms))),
    announceAfterMs: (dependencies.isTTY ?? stderr.isTTY) ? 1_000 : 10_000,
  };
  try {
    const baseUrl = await (
      dependencies.getLocalApiBaseUrl ??
      (() =>
        getLocalApiBaseUrl({
          readPidFile,
          isProcessRunning,
          resolveSharedModuleSpecifier,
        }))
    )();
    if (!baseUrl)
      throw new SupervisorError(
        "DevChain is not running. Start it with `devchain start`; Git writes in DevChain projects need it.",
      );
    context.baseUrl = baseUrl;
    const project = env.DEVCHAIN_GIT_PROJECT
      ? { projectId: env.DEVCHAIN_GIT_PROJECT, remoteName: env.DEVCHAIN_GIT_REMOTE_NAME || null }
      : await findProject(context, cwd);
    if (env.DEVCHAIN_GIT_SIDE === "vm" && project) {
      return await runVmWrite(context, project.projectId, {
        spawn: () => gated(spawnImpl, git, args, cwd, env, project.projectId),
        signals,
        identity: dependencies.processIdentity ?? processIdentity,
      });
    }
    if (!project?.remoteName) {
      return exitCode(
        await supervise(spawnImpl(git, args, { stdio: "inherit", cwd }), signals),
      );
    }
    const child = gated(spawnImpl, git, args, cwd, env, project.projectId);
    // Ctrl-C while waiting: the home app aborts a handover that has not flipped.
    const write = await runGated(child, signals, (signal) =>
      acquire({ ...context, signal }, project, child.pid),
    );
    return exitCode(write.result);
  } catch (error) {
    writeLine(stderr, `git: ${error.message ?? "the Git write failed."}`);
    return 1;
  }
}

/** The gate shell; the project rides along so a nested Git of this write skips the shim. */
function gated(spawnImpl, git, args, cwd, env, projectId) {
  return spawnImpl("/bin/sh", ["-c", GATE, git, "-c", "gc.auto=0", ...args], {
    stdio: ["inherit", "inherit", "inherit", "pipe"],
    cwd,
    env: { ...env, DEVCHAIN_GIT_HOLD_PROJECT: projectId },
  });
}

/**
 * Supervises a gated git child until it exits. `admit(signal)` returns the id the gate passes to
 * git; its signal aborts once the child is gone, which before admission means a signal ended it.
 * A refusal ends the gate without git and is thrown; an interrupted wait is not admitted.
 */
async function runGated(child, signals, admit) {
  const exited = supervise(child, signals);
  const gate = child.stdio[3];
  // The gate may already be gone (a forwarded signal); its exit is reported by `exited`.
  gate.on("error", () => {});
  const gone = abortWhenGone(exited);
  let id;
  try {
    id = await admit(gone);
  } catch (error) {
    const interrupted = gone.aborted;
    gate.end();
    const result = await exited;
    if (interrupted) return { admitted: false, result };
    throw error;
  }
  gate.end(`${id}\n`);
  return { admitted: true, result: await exited };
}

/**
 * VM write: the coordinator admits the gate pid and start time as a hold (waiting while the PC
 * owns Git), git runs under it, and the hold is released once git has exited.
 */
async function runVmWrite(context, projectId, { spawn, signals, identity }) {
  const child = spawn();
  const start = identity(child.pid);
  const hold = start && {
    holdId: `vm-${child.pid}-${start.split(":").pop()}`,
    pid: child.pid,
    processStartTime: start,
  };
  const path = `/api/git-coordinator/projects/${encodeURIComponent(projectId)}`;
  const write = await runGated(child, signals, (signal) =>
    acquireHold({ ...context, signal }, path, hold),
  );
  if (!write.admitted) return exitCode(write.result);
  // The coordinator also drops a hold whose process has exited, at its next poll.
  await requestJson(context.fetchImpl, context.baseUrl, `${path}/release`, {
    method: "POST",
    body: hold,
  }).catch(() => undefined);
  return exitCode(write.result);
}

/** One line once the wait for Git to come back is noticeable. */
async function acquireHold(context, path, hold) {
  const timer = setTimeout(
    () => writeLine(context.stderr, "git: waiting for Git to come back to this VM…"),
    context.announceAfterMs,
  );
  try {
    if (!hold) throw new SupervisorError("the Git process identity cannot be read.");
    await requestJson(context.fetchImpl, context.baseUrl, `${path}/acquire`, {
      method: "POST",
      body: hold,
      timeoutMs: HOLD_TIMEOUT_MS,
      signal: context.signal,
    });
    return hold.holdId;
  } finally {
    clearTimeout(timer);
  }
}

/** `<boot id>:<start ticks>`, the VM coordinator's process identity; null when unreadable. */
function processIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const start = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
    return boot && start ? `${boot}:${start}` : null;
  } catch {
    return null;
  }
}

async function findProject(context, cwd) {
  try {
    return await requestJson(
      context.fetchImpl,
      context.baseUrl,
      `/api/git-writes/project?path=${encodeURIComponent(cwd)}`,
    );
  } catch (error) {
    if (error instanceof LocalApiHttpError && error.status === 404) return null;
    throw error;
  }
}

/** One line once the wait is noticeable; a VM that does not answer is retried for about 60 s. */
async function acquire(context, project, pid) {
  const started = context.now();
  let announced = false;
  const announce = (line) => {
    if (announced) return;
    announced = true;
    writeLine(context.stderr, line);
  };
  const timer = setTimeout(
    () => announce(`git: waiting for Git on the VM '${project.remoteName}'…`),
    context.announceAfterMs,
  );
  try {
    for (;;) {
      try {
        const { writeId } = await requestJson(
          context.fetchImpl,
          context.baseUrl,
          "/api/git-writes/acquire",
          {
            method: "POST",
            body: { projectId: project.projectId, pid },
            timeoutMs: ACQUIRE_TIMEOUT_MS,
            signal: context.signal,
          },
        );
        return writeId;
      } catch (error) {
        if (
          !(error instanceof LocalApiHttpError) ||
          error.code !== "GIT_VM_UNREACHABLE"
        )
          throw error;
        if (context.now() - started >= VM_WAIT_MS)
          throw new SupervisorError(
            `the VM '${project.remoteName}' did not respond for ${VM_WAIT_MS / 1000} s; Git did not run.`,
          );
        announce(
          `git: the VM '${project.remoteName}' does not respond; retrying for up to ${VM_WAIT_MS / 1000} s.`,
        );
        await context.sleep(VM_RETRY_MS);
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Aborts once the gated child exits, which before admission means a signal ended it. */
function abortWhenGone(exited) {
  const controller = new AbortController();
  void exited.then(() => controller.abort());
  return controller.signal;
}

/** Forwards termination signals to the child until it exits. */
function supervise(child, signals) {
  const forward = (signal) => {
    try {
      child.kill(signal);
    } catch {
      // The child is already gone.
    }
  };
  for (const signal of FORWARDED_SIGNALS) signals.on(signal, forward);
  return new Promise((resolve) => {
    const done = (result) => {
      for (const signal of FORWARDED_SIGNALS) signals.off(signal, forward);
      resolve(result);
    };
    child.on("error", (error) => done({ error }));
    child.on("exit", (code, signal) => done({ code, signal }));
  });
}

function exitCode({ code, signal, error }) {
  if (error) throw new SupervisorError(error.message);
  if (signal) return 128 + (constants.signals[signal] ?? 0);
  return code ?? 1;
}

module.exports = { runGitSupervisor };

if (require.main === module) {
  runGitSupervisor(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
