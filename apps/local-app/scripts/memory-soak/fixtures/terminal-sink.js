#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const doneFile = process.argv[2];
const sentinel = Buffer.from('\0DEVCHAIN_RENDER_DONE\0');
let pending = Buffer.alloc(0);
setInterval(() => {}, 60_000);

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  const sentinelIndex = pending.indexOf(sentinel);
  if (sentinelIndex < 0) return;
  process.stdin.pause();
  process.stdout.write(pending.subarray(0, sentinelIndex), () => {
    fs.writeFileSync(doneFile, 'done\n', 'utf8');
  });
});
