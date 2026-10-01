# VM provider connection contract

`POST /api/vm-providers` accepts a Proxmox connection with a SHA-256 leaf
`sslFingerprint`, a token ID and secret, and an optional `caPem` certificate
bundle. `caPem` is needed when the node's certificate is not trusted by the
system CA store. It is stored in `vm_provider_connections.ca_pem` and passed to
the shared Proxmox client's CA verification; the fingerprint check remains
active as a separate check. The token secret is encrypted in
`token_secret_ciphertext` using `IntegrationCredentialCipher` and a VM-provider
specific context.

`GET /api/vm-providers` and the create response include `caPem` and
`sslFingerprint` for connection management. They never include the token secret
or its ciphertext. `POST /api/vm-providers/:id/check` decrypts the secret only
inside the provider service and uses it with the CA and fingerprint checks.

The out-of-pool allocation check is read-only: it gets a free VMID from
`/cluster/nextid` and inspects effective `VM.Allocate` at `/vms/<vmid>`.
An invalid-VMID create request cannot prove confinement because Proxmox
validates its parameter schema before the create handler checks permissions.
A valid-VMID create request could create a VM when the token has excessive
rights. The read-only check fails closed if the next ID or ACL cannot be read.
It checks only the next-ID candidate; a grant on another VMID is outside this
check's scope.
See [Proxmox's create handler](https://github.com/proxmox/qemu-server/blob/master/src/PVE/API2/Qemu.pm)
and [REST parameter validation](https://github.com/proxmox/pve-common/blob/master/src/PVE/RESTHandler.pm).

The onboarding connection-string flow confirms the leaf fingerprint and uses
the confirmed trust material with the shared client's TLS verification before
it stores the connection or sends an authenticated API request. It must provide
the matching PEM when a self-signed node cannot pass system CA verification.
See `vm-provider.dto.ts`, `vm-providers.service.ts`, and
`proxmox-vm.provider.ts` for the wire and client mapping.

## Copy-paste onboarding

`GET /api/vm-providers/proxmox/setup-block` accepts `pool`, `storage`,
`imageStorage`, `bridge`, and `node`, then returns `{ block }` for the PVE root
shell. Empty `storage`, `imageStorage`, `bridge`, and `node` fields mean the
block discovers those values on the node with `pvesh`; the selection rules are
in `docs/proxmox.md` ("Copy-paste setup"). `pool` defaults to `devchain`.
Discovery and override checks run before any write, and a refusal lists the
valid choices. The generated commands target the Proxmox VE 8.x CLI. The block
preserves the image storage's configured content types and adds `import`; it
creates or updates the two DevChain roles and applies the scoped ACLs. Its
fake `pveum` and `pvesm` transcript test exercises first run, rerun, and
rotation; no live PVE host was available for this change.

The block creates `devchain@pve!agent` with privilege separation disabled and
prints the token secret only when creating the token or when called with
`--rotate`. A normal rerun preserves an existing token because Proxmox cannot
return its previous secret. To rotate from the pasted block, change its final
line to `devchain_proxmox_setup --rotate`. The URI includes the node's SHA-256
leaf fingerprint and, for the default node certificate, a base64-encoded
`ca` parameter containing the public PVE root CA certificate. The parser accepts
that optional parameter and persists the decoded trust material with the
connection; it never stores the full URI.

`POST /api/vm-providers/proxmox/connect` takes `{ connectionString }` first and
returns `{ confirmationRequired: true, fingerprint, placement }`, where
`placement` carries the parsed `apiUrl`, `node`, `pool`, `storage`,
`imageStorage`, and `bridge` for the dialog's confirmation preview. After the
user confirms that fingerprint, send the same string with
`confirmFingerprint: true`. The server then verifies TLS with both the CA and
leaf fingerprint before sending the token, stores the parsed fields and
encrypted token secret, runs the read-only permission check, and returns its
missing rights by name.

VM creation reads `HOST_IMAGE_URL` and `HOST_IMAGE_SHA256` from
`apps/local-app/src/common/config/env.config.ts`. The URL names a published
`devchain-host-<version>.qcow2` image; preflight checks its availability and
minimum supported version. The configured SHA-256 is sent to Proxmox for
verified import. See `proxmox-vm-lifecycle.service.ts` and
`create-vm.operation.ts`.

`POST /api/vm-providers/:id/create-vm` and `POST /api/remotes/:id/reset` return
persisted operations on the `remote-operations` progress channel. Reset keeps
the remote ID and name while replacing its VM identity and address, and
records forced detach losses in the operation details. Cancelling create
destroys only its guarded clone and leaves the addressless remote row so the
cancelled operation remains available for inspection; the existing remote
delete route can remove that row. See `vm-operations.controller.ts`,
`create-vm.operation.ts`, and `reset-vm.operation.ts`.
