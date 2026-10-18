"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

/** Holds a kernel flock across asynchronous registry work, released on process death. */
async function withFileLock(file, action) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
  const handle = await fs.open(file, "a", 0o600);
  await handle.close();
  const holder = spawn(
    "flock",
    // The holder reports the lock, then keeps it until its stdin closes.
    ["--exclusive", file, "sh", "-c", "echo locked; exec cat >/dev/null"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let locked = false;
  const exited = new Promise((resolve) => holder.once("close", resolve));
  try {
    await new Promise((resolve, reject) => {
      holder.once("error", reject);
      holder.once("exit", () => {
        if (!locked)
          reject(new Error("Cannot acquire the DevChain host lock."));
      });
      holder.stdout.once("data", () => {
        locked = true;
        resolve();
      });
    });
    return await action();
  } finally {
    holder.stdin.end();
    if (!locked) holder.kill();
    await exited;
  }
}

module.exports = { withFileLock };
