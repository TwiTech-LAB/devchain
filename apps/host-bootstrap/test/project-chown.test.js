"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { repairProjectOwner } = require("../lib/project-chown");
const { fakeSystem } = require("./helpers");

function fixture(t) {
  const uid = process.getuid() + 1;
  const fake = fakeSystem({
    users: [{ name: "alice", uid, gid: uid, home: "/home/alice" }],
  });
  t.after(fake.cleanup);
  fs.mkdirSync(fake.sys.paths.etcDir, { recursive: true });
  fs.writeFileSync(
    path.join(fake.sys.paths.etcDir, "claim.json"),
    JSON.stringify({ userName: "alice" }),
  );
  const root = path.join(fake.root, "project");
  fs.mkdirSync(root);
  const file = path.join(root, "file");
  fs.writeFileSync(file, "source");
  return { ...fake, root, file, uid };
}
test("refuses outside paths, traversal, root/ancestor/target links and a folder in file mode", async (t) => {
  const f = fixture(t);
  const dir = path.join(f.root, "dir");
  fs.mkdirSync(dir);
  fs.symlinkSync(dir, path.join(f.root, "link"));
  fs.symlinkSync(f.file, path.join(f.root, "file-link"));
  fs.symlinkSync(f.root, path.join(f.root, "root-link"));
  for (const [root, target] of [
    [f.root, path.join(f.root, "../outside")],
    [f.root, `${f.root}/dir/../file`],
    [f.root, path.join(f.root, "link/child")],
    [f.root, path.join(f.root, "file-link")],
    [path.join(f.root, "root-link"), path.join(f.root, "root-link/file")],
    ["relative", f.file],
    [f.root, dir],
  ])
    await assert.rejects(repairProjectOwner(root, "--file", target, f.sys), {
      code: "CHOWN_REFUSED",
    });
  assert.equal(f.calls.length, 0);
});
test("file and directory repairs are nonrecursive and use no-dereference with the claimed ids", async (t) => {
  const f = fixture(t);
  const dir = path.join(f.root, "dir");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "child"), "data");
  await repairProjectOwner(f.root, "--file", f.file, f.sys);
  await repairProjectOwner(f.root, "--dir", dir, f.sys);
  assert.deepEqual(
    f.calls,
    [f.file, dir].map((target) => [
      "chown",
      "--no-dereference",
      `${f.uid}:${f.uid}`,
      "--",
      target,
    ]),
  );
});
test("tree prunes links, other devices, nested Git directories/files and refuses a repository tree root", async (t) => {
  const f = fixture(t);
  const tree = path.join(f.root, "new-package");
  fs.mkdirSync(tree);
  const source = path.join(tree, "source.ts");
  fs.writeFileSync(source, "source");
  fs.symlinkSync(f.file, path.join(tree, "outside-link"));
  for (const name of ["repository", "submodule", "mounted"]) {
    const folder = path.join(tree, name);
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "source.ts"), "source");
  }
  fs.mkdirSync(path.join(tree, "repository/.git"));
  fs.writeFileSync(path.join(tree, "repository/.git/HEAD"), "ref");
  fs.writeFileSync(path.join(tree, "submodule/.git"), "gitdir: elsewhere");
  const files = {
    ...fs,
    lstatSync: (target) => {
      const stat = fs.lstatSync(target);
      if (target === path.join(tree, "mounted"))
        Object.defineProperty(stat, "dev", { value: stat.dev + 1 });
      return stat;
    },
  };
  const result = await repairProjectOwner(f.root, "--tree", tree, f.sys, files);
  assert.deepEqual(result.changed, [tree, source]);
  for (const target of [
    path.join(tree, "repository"),
    path.join(tree, "submodule"),
  ])
    await assert.rejects(repairProjectOwner(f.root, "--tree", target, f.sys), {
      code: "CHOWN_REFUSED",
    });
});
test("a partial tree failure reports completed repairs so retry can finish", async (t) => {
  const f = fixture(t);
  const tree = path.join(f.root, "package");
  fs.mkdirSync(tree);
  fs.writeFileSync(path.join(tree, "source.ts"), "source");
  let call = 0;
  f.sys.run = async () => {
    if (++call === 2) throw new Error("chown failed");
  };
  await assert.rejects(
    repairProjectOwner(f.root, "--tree", tree, f.sys),
    (error) => {
      assert.deepEqual(error.changed, [tree]);
      return true;
    },
  );
});
