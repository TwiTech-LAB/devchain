"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { BootstrapError, USER_NAME } = require("./validate");

const FENCE_TTL_MS = 30 * 60_000;
const OPERATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const fenceFile = (sys) => path.join(sys.paths.registryDir, "fence.json");

async function readFence(sys) {
  let raw;
  try {
    raw = await fs.readFile(fenceFile(sys), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  let fence;
  try {
    fence = JSON.parse(raw);
  } catch {
    throw new BootstrapError(
      409,
      "VM_FENCE_INVALID",
      "The VM destroy fence is invalid.",
    );
  }
  if (
    !fence ||
    typeof fence.ownerUser !== "string" ||
    !USER_NAME.test(fence.ownerUser) ||
    typeof fence.operationId !== "string" ||
    !OPERATION_ID.test(fence.operationId) ||
    !Number.isFinite(Date.parse(fence.expiresAt))
  ) {
    throw new BootstrapError(
      409,
      "VM_FENCE_INVALID",
      "The VM destroy fence is invalid.",
    );
  }
  return Date.parse(fence.expiresAt) <= sys.now().getTime() ? null : fence;
}

/** Call while holding the registry lock, before admitting a join. */
async function assertJoinAllowed(sys) {
  const fence = await readFence(sys);
  if (fence)
    throw new BootstrapError(
      409,
      "VM_DESTROY_PENDING",
      `This VM is being reset or destroyed by ${fence.ownerUser}. Try again after they finish.`,
    );
}

async function destroyFence(mode, operationId, sys) {
  if (!["set", "clear"].includes(mode) || !OPERATION_ID.test(operationId ?? ""))
    throw new BootstrapError(
      400,
      "INVALID_ARGUMENT",
      "Use --fence set|clear <operationId>.",
    );
  const owner = await require("./helper-instance").requireHelperInstance(sys);
  if (sys.paths.instanceUser)
    throw new BootstrapError(
      403,
      "VM_OWNER_REQUIRED",
      "Only the VM owner's instance can change the destroy fence.",
    );
  return sys.withHostLock(async () => {
    const current = await readFence(sys);
    if (mode === "clear") {
      if (
        current &&
        (current.ownerUser !== owner.userName ||
          current.operationId !== operationId)
      )
        throw new BootstrapError(
          409,
          "VM_FENCE_OPERATION_MISMATCH",
          "Another operation owns the VM destroy fence.",
        );
      await fs.rm(fenceFile(sys), { force: true });
      return { fence: null };
    }
    const fence = {
      ownerUser: owner.userName,
      operationId,
      expiresAt: new Date(sys.now().getTime() + FENCE_TTL_MS).toISOString(),
    };
    const temp = `${fenceFile(sys)}.tmp-${randomUUID()}`;
    try {
      await fs.writeFile(temp, `${JSON.stringify(fence)}\n`, {
        mode: 0o644,
        flag: "wx",
      });
      await fs.chmod(temp, 0o644);
      sys.chown(temp, 0, 0);
      await fs.rename(temp, fenceFile(sys));
    } finally {
      await fs.rm(temp, { force: true });
    }
    return { fence };
  });
}

module.exports = { FENCE_TTL_MS, readFence, assertJoinAllowed, destroyFence };
