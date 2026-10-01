# Docker handoff proof E — VM option

## Status

**Live acceptance pending user deployment.** No Docker installation or service restart was performed on the target during implementation. Ubuntu `.100` (`192.168.1.100`, remote prefix `f6dd483a`) is the authorized target; `.99` and home are excluded. Debian 12 has not been provided and is **not yet proven**.

The coordinated target order is Task 1 first, followed by its recorded removal of proof Docker packages/data/repository/keyring to restore a clean baseline; that work and target access are not claimed here. Confirm the clean baseline before E.

Per the coordinated execution decision, review happens first. The user owns commit, publish, home restart and Update VM deployment. Proof E then uses the normal Cloud/API **Install Docker** operation. There is no approved shell transport to `.100`; do not create one or modify SSH authentication for this proof.

Read-only setup observations: `.100` answered `/api/runtime` with version `0.23.4-p9.7`; its project and session lists were empty. The available SSH identity was refused. The existing Proxmox environment credential reference returned HTTP 401 after certificate fingerprint verification. Access probing stopped at the coordination decision; no target mutation or handoff occurred.

## Local implementation evidence

- `apps/host-bootstrap/test/docker.test.js`: detached request, official Ubuntu/Debian apt source construction, package list, apt-lock retry, existing usable Engine/Compose, conflicting distro packages, failure/retry and group-before-restart ordering. These use fake commands and temporary files; they are not live distribution proofs.
- `src/modules/remotes/operations/host-operations.integration.spec.ts`: real persisted runner/client with a fake HTTP VM; opt-in Setup, Create VM and Host Install, same-version Docker enable, combined version/Docker ordering, usable existing Docker, and unchanged-version refusal.
- `src/modules/remotes/operations/vm-operations.integration.spec.ts`: Reset retains the saved option.
- `src/modules/remotes/operations/docker.step.spec.ts`: lost response, stale failed job, retry, unchanged boot rejection and process-group readiness.
- `src/modules/core/controllers/docker-runtime.spec.ts` and `runtime.controller.spec.ts`: cached versions, bounded socket probes, socket recovery, missing Compose, unreadable data root and runtime response compatibility.
- Host helper/controller, remote health and Cloud dialog/row tests cover the manual migration error, request validation, health independence, off-by-default choices, same-version action and badge.

Run from the repository root:

```sh
node --test apps/host-bootstrap/test/*.test.js
pnpm --filter local-app exec jest --selectProjects backend-unit backend-integration ui --runInBand --runTestsByPath \
  src/modules/remotes/operations/docker.step.spec.ts \
  src/modules/remotes/operations/host-operations.integration.spec.ts \
  src/modules/remotes/operations/vm-operations.integration.spec.ts \
  src/modules/remotes/operations/remote-operations.service.spec.ts \
  src/modules/remotes/operations/remote-operations.controller.spec.ts \
  src/modules/remotes/operations/remote-host.client.spec.ts \
  src/modules/remotes/controllers/remotes.controller.spec.ts \
  src/modules/core/controllers/docker-runtime.spec.ts \
  src/modules/core/controllers/runtime.controller.spec.ts \
  src/modules/remotes/host/host-helper.service.spec.ts \
  src/modules/remotes/host/host-update.controller.spec.ts \
  src/modules/remotes/services/remote-health.service.spec.ts \
  src/ui/pages/cloud/CreateVmDialog.spec.tsx \
  src/ui/pages/cloud/SetupVmDialog.spec.tsx \
  src/ui/pages/cloud/HostInstallDialog.spec.tsx \
  src/ui/pages/cloud/RemoteVmSection.spec.tsx
```

## Live acceptance to record after deployment

1. Confirm the target has no agent sessions, home/host versions match, and Docker is absent. Record target OS, version and process boot ID.
2. If the host helper is old, verify `HOST_HELPER_OUTDATED` names the one-manual-migration command from `docs/remote-projects.md`. Follow the user's deployment procedure to refresh it.
3. Choose **Install Docker** on the target row. Record POST latency, persisted operation steps, Docker job ID and status transitions. Expect no DevChain version-install step at the same version.
4. Verify the step remains running until the job is done and the restarted `/api/runtime` reports a different boot ID, installed Engine/Compose and actual Docker group membership. Verify unprivileged socket access from that restarted service process.
5. Exercise an apt lock held by another process and a lost request reply using an approved test transport. Record eventual completion without replacing distro packages, losing the option or duplicating active installs.
6. Verify an already usable Engine/Compose takes the no-install path and a failed apt attempt can be retried. Test a version change plus Docker opt-in separately: version install/restart first, Docker install/restart second.
7. Repeat on a user-provided Debian 12 VM. Until then, leave Debian marked not yet proven.

Retain timestamps and redacted status/runtime results here. Never record credentials, repository key contents or provider auth. The existing-usable case is a second enable on `.100` after its clean install: record no apt install and no second restart. If both the saved option and runtime are already current, Update VM refuses the no-change request with `REMOTE_VERSION_CURRENT` (this is not a successful second operation); an existing usable installation whose option is newly saved completes without invoking the helper. `.99` is excluded from every E case.

A failure leaves installed packages in place for retry; do not remove Docker data as cleanup.


## Review verification

Local verification passed: 84 host-bootstrap tests; 16 focused Jest suites (236 tests across the regression run and the corrected controller/client/UI follow-up); TypeScript `tsc --noEmit`; ESLint with `--fix` on changed TypeScript/TSX; Prettier on changed code files; Local App build; `madge:check` (no cycles); and `git diff --check`.

The distinct existing-usable/no-change cases are in `apps/local-app/src/modules/remotes/operations/host-operations.integration.spec.ts`, test `accepts existing usable Docker without an install when enabling the saved option`. Its first operation saves the choice and succeeds with zero Docker helper requests; its second operation returns `REMOTE_VERSION_CURRENT`, also with zero requests. Neither is live evidence.
