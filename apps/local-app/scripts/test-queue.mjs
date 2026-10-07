import { buildArgv } from "jest";
import { availableParallelism, freemem } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runExclusive, runCommand } from "../../../scripts/lib/exclusive-run.js";

export const FULL_TEST_QUEUE = "full-tests";

const JEST_BIN = fileURLToPath(
  new URL("../../../node_modules/jest/bin/jest.js", import.meta.url),
);

// Watch modes never terminate and the listing flags never run tests, so they
// must never take the queue lock; they win over targeted path arguments.
const UTILITY_FLAGS = [
  "listTests",
  "showConfig",
  "clearCache",
  "watch",
  "watchAll",
];

// A bare `-t` still loads every test file, so only path arguments or a
// file-selection flag make a run targeted. Values of `--selectProjects` or
// `--maxWorkers` are option values, never paths.
const TARGETED_FLAGS = [
  "runTestsByPath",
  "testPathPatterns",
  "findRelatedTests",
  "onlyChanged",
  "o",
  "changedSince",
  "lastCommit",
];

const GIB = 1024 ** 3;
// workerIdleMemoryLimit does not bound a worker's peak memory, so the estimate
// is fixed. The reserve leaves room for the agents and the editor.
const WORKER_MEMORY_ESTIMATE = 2 * GIB;
const MEMORY_RESERVE = 2 * GIB;

// Every form Jest reads as maxWorkers; a bare flag takes the next argument.
const MAX_WORKERS_ARG = /^(?:--maxWorkers|--max-workers|-w)(.*)$/;

function withoutMaxWorkers(rawArgs) {
  // Arguments after a literal -- are paths, never options.
  const end = rawArgs.includes("--") ? rawArgs.indexOf("--") : rawArgs.length;
  const kept = [];
  for (let i = 0; i < end; i++) {
    const match = MAX_WORKERS_ARG.exec(rawArgs[i]);
    if (!match) kept.push(rawArgs[i]);
    else if (match[1] === "") i++;
  }
  return [...kept, ...rawArgs.slice(end)];
}

// Jest reads a repeated --maxWorkers ("75%", "2") as 75 workers, so only the
// last value is kept: pnpm adds the caller's flags after the script's. The
// count never goes above the CPU count, and a percentage also drops to what
// the available memory holds. This reduces memory pressure; it does not
// prevent swap or an OOM kill.
export function limitJestWorkers(
  rawArgs,
  { maxWorkers },
  { cpus = availableParallelism(), freeBytes = freemem() } = {},
) {
  if (maxWorkers === undefined) return rawArgs;
  const values = [maxWorkers].flat();
  const requested = String(values.at(-1)).trim();
  const percent = requested.endsWith("%");
  const asked = Number.parseInt(requested, 10) || 1;
  const count = Math.max(1, percent ? Math.floor((cpus * asked) / 100) : asked);
  let workers = count;
  let reason = null;
  if (workers > cpus) {
    workers = cpus;
    reason = `${cpus} CPUs`;
  }
  const memoryWorkers = Math.max(
    1,
    Math.floor((freeBytes - MEMORY_RESERVE) / WORKER_MEMORY_ESTIMATE),
  );
  if (percent && memoryWorkers < workers) {
    workers = memoryWorkers;
    reason = `${(freeBytes / GIB).toFixed(1)} GB available`;
  }
  if (values.length === 1 && workers === count) return rawArgs;
  if (reason) process.stderr.write(`Jest workers: ${workers} (${reason})\n`);
  return [`--maxWorkers=${workers}`, ...withoutMaxWorkers(rawArgs)];
}

export function classifyJestArgs(argv) {
  if (UTILITY_FLAGS.some((flag) => argv[flag])) return "utility";
  if (argv._.length > 0 || TARGETED_FLAGS.some((flag) => argv[flag]))
    return "targeted";
  return "full";
}

export async function runQueuedJest(
  rawArgs,
  runners = { runExclusive, runCommand },
  system,
) {
  // buildArgv prints usage and exits for --help/--version and throws on
  // unknown options, exactly like the jest CLI, and that happens before any
  // queue lock is taken.
  const argv = await buildArgv(rawArgs);
  const jestArgs = limitJestWorkers(rawArgs, argv, system);
  if (jestArgs !== rawArgs) {
    const [limit] = jestArgs;
    const { maxWorkers } = await buildArgv(jestArgs);
    if (`--maxWorkers=${maxWorkers}` !== limit)
      throw new Error(
        `Cannot merge the --maxWorkers values (${[argv.maxWorkers].flat().join(", ")}). Pass --maxWorkers=<n> once.`,
      );
  }
  const spawn = {
    command: process.execPath,
    args: ["--expose-gc", JEST_BIN, ...jestArgs],
    env: { ...process.env, NODE_ENV: "test" },
  };
  if (classifyJestArgs(argv) === "full") {
    return runners.runExclusive({ name: FULL_TEST_QUEUE, ...spawn });
  }
  return runners.runCommand(spawn);
}

const invokedAsScript =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  try {
    process.exitCode = await runQueuedJest(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
