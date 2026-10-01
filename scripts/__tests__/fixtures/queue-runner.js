const fs = require("node:fs");

const options = JSON.parse(process.argv[2]);
const clockFile = process.env.QUEUE_TEST_CLOCK_FILE;
if (clockFile) {
  const now = Date.now;
  Date.now = () => now() + (fs.existsSync(clockFile) ? 60001 : 0);
}
const gate = process.env.QUEUE_TEST_READ_GATE;
if (gate) {
  const readFileSync = fs.readFileSync;
  let intercepted = false;
  fs.readFileSync = function (file, ...args) {
    const data = readFileSync.call(this, file, ...args);
    if (!intercepted && file === process.env.QUEUE_TEST_OWNER_FILE) {
      intercepted = true;
      fs.writeFileSync(`${gate}.read`, data);
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(gate)) {
        if (Date.now() > deadline)
          throw new Error("Timed out waiting for the stale-owner read gate");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return data;
  };
}

const { runExclusive, runCommand } = require("../../lib/exclusive-run");
const run = options.unlocked ? runCommand : runExclusive;
run(options)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
