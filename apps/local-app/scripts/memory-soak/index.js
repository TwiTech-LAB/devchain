#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getScenario, scenarios } = require('./lib/scenarios');
const { dispatchScenario } = require('./lib/runner');

const REPO_ROOT = path.resolve(__dirname, '../../../..');

function usage() {
  return `Usage:
  node scripts/memory-soak/index.js --list
  node scripts/memory-soak/index.js --scenario <id> [options]

Options:
  --profile <smoke|baseline|soak>  Duration profile (default: baseline)
  --sessions <n>                  Scratch tmux sessions (default: 3)
  --seed <n>                      Deterministic seed (default: 1337)
  --target-pid <pid>              Optional application process-tree root
  --app-entry <path>              Built local-app entry for disposable fixtures
  --metrics-url <url>             Optional numeric application counter endpoint
  --report <path>                 Write the JSON report to this path
  --expected-repo-root <path>     Fail if the checkout root differs
  --foreground-rate <n>           Bursts/second/session (default: 10)
  --background-rate <n>           Bursts/second/session (default: 1)
  --chunk-bytes <n>               Approximate bytes/chunk (default: 1024)`;
}

function parseArgs(argv) {
  const options = {
    profile: 'baseline',
    sessions: 3,
    seed: 1337,
    foregroundRate: 10,
    backgroundRate: 1,
    chunkBytes: 1024,
    repoRoot: REPO_ROOT,
    appEntry: path.join(REPO_ROOT, 'apps/local-app/dist/main.js'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--list') options.list = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else {
      const value = argv[++index];
      if (value === undefined) throw new Error(`Missing value for ${argument}`);
      if (argument === '--scenario') options.scenario = value;
      else if (argument === '--profile') options.profile = value;
      else if (argument === '--sessions') options.sessions = Number(value);
      else if (argument === '--seed') options.seed = Number(value);
      else if (argument === '--target-pid') options.targetPid = Number(value);
      else if (argument === '--app-entry') {
        options.appEntry = path.isAbsolute(value) ? value : path.resolve(options.repoRoot, value);
      } else if (argument === '--metrics-url') options.metricsUrl = value;
      else if (argument === '--report') {
        options.report = path.isAbsolute(value) ? value : path.resolve(options.repoRoot, value);
      } else if (argument === '--expected-repo-root')
        options.expectedRepoRoot = path.resolve(value);
      else if (argument === '--foreground-rate') options.foregroundRate = Number(value);
      else if (argument === '--background-rate') options.backgroundRate = Number(value);
      else if (argument === '--chunk-bytes') options.chunkBytes = Number(value);
      else throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (!['smoke', 'baseline', 'soak'].includes(options.profile)) {
    throw new Error(`Invalid profile: ${options.profile}`);
  }
  for (const [name, value] of [
    ['sessions', options.sessions],
    ['seed', options.seed],
    ['foreground-rate', options.foregroundRate],
    ['background-rate', options.backgroundRate],
    ['chunk-bytes', options.chunkBytes],
  ]) {
    if (!Number.isInteger(value) || value <= 0)
      throw new Error(`${name} must be a positive integer`);
  }
  if (
    options.targetPid !== undefined &&
    (!Number.isInteger(options.targetPid) || options.targetPid <= 0)
  ) {
    throw new Error('target-pid must be a positive integer');
  }
  options.appCwd = path.dirname(path.dirname(options.appEntry));
  return options;
}

function writeReport(report, reportPath) {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, serialized, 'utf8');
  }
  process.stdout.write(serialized);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.list) {
    writeReport({ schemaVersion: 1, scenarios }, options.report);
    return;
  }
  if (!options.scenario) throw new Error(`--scenario is required\n\n${usage()}`);
  const scenario = getScenario(options.scenario);
  if (!scenario) throw new Error(`Unknown scenario: ${options.scenario}`);
  const report = await dispatchScenario(scenario, options);
  writeReport(report, options.report);
  if (report.pass === false) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    const report = {
      schemaVersion: 1,
      status: 'error',
      pass: false,
      error: error instanceof Error ? error.message : String(error),
      generatedAt: new Date().toISOString(),
    };
    const reportIndex = process.argv.indexOf('--report');
    const rawReportPath = reportIndex >= 0 ? process.argv[reportIndex + 1] : null;
    const reportPath = rawReportPath
      ? path.isAbsolute(rawReportPath)
        ? rawReportPath
        : path.resolve(REPO_ROOT, rawReportPath)
      : null;
    if (reportPath) {
      fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
      fs.writeFileSync(path.resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 2;
  });
}

module.exports = { parseArgs };
