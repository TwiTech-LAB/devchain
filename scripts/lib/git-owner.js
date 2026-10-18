const { dirname, resolve } = require("node:path");
const { LocalApiHttpError, requestJson, writeLine } = require("./local-api");

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

function ownerMessage(status) {
  const side =
    status.owner === "home" ? "this PC" : `the VM '${status.remoteName}'`;
  const lastKnown = status.live ? "" : " (last known; the VM was not reached)";
  return `Git for this project is on ${side}${lastKnown}.`;
}

function printStatus(status, stdout) {
  if (!status.connected) {
    writeLine(stdout, "This project is not connected to a VM.");
    return;
  }
  writeLine(stdout, ownerMessage(status));
  writeLine(stdout, `Generation: ${status.generation}`);
  writeLine(
    stdout,
    `In-flight writes: ${status.homeWrites} on this PC, ${status.vmHolds} on the VM`,
  );
  if (status.checkpoint) {
    writeLine(
      stdout,
      `Last checkpoint: generation ${status.checkpoint.generation} at ${new Date(status.checkpoint.at).toISOString()} (write ${status.checkpoint.writeId})`,
    );
  } else {
    writeLine(stdout, "Last checkpoint: none");
  }
  if (status.transition) {
    writeLine(
      stdout,
      `Transition: ${status.transition.kind}, ${status.transition.phase}`,
    );
  }
  for (const warning of status.warnings ?? []) {
    writeLine(stdout, `WARNING: ${warning}`);
  }
}

async function runGitStatusCommand(options = {}, dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  try {
    if (dependencies.getMachineRole?.() === "remote VM") {
      throw new GitCommandRefusedError(
        "Run this command on the PC that connected this project.",
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
    const status = await requestJson(
      fetchImpl,
      baseUrl,
      `/api/remotes/git-owner?projectId=${encodeURIComponent(project.id)}`,
    );
    printStatus(status, stdout);
    return 0;
  } catch (error) {
    writeLine(stderr, error.message ?? "Git command failed.");
    if (
      error instanceof GitCommandRefusedError ||
      (error instanceof LocalApiHttpError &&
        [400, 403, 404, 409, 422].includes(error.status))
    )
      return 2;
    return 1;
  }
}

module.exports = { runGitStatusCommand };
