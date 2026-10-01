'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, makeTurn } = require('./transcript-paged-load');

// Harness contracts prevent accidentally measuring a cache-resident or undersized fixture.
test('requires an over-budget fixture and a fresh evidence path', () => {
  const args = ['--report', '/tmp/not-created-paged-contract.json'];
  assert.equal(parseArgs(args).fileMiB, 55);
  assert.throws(() => parseArgs([...args, '--file-mib', '49']));
  assert.throws(() => parseArgs([...args, '--rounds', '0']));
  assert.throws(() => parseArgs(['--report', __filename]));
});

test('generates deterministic complete Claude turns with configurable answer sizes', () => {
  const lines = makeTurn(7, 256).trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].message.role, 'user');
  assert.equal(lines[1].parentUuid, lines[0].uuid);
  assert(lines[1].message.content[0].text.length >= 256 * 1024);
  assert.equal(makeTurn(7, 256), makeTurn(7, 256));
});
