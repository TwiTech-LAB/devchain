# Bundled node-pty prebuilds

This directory contains the package-owned copy of `node-pty` prebuilt artifacts for users
without native build tools. The root build runs `scripts/copy-prebuilds.js`, which copies the
installed package's artifacts into:

```text
prebuilds/node-pty/<platform>-<arch>/
```

During installation, `scripts/postinstall.js` restores the matching platform directory into
`node_modules/node-pty/prebuilds` when it is not already present.

`better-sqlite3` artifacts do not belong here. Version 13 ships its Node-API binaries inside
the dependency package; DevChain's postinstall step only verifies that the installed artifact
can open, query, and close an in-memory database.
