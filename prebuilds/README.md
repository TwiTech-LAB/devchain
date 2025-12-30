This directory is reserved for native prebuilt binaries (e.g., better-sqlite3) packaged with releases.

In CI, populate architecture-specific artifacts under:
  prebuilds/<platform>-<arch>/better_sqlite3.node

At install-time, prebuild-install is used to fetch upstream prebuilds; when shipping first-party prebuilds, ensure they are included here and verified.

