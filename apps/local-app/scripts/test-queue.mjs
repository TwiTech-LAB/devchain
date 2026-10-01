import { buildArgv } from "jest";
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

export function classifyJestArgs(argv) {
  if (UTILITY_FLAGS.some((flag) => argv[flag])) return "utility";
  if (argv._.length > 0 || TARGETED_FLAGS.some((flag) => argv[flag]))
    return "targeted";
  return "full";
}

export async function runQueuedJest(
  rawArgs,
  runners = { runExclusive, runCommand },
) {
  // buildArgv prints usage and exits for --help/--version and throws on
  // unknown options, exactly like the jest CLI, and that happens before any
  // queue lock is taken.
  const argv = await buildArgv(rawArgs);
  const spawn = {
    command: process.execPath,
    args: ["--expose-gc", JEST_BIN, ...rawArgs],
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
