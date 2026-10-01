# Docker handoff proof H — the VM user gets this PC's uid

## Status

**Live acceptance pending, run with the user after review** (as Phase 13 was).
The image that carries this change is not built or published: building,
publishing and the new-image Proxmox deployment are the user's release steps,
and no VM ids were changed during implementation. Record every result of the
run below in this file.

Scope: the claim uid (`apps/host-bootstrap`), the real ids in
`/api/runtime` and the remote health state, the no-default-user image config
(`users: []`, image version 1.2.0 onward) and the two acceptance scripts.
The Phase 20 Connect warning that consumes the uid is out of scope here.

## Local implementation evidence

- `apps/host-bootstrap/test/claim.test.js`: a free uid is passed to
  `useradd -u <uid> -U` for a free uid >=1000; a uid below 1000 or one another account holds falls back to the plain
  command; a retry after a partial creation keeps the uid the first attempt
  gave, including a 501 request that allocates a regular Linux uid; an existing account keeps its ids when a later claim names a uid. Existing system accounts remain refused.
- `apps/host-bootstrap/test/validate.test.js`: the optional claim `uid`
  (500–60000) is accepted and out-of-range values refused; an absent uid keeps
  the old contract, which is also what an old image's validator does to the
  new field.
- `src/modules/core/controllers/runtime.controller.spec.ts`: `/api/runtime`
  reports the real `process.getuid()`/`getgid()` — the source of truth when an
  old bootstrap dropped the claim field.
- `src/modules/remotes/services/remote-health.service.spec.ts`: the remote
  health state keeps the runtime's uid/gid and falls back to null when an
  older remote reports none.
- `src/modules/remotes/operations/host-operations.integration.spec.ts`: the
  claim request carries this PC's uid; an old-validator fixture ignores it and home health plus GET /api/remotes expose the runtime's different actual uid/gid.
- `src/common/test/fake-bootstrap.server.ts`: the claimed fake reports uid/gid
  as a claimed host does.
- `apps/host-image/verify.sh` and `apps/host-bootstrap/e2e/claim-vm.sh` were
  rewritten for the no-default-user image; both need a KVM build host and are
  part of the live acceptance below, not CI.

Run from the repository root:

```sh
node --test apps/host-bootstrap/test/*.test.js
pnpm --filter local-app exec jest --selectProjects backend-unit backend-integration --runInBand --runTestsByPath \
  src/modules/core/controllers/runtime.controller.spec.ts \
  src/modules/remotes/services/remote-health.service.spec.ts \
  src/modules/remotes/controllers/remotes.controller.spec.ts \
  src/modules/remotes/operations/host-operations.integration.spec.ts \
  src/modules/remotes/operations/vm-operations.integration.spec.ts \
  src/modules/remotes/operations/remote-host.client.spec.ts
```

Prior implementing run (2026-09-27): `vm-providers.two-instance` could not
bind `127.0.0.2:3000` while the live service held `0.0.0.0:3000`. It has NOT
been rerun successfully on a free-port machine; that is an expected remediation,
not executed evidence. The prior handoff separately reports the HOST-sensitive
suites passing with `env -u HOST`, `host-install-block` passing after the
reported node-path repair, and `host-provider-auth` passing on retry. No broad
suite was rerun for this revision, and no additional system changes were made.

The KVM claim script uses fixed fixture UID 1000, not this PC's measured uid.
The actual-PC claim in step 5 is separate. Image version 1.2.0 is a pending
build-time release requirement, not an existing built artifact.

Revision checks executed locally (2026-09-27):

- `node --test apps/host-bootstrap/test/claim.test.js apps/host-bootstrap/test/validate.test.js apps/host-bootstrap/test/image-verify.test.js`: 29 passed before adding two readiness smoke cases; the final `image-verify.test.js` run passed all 5 cases. This covers 31 distinct tests in the final files.
- Focused Jest: runtime controller, remote health and remotes controller suites passed; host-operations passed all 32 tests after correcting the new fixture's claim input (85 distinct tests across the four suites).
- Local-app `tsc --noEmit`, ESLint for the two revised TypeScript files, Prettier for revised JS/TS files, `bash -n` for both scripts and `git diff --check` passed.
- Shell smoke executes the verification script's actual guest shell/CLI expression locally: success returns 0, missing command 127, and a command printing output then exiting 42 retains 42. Cloud-init gate smoke confirms checks continue only on success. These are not live image acceptance.

## Live acceptance checklist (record after the user deploys)

1. Build the image from this change under a new version (1.2.0 or later):
   `make -C apps/host-image image VERSION=<v>`. Record version, qcow2
   sha256, and that `users: []` is in the built `90-devchain.cfg`.
2. Run `apps/host-image/verify.sh <image>` on a KVM host. Expected: every
   check passes, including "no default user", "uid 1000 is free" and the two
   sshd refusals; nothing logs in.
3. Publish per the user's release procedure and create a VM on Proxmox
   (Create VM passes no `ciuser`/`sshkeys`). Record: the disk grows to the
   VM disk (`df /`), the host name is set, the guest agent reports the IP.
4. Pre-claim state over HTTP: `/api/runtime` answers `unclaimed` with the new
   image version. SSH with any account is refused (console fallback only).
5. Claim from home. Record: the claim request body carried this PC's uid; the
   claim succeeded; for a free PC uid >=1000, VM `id -u <user>` equals it
   (`id -g <user>` matches when the group number is free). Below 1000 or an
   occupied uid uses normal Linux allocation; record the actual ids. The home
   and `.ssh`-style claim files (if shipped) are owned by the allocated user.
6. After the claim: `/api/runtime` on the VM reports the same `uid`/`gid`,
   and home's remote health state (`GET /api/remotes`) exposes them.
7. Optional, records the compatibility path: claim an old-image VM (uid 1000
   taken or validator drops the field); the user gets the next free uid and
   `/api/runtime` reports the real ids. The Phase 20 warning is not part of H.
8. Run `apps/host-bootstrap/e2e/claim-vm.sh` against a KVM boot of the new
   image with two verdaccio-published CLI builds. Expected: every check
   passes, including the pre-claim SSH refusal, fixture uid/gid 1000 checks and the
   runtime uid report.

## Results

| Step | Result | Evidence |
| --- | --- | --- |
| 1–8 | pending | run with the user after review |
