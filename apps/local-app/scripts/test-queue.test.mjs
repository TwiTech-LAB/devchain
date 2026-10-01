import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildArgv } from "jest";
import {
  FULL_TEST_QUEUE,
  classifyJestArgs,
  runQueuedJest,
} from "./test-queue.mjs";

// The queue decision is pure argv classification over jest's own parser, so a
// node --test spec against the real buildArgv is the cheapest reliable layer;
// no test suite has to run here.
const jestBin = fileURLToPath(
  new URL("../../../node_modules/jest/bin/jest.js", import.meta.url),
);

const defaultScriptArgs = [
  "--selectProjects",
  "backend-unit",
  "backend-integration",
  "ui",
  "cli-helpers",
  "--maxWorkers=50%",
  "--workerIdleMemoryLimit=512MB",
];

const classificationCases = [
  [defaultScriptArgs, "full"],
  [["--maxWorkers", "2"], "full"],
  [["-t", "foo"], "full"],
  [["--runTestsByPath", "src/a.spec.ts"], "targeted"],
  [["--", "--runTestsByPath", "src/a.spec.ts"], "targeted"],
  [["-t", "foo", "src/a.spec.ts"], "targeted"],
];

for (const [args, expected] of classificationCases) {
  test(`classifies ${JSON.stringify(args)} as ${expected}`, async () => {
    assert.equal(classifyJestArgs(await buildArgv(args)), expected);
  });
}

for (const flag of [
  "--listTests",
  "--showConfig",
  "--clearCache",
  "--watch",
  "--watchAll",
]) {
  test(`classifies ${flag} as utility`, async () => {
    assert.equal(classifyJestArgs(await buildArgv([flag])), "utility");
  });
}

test("classifies --watch with a path as utility because watch never terminates", async () => {
  assert.equal(
    classifyJestArgs(await buildArgv(["--watch", "src/a.spec.ts"])),
    "utility",
  );
});

function fakeRunners() {
  const calls = { exclusive: [], command: [] };
  return {
    calls,
    runners: {
      runExclusive(options) {
        calls.exclusive.push(options);
        return 3;
      },
      runCommand(options) {
        calls.command.push(options);
        return 5;
      },
    },
  };
}

test("a full run locks the shared full-tests queue and spawns the repo jest with --expose-gc", async () => {
  const { calls, runners } = fakeRunners();
  const code = await runQueuedJest(defaultScriptArgs, runners);
  assert.equal(code, 3);
  assert.equal(calls.command.length, 0);
  assert.deepEqual(calls.exclusive, [
    {
      name: FULL_TEST_QUEUE,
      command: process.execPath,
      args: ["--expose-gc", jestBin, ...defaultScriptArgs],
      env: testChildEnv(),
    },
  ]);
  assert.equal(existsSync(jestBin), true);
});

test("a targeted run spawns immediately without a lock and passes a literal -- unchanged", async () => {
  const { calls, runners } = fakeRunners();
  const rawArgs = ["--", "--runTestsByPath", "src/a.spec.ts"];
  const code = await runQueuedJest(rawArgs, runners);
  assert.equal(code, 5);
  assert.equal(calls.exclusive.length, 0);
  assert.deepEqual(calls.command, [
    {
      command: process.execPath,
      args: ["--expose-gc", jestBin, ...rawArgs],
      env: testChildEnv(),
    },
  ]);
});

function testChildEnv() {
  return { ...process.env, NODE_ENV: "test" };
}

const packageJson = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../package.json", import.meta.url)),
    "utf8",
  ),
);

const queuedScripts = {
  test: "node scripts/test-queue.mjs --selectProjects backend-unit backend-integration ui cli-helpers --maxWorkers=50% --workerIdleMemoryLimit=512MB",
  "test:cov":
    "node scripts/test-queue.mjs --coverage --selectProjects backend-unit backend-integration ui cli-helpers --maxWorkers=75% --workerIdleMemoryLimit=512MB",
  "test:cov:full": "node scripts/test-queue.mjs --coverage --runInBand",
  "test:full":
    "node scripts/test-queue.mjs --maxWorkers=50% --workerIdleMemoryLimit=512MB",
  "test:lowmem": "node scripts/test-queue.mjs --maxWorkers=4",
  "test:health-report:generate":
    "node scripts/test-queue.mjs --selectProjects backend-unit backend-integration ui cli-helpers --coverage --json --outputFile=reports/.jest-results.json --coverageReporters=json-summary",
};

for (const [name, script] of Object.entries(queuedScripts)) {
  test(`package script ${name} goes through the queue wrapper`, () => {
    assert.equal(packageJson.scripts[name], script);
  });
}

for (const name of ["test:watch", "test:debug", "test:external"]) {
  test(`package script ${name} still calls jest directly`, () => {
    assert.doesNotMatch(packageJson.scripts[name], /test-queue/);
    assert.match(packageJson.scripts[name], /jest/);
  });
}
