"use strict";

/**
 * systemd EnvironmentFile syntax. Inside double quotes systemd honors
 * backslash escapes and does not expand variables.
 */
function renderEnvFile(env) {
  const lines = [
    "# Provider environment for devchain-host.service. Written at claim time.",
  ];
  for (const [key, value] of Object.entries(env)) {
    lines.push(`${key}="${value.replace(/[\\"`$]/g, (c) => `\\${c}`)}"`);
  }
  return `${lines.join("\n")}\n`;
}

/** `devchain-host.service` from the template; inputs are validated plain names and paths. */
function renderHostUnit(
  templateText,
  { userName, groupName, homePath, port, binDir, etcDir, syncthingPath },
) {
  const values = {
    USER: userName,
    GROUP: groupName,
    HOME: homePath,
    PORT: String(port),
    BIN: binDir,
  };
  let unit = templateText.replace(
    /@([A-Z]+)@/g,
    (match, key) => values[key] ?? match,
  );
  if (etcDir) {
    unit = unit
      .replace(/^Conflicts=.*\n/gm, "")
      .replace(
        /^ConditionPathExists=.*$/m,
        `ConditionPathExists=${etcDir}/claim.json`,
      )
      .replace(
        "[Service]\n",
        `[Service]\nEnvironment=DEVCHAIN_HOST_ETC_DIR=${etcDir}\nEnvironment=DEVCHAIN_HOST_BIN_DIR=${binDir}\nEnvironment=DEVCHAIN_HOST_SYNCTHING_BINARY=${syncthingPath}\nEnvironment=PATH=${binDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n`,
      );
  }
  return unit;
}

function renderJoinUnit(join, paths) {
  return `[Unit]
Description=DevChain join bootstrap for ${join.userName}
After=network-online.target
Wants=network-online.target
ConditionPathExists=!${paths.etcDir}/claim.json

[Service]
Type=simple
Environment=DEVCHAIN_BOOTSTRAP_PORT=${join.port}
ExecStart=${paths.helperPrefix}/bin/devchain-bootstrap --join ${join.userName}
Restart=on-failure
RestartSec=5
TimeoutStopSec=240
KillMode=mixed

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Passwordless sudo for the claimed user. The helper lines keep "Update VM"
 * and project helpers working if an admin later removes the blanket rule.
 */
function renderSudoers(userName, binDir) {
  return [
    "# DevChain host: written at claim time.",
    `${userName} ALL=(ALL) NOPASSWD:ALL`,
    `${userName} ALL=(root) NOPASSWD: ${binDir}/devchain-host-update, ${binDir}/devchain-host-project-root`,
    "",
  ].join("\n");
}

module.exports = {
  renderEnvFile,
  renderHostUnit,
  renderJoinUnit,
  renderSudoers,
};
