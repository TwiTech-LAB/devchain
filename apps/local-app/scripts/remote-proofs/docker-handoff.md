# Docker handoff proof

## Machines, authorization and isolation

The proof uses source `.99` and target `.100`, exclusively through the approved
`ngsupb` account and sudo Docker. No user was added to the Docker group and no
`devchain-host.service` restart was performed. No live DevChain project, database
or Syncthing directory was mounted or modified. All test data uses disposable
`dc-*-ffe78fcf` resources and temporary directories. Product code is unchanged.

| Property | Source `.99` | Target `.100` |
| --- | --- | --- |
| Ubuntu | 24.04.4 | 24.04.2 |
| uid/gid | 1001/1001 | 1001/1001 |
| Docker Engine | 29.8.1 | 29.7.2 |
| API / minimum API | 1.56 / 1.40 | 1.55 / 1.40 |
| Compose | 5.5.1 | 5.5.1 |
| containerd | 2.3.6 | 2.3.6 |
| host service PID before setup | 5283 | 623 |

Both installs use Docker's official Ubuntu apt repository and the authorized
five packages: docker-ce, docker-ce-cli, containerd.io, docker-buildx-plugin and
docker-compose-plugin. Target engine/CLI were pinned to
`5:29.7.2-1~ubuntu.24.04~noble` to exercise a genuinely older API. Installation
used `DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l`; target also used
`--no-install-recommends --no-remove`.
[Official install procedure](https://docs.docker.com/engine/install/ubuntu/).

Target baseline: no Docker packages, `/var/lib/docker`, `/var/lib/containerd`,
Docker apt source or Docker keyring; 18,022,735,872 bytes free. After installation,
a temporary 512 MiB tmpfs was mounted at `/var/lib/docker` while Docker was
stopped. Only Docker was restarted. Containerd's image store remained on the root
filesystem. The target was returned to a Docker-free baseline for proof E; final verification
is below.

## Results and design decisions

| Point | Verdict for tested configurations | Required implementation decision |
| --- | --- | --- |
| A | GO: both PostgreSQL round trips; target reconnect/cancel mechanics tested | Pin auto-remove volumes before stop; inventory all holders; replace volumes by delete/recreate; deduplicate overlapping bind coverage. |
| B | GO: Compose reused imported container and anonymous-volume identities | Preserve captured Compose labels, image identity, mount identities and project/network mapping; revalidate other Compose versions/configurations. |
| C | GO: isolated live two-application sync substrate | Persist managed exclusions separately; install union before unpause; retain until final sync finishes; restore binds after initial sync. |
| D | GO: never-started helpers on both engines; separate Docker filesystem exercised | Preserve directory headers, numeric owners and tar content type; account for containerd separately from DockerRootDir. |
| F | GO: newer inspect projected into older create API; samples start | Use a reviewed create allowlist and negotiated API; do not silently drop application-required devices/socket/networking. |
| G | GO: two uncached >4-GiB loads, calibrated range and live correction | Use measured pipeline/load phases and live correction; a small probe alone cannot determine fit or duration. |

**NO-GO: rootless source Docker.** Its ownership mapping is unproven; Phase 20
must reject it until separately supported. **NO-GO: declaring arbitrary workloads
compatible after stripping required resources.** A synthetic process starting is
not an application correctness test; mark such containers cannot-move unless the
remaining configuration is known to work.

These are Engine 29.8.1→29.7.2 and Compose 5.5.1 observations, not guarantees for
all images, versions, storage drivers or host platforms.

## A and B — Data, Compose reuse and reconnect

```sh
python3 apps/local-app/scripts/remote-proofs/docker-roundtrip-proof.py ngsupb@192.168.1.100
```

The harness builds an offline image from locally cached `postgres:17-alpine`
with a marker file, exports/loads it without a registry push, and verifies equal
image IDs. It normalizes Compose with `docker compose config --format json`,
seeds PostgreSQL tables in Compose and `docker run`, stops both, transfers named
and anonymous volumes plus project binds, and creates the target containers in
`created` state. Nothing starts during import. The agent then runs Compose up
and Docker start before checking rows.

The first cross-engine run used API 1.55. Compose container ID remained equal,
and volume identities before/after up were exactly:

- Anonymous: `c800a37d519253b01b5528350053e1354b44fce882306609b6a84933080a86a6`.
- Named: `dc-roundtrip-ffe78fcf_db`.

Both target tables contained the seeded home row. A target row was added; after
stopping and copy-back both home tables contained the home and target rows.
The anonymous and auxiliary named-volume marker files and offline image marker
were verified after target start. Archive metadata comparisons cover numeric
owners, modes and symlinks. Overlapping `/project` and `/bind` sources share a
subtree; export skips duplicate child coverage while preserving both mount
settings. All participating source containers are stopped before shared data
is archived.

The extended run exercises a second Connect with a container newly created by
Compose holding the kept named volume and a VM-only file. The holder is removed,
the volume deleted/recreated, and current home data restored. The VM-only file
must be absent and the tables readable. A cancellation after destructive
replacement removes the attempt's helper/volume and restarts only the source
container that the operation stopped; the other stopped source stays stopped.
**Previously deleted VM copies are not recovered by this cancellation model.**
Phase 20 must disclose replacement loss; restoring the previous VM copy on cancel
would require additional staging or backups.

Additional small lifecycle/replacement reproductions:

```sh
python3 apps/local-app/scripts/remote-proofs/docker-source-proof.py
python3 apps/local-app/scripts/remote-proofs/docker-reconnect-proof.py
# The same scripts were copied to /tmp and run on .100 using the approved SSH user.
```

- Running `--rm -v /data`: `AutoRemove=true` original is removed on stop, but a
  never-started `AutoRemove=false` holder created **before stop** keeps its
  anonymous volume and data. Cleanup removes holder before volume. Phase 20 must
  establish the pin before stopping; otherwise classify data cannot-move.
- An unselected container holding a volume prevents deletion. Enumerate every
  holder and refuse destructive replacement when an unrelated holder remains.
- Compose-created holder with no DevChain label and a labelled external volume:
  deletion fails until that holder is removed. Replacement removes stale files.
- An unlabelled same-name volume is detected and retained by the harness's
  **policy check**. This is not an Engine conflict guarantee: Docker volume create
  can reuse an existing volume. Phase 20 must perform the ownership check itself.

## C — Syncthing exclusions

```sh
NODE_ENV=test node --expose-gc node_modules/jest/bin/jest.js \
  --config apps/local-app/scripts/remote-proofs/docker-sync.jest.cjs \
  --runInBand --forceExit
```

Three tests pass using `startTwoInstances`: real isolated DevChain applications,
SQLite databases, Syncthing processes and dynamic ports. The proof injects the
managed/user union at `FileSyncService.getIgnores`, because managed Docker
selection does not exist yet. It proves the transport/persistence substrate,
**not an implemented managed-ignore store**.

Verified: exclusions before first scan and during live sync; home and host app
restarts; excluded home files unchanged after Disconnect with no Docker copy-back;
project root and every intermediate directory owned by the fixture user; idle
before Disconnect pauses the folder. Paused folders report an empty state, so
idle is checked before pause. Reconnect with no exclusions replaces VM data with
home data. Changed bind choices remove one exclusion and keep another. A failure
injected after initial sync followed by the real Cancel endpoint removes both
shares while retaining excluded home data. A manually marked data subfolder
models a project-root bind; Alpine archive probes cover an image without VOLUME.

Phase 20 must persist exclusions separately from user ignores and recompute their
union before sharing/unpausing both sides. Create every bind parent as the VM user
after initial sync, before archive access. Phase 21 must keep exclusions through
final sync even when Docker copy-back is off. No live Syncthing was touched.

## D — Archives, ownership, sizing and filesystems

Both engines successfully used never-started helpers from the service's own
image. Calls use Unix-socket HTTP:

1. Create helpers mounting source and destination at `/data` or `/bind`.
2. `GET /v1.55/containers/{reader}/archive?path=/data` (or `/bind`).
3. `PUT /v1.55/containers/{writer}/archive?copyUIDGID=true&path=/`, with
   `Content-Type: application/x-tar` and the tar stream.
4. Read restored archives and compare directory/file metadata and symlink targets.

Both helper states remain `created`. Images declaring VOLUME can create extra
anonymous volumes even for these never-started helpers. Inventory every helper
mount immediately after create and distinguish newly created helper volumes
from existing/source/imported/holder volumes. Remove the helper **without**
`-v`/API `v=true`, then remove exactly the recorded helper-owned IDs. The final
harness also asserts protected volume IDs still exist after helper cleanup and
checks their data after start. The initial 12 source and 12 target leftovers are recorded by
exact ID and creation time in the evidence; only those confirmed IDs were removed. The
older cleanup run preserved its protected data in all marker and database checks,
and the entire affected cross-engine case was rerun using explicit ownership.
 Root-owned mount directory mode 0700,
nested uid/gid 1234/2345, file mode 0640 and `nested/file` symlink target survive.
The PostgreSQL service-image helpers also transferred database directories in
both directions and the restarted databases verified their rows.

Failed variants: default curl form content type returned success without expected
entries; `/data/.` extracted into `/data` retained contents but lost root-directory
mode (0755 instead of 0700). Preserve the directory header and set tar type.
Creating a helper alone did not materialize a missing bind path; archive access
did, including root-owned parents. Defer archive access until after
`file_sync_initial`, and precreate intermediate paths as the VM user.

The short read-only Alpine `du -sb /data` sizing container returned 8208 bytes for
the synthetic tree. Service images without compatible `du` need **unknown, at
least N** from observed archive bytes, not an invented exact size.

Both engines report `overlayfs` and
`driver-type=io.containerd.snapshotter.v1`. On .100:

| Data | Location / filesystem |
| --- | --- |
| Image content and unpacked snapshots | `/var/lib/containerd`, root LVM filesystem |
| Named/anonymous volumes and Docker metadata | `/var/lib/docker`, separate 512 MiB tmpfs |
| Project binds and test folders | `/tmp/dc-*`, root LVM filesystem |
| Client archive staging | No disk staging for streamed images; small data archives in harness memory |
| Engine's internal load staging | Included in root image-store peak measurements |

A fit check based only on `/info.DockerRootDir` is wrong for this Engine 29 setup.
Resolve the actual image store, each volume/bind and any explicit staging path to
its destination filesystem. Count distinct filesystems and shared data once;
retain unknown-size lower bounds and operating headroom.

## E — Docker installation option

[Coder (2)'s installation evidence](docker-handoff-e.md) owns this acceptance.
It remains a post-deployment user workflow. Task 1 removes its target Docker
installation/data before releasing .100 for that clean-install proof.

## F — Saved settings and API negotiation

```sh
python3 apps/local-app/scripts/remote-proofs/docker-settings-proof.py ngsupb@192.168.1.100
```

The source's newer inspect settings created a stopped container on the older
engine, then successfully started it with user 1234:2345, loopback dynamic port,
bind and named volume, `unless-stopped`, custom network and alias. Source has
maximum API 1.56, target 1.55, both minimum 1.40: use 1.55. In general choose the
smaller maximum only if it is at least both minimums; reject an empty interval.

Projection: Config at request root, selected HostConfig fields, and
`NetworkingConfig.EndpointsConfig` containing network names and aliases. Strip
inspect-only Id, Created, State, Path, Args, ResolvConfPath, HostnamePath,
HostsPath, LogPath, GraphDriver, Mounts, NetworkSettings and Size fields; derive
mount mappings separately. Do not replay endpoint/sandbox IDs or generated
MAC/IP/gateway state. The proof is not an exhaustive supported HostConfig list.

Synthetic Alpine sleep processes also start after individually dropping a device,
Docker socket bind, or host networking (using bridge). This says nothing about an
application that actually needs those resources: do not treat data-copy consent
as permission to alter required runtime settings.

## G — Greater-than-4-GiB streaming and estimates

The Epic Manager announced a quiet window; other agents deferred heavy checks.
Fresh free space before G: source 240,330,756,096 bytes; target root
17,561,309,184; target Docker tmpfs 536,645,632. Planned payload 4,311,744,512
bytes; conservative three-copy load budget plus 256 MiB overhead
13,203,668,992 bytes, leaving approximately 4.36 GB operating headroom.

```sh
nice -n 10 python3 apps/local-app/scripts/remote-proofs/docker-large-image.py
# Target: loopback-only proxy; use an approved SSH local forward from home.
sudo -n node /tmp/docker-stream-proof.mjs serve 0
node apps/local-app/scripts/remote-proofs/docker-stream-proof.mjs \
  copy http://127.0.0.1:TUNNEL_PORT dc-large-ffe78fcf:proof 4294967297
```

The generator streams random tar content directly into Docker import; it writes
no tar file. The client streams Docker save through Node fetch with
`duplex: 'half'` to `POST /images/load` through a loopback SSH tunnel. No client
archive file exists; Engine content-store/staging disk use is measured separately.
The 16 MiB probe is one input. Baseline export, backpressured export/transfer and
post-transfer load-response tail are separate measurements; export and transfer
overlap and must not be misleadingly added as independent serial phases.

| Measurement | First uncached load | Calibrated uncached repeat |
| --- | ---: | ---: |
| Bytes streamed | 4,313,068,544 | 4,313,068,544 |
| 16 MiB probe | 0.127 s | 0.119 s |
| Export baseline | 59.216 s | 61.125 s |
| Export + transfer pipeline | 68.064 s | 69.235 s |
| Load-response tail | 8.176 s | 8.527 s |
| Total transfer/load | 76.239 s | 77.762 s |
| Initial range | 59.216–275.882 s (load unknown) | 51.975–103.950 s (measured load) |

Between loads the target proof image was removed and containerd storage shrank to
12,579,600 bytes, restoring 17,561,374,720 free bytes. This was not an already
cached-image load. Both loaded image IDs matched the source. The calibrated run
uses measured export, prior pipeline and prior load tail, with the probe as a
secondary input. Its actual duration fell within the predicted range. At 60.04 s,
the live remaining-total range was 12.78–25.55 s; actual remainder was 17.72 s.
The first sub-second sample was unstable; the final harness waits five seconds
before emitting rate corrections. Raw observations retain that outlier rather
than hiding it. These timings are measurements of this LAN/image, not a general
throughput guarantee.

Disk polling every three seconds (149 samples) observed minimum free bytes:
source 231,671,332,864; target root 8,936,538,112; target Docker tmpfs 536,678,400.
The observed target root increase was about 8.625 GB, below the 13.204 GB budget.
Polling can miss shorter peaks; the fit decision retained conservative headroom.
Both large image tags/content were removed, and the proxy/tunnel were stopped
before the quiet window was closed.

## H — UID at claim

[Task 3 uid-at-claim evidence](docker-handoff-h.md) owns this acceptance.
Live acceptance remains pending and runs with the user after review.

## Evidence, validation and cleanup

[Machine-readable observations](docker-handoff-source-results.json) preserve
source/target probes, API negotiation, identities and timings. Scripts contain
only synthetic test settings; no real environment values or credentials are
recorded. Rootless remains unsupported.

- Source and target archive/lifecycle/settings/reconnect probes ran successfully.
- Two-engine offline-image/PostgreSQL round trip, extended reconnect/cancel and
  rule 11 ownership rerun passed. Old-run integrity observations are retained
  separately from the corrected ownership run.
- Three C integration tests pass; ts-jest compiles their TypeScript. The shared
  fixture requires `--forceExit`; no proof Syncthing/Jest process remained.
- JS syntax, Python syntax, Prettier and scoped ESLint are checked. Scripts are
  outside app tsconfig, so lint with `--parser-options '{"project":null}'` from
  `apps/local-app`. No full-product regression claim is made by this proof task.

Cleanup **complete**:

- Source: zero containers, zero volumes and zero custom networks. The large and
  offline proof images are removed. Only pulled `alpine:3.22` and
  `postgres:17-alpine` images remain, plus the tiny offline-build cache. Docker
  remains installed as authorized. Temporary raw logs are retained under
  `/tmp/devchain-docker-proof-ffe78fcf`; no live data is there.
- Target: all proof resources removed before purge. The temporary Docker tmpfs
  was unmounted; all five Docker packages are absent; `docker` is absent from
  PATH; `/var/lib/docker`, `/var/lib/containerd`, Docker apt source and keyring
  are absent. Proof scripts and apt logs in target `/tmp` were removed. No other
  account, project, service or credentials were changed. Ordinary apt dependency
  packages are not broadly autoremoved.
- Final target free space: 17,927,081,984 bytes. Both host services remain active
  at their original PIDs (source 5283, target 623). Both users retain only group
  1001. The G proxy, tunnel and disk sampler are stopped.

`docker-target-cleanup.sh` contains the exact guarded target cleanup procedure;
it was executed once against the recorded clean baseline. Do not rerun it on a
machine containing unrelated Docker data. No prune was used.

The final rule 11 rerun inventories every helper mount immediately. Per-helper
records distinguish created/protected/removed IDs, check protected volume
existence after cleanup, and verify marker/database contents after startup.
Separate source/target tests remove the last explicit anonymous-volume holder
**without** volume deletion and then recreate a holder: the original data remains.
Final fixture teardown removes its own synthetic data only after those assertions.
Exact ID reconciliation, including any helper-owned volume deferred to fixture
teardown, is in the machine-readable evidence.
