"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { readClaim } = require("./claim");
const { BootstrapError } = require("./validate");

const refuse = (message) => new BootstrapError(403, "CHOWN_REFUSED", message);
function absolute(value) {
  return (
    typeof value === "string" &&
    path.isAbsolute(value) &&
    !/[\0\r\n]/.test(value) &&
    !value.split("/").some((part) => part === ".." || part === ".") &&
    path.normalize(value) === value
  );
}
function checked(root, target) {
  if (
    !absolute(root) ||
    !absolute(target) ||
    root === "/" ||
    !(target === root || target.startsWith(root + "/"))
  )
    throw refuse(
      "Use absolute paths inside the project root without traversal.",
    );
  let current = "/";
  for (const segment of target.split("/").slice(1)) {
    current = path.join(current, segment);
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink())
      throw refuse("Ownership paths must not contain links.");
    if (
      current.startsWith(root + "/") &&
      (segment === ".git" || (current !== target && hasGit(current)))
    )
      throw refuse("Ownership paths must not enter another repository.");
  }
  if (!fs.lstatSync(root).isDirectory())
    throw refuse("The root must be a folder.");
  return fs.lstatSync(target);
}
function hasGit(folder) {
  try {
    fs.lstatSync(path.join(folder, ".git"));
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

async function repairProjectOwner(root, mode, target, sys, files = fs) {
  const claim = readClaim(sys);
  const owner = claim && (await sys.lookupUser(claim.userName));
  if (!owner)
    throw new BootstrapError(
      409,
      "NOT_CLAIMED",
      "The claimed user is missing.",
    );
  if (!["--file", "--dir", "--tree"].includes(mode))
    throw refuse("Unknown ownership mode.");
  const info = checked(root, target);
  if (mode === "--file" ? !info.isFile() : !info.isDirectory())
    throw refuse(
      mode === "--file"
        ? "The target must be a regular file."
        : "The target must be a folder.",
    );
  if (mode === "--tree" && hasGit(target))
    throw refuse("The selected tree is a repository.");
  const device = fs.lstatSync(root).dev;
  const changed = [];
  const change = async (item) => {
    const current = checked(root, item);
    if (current.dev !== device || (!current.isFile() && !current.isDirectory()))
      return;
    if (current.uid === owner.uid) return;
    await sys.run("chown", [
      "--no-dereference",
      `${owner.uid}:${owner.gid}`,
      "--",
      item,
    ]);
    changed.push(item);
  };
  const walk = async (item) => {
    const current = files.lstatSync(item);
    if (current.isSymbolicLink() || current.dev !== device) return;
    if (current.isDirectory()) {
      if (hasGit(item)) return;
      await change(item);
      for (const name of files.readdirSync(item))
        await walk(path.join(item, name));
    } else if (current.isFile()) await change(item);
  };
  if (info.dev !== device)
    throw refuse("The target is on another file system.");
  try {
    if (mode === "--tree") await walk(target);
    else await change(target);
  } catch (error) {
    error.changed = changed;
    throw error;
  }
  return { changed };
}

module.exports = { repairProjectOwner };
