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
  { userName, groupName, homePath, port, binDir },
) {
  const values = {
    USER: userName,
    GROUP: groupName,
    HOME: homePath,
    PORT: String(port),
    BIN: binDir,
  };
  return templateText.replace(
    /@([A-Z]+)@/g,
    (match, key) => values[key] ?? match,
  );
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
    `${userName} ALL=(root) NOPASSWD: ${binDir}/devchain-host-project-chown`,
    "",
  ].join("\n");
}

module.exports = { renderEnvFile, renderHostUnit, renderSudoers };
