"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createProjectRoot, checkTarget } = require("../lib/project-root");
const { fakeSystem } = require("./helpers");

function hostWith(users) {
  const fake = fakeSystem({ users });
  fs.mkdirSync(fake.sys.paths.etcDir, { recursive: true });
  fs.writeFileSync(
    path.join(fake.sys.paths.etcDir, "claim.json"),
    JSON.stringify({
      userName: "alice",
      homePath: "/Users/alice",
      version: "0.24.0",
      port: 3000,
    }),
  );
  return fake;
}

const USERS = [
  { name: "alice", uid: 1001, gid: 1001, home: "/Users/alice" },
  { name: "bob", uid: 1002, gid: 1002, home: "/srv/bob" },
  { name: "root", uid: 0, gid: 0, home: "/root" },
];

test("paths in system directories, other homes and home roots are refused", async (t) => {
  const { sys, cleanup } = hostWith(USERS);
  t.after(cleanup);
  for (const target of [
    "/etc/demo",
    "/usr/local/work",
    "/root/x",
    "/var/lib/x",
    "/tmp/x",
    "/srv/bob",
    "/srv/bob/work",
    "/home/carol/work",
    "/Users/dave",
    "/home",
  ]) {
    await assert.rejects(
      createProjectRoot(target, sys),
      { code: "PATH_REFUSED" },
      target,
    );
  }
  for (const target of [
    "/",
    "relative/path",
    "/srv/work/../bob",
    "/srv/work/",
  ]) {
    await assert.rejects(
      createProjectRoot(target, sys),
      { code: "INVALID_PATH" },
      target,
    );
  }
});

test("refused before a claim", async (t) => {
  const { sys, cleanup } = fakeSystem({ users: USERS });
  t.after(cleanup);
  await assert.rejects(createProjectRoot("/srv/work/demo", sys), {
    code: "NOT_CLAIMED",
  });
});

test("/var/home is a home root, not a system directory", async (t) => {
  const users = [
    ...USERS,
    { name: "carol", uid: 1003, gid: 1003, home: "/var/home/carol" },
  ];
  const { sys, cleanup } = fakeSystem({ users });
  t.after(cleanup);
  const carol = users[users.length - 1];

  // The owner's own /var/home home is usable; /var is a system dir only
  // outside the home roots.
  await checkTarget("/var/home/carol/work/demo", carol, sys);
  await checkTarget("/var/home/carol", carol, sys);

  await assert.rejects(checkTarget("/var/home/dave/work", carol, sys), {
    code: "PATH_REFUSED",
  });
  await assert.rejects(checkTarget("/var/home", carol, sys), {
    code: "PATH_REFUSED",
  });
  await assert.rejects(checkTarget("/var/lib/demo", carol, sys), {
    code: "PATH_REFUSED",
  });
  await assert.rejects(checkTarget("/var", carol, sys), {
    code: "PATH_REFUSED",
  });
});
