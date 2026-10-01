"use strict";

const path = require("node:path");
const {
  KEY_FILE,
  CERT_FILE,
  USER_TLS_DIR,
  TLS_KEY_ENV,
  TLS_CERT_ENV,
} = require("./tls");

/** A refused request; `status` and `code` become the HTTP answer. */
class BootstrapError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const invalid = (message) => new BootstrapError(400, "INVALID_CLAIM", message);

const USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Linux homes and macOS-style homes, so stored absolute paths stay valid on the VM. */
const HOME_ROOTS = ["/home", "/Users", "/var/home"];
const REFUSED_HOME_FILES = [
  ".claude/.credentials.json",
  ".devchain/host.env",
  `${USER_TLS_DIR}/${KEY_FILE}`,
  `${USER_TLS_DIR}/${CERT_FILE}`,
];
/** Set by systemd or DevChain itself; a provider env must not replace them. */
const RESERVED_ENV_KEYS = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "HOST",
  "PORT",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  TLS_KEY_ENV,
  TLS_CERT_ENV,
]);
const MAX_ENV_VALUE_BYTES = 16 * 1024;
const MAX_FILES = 32;
const MAX_FILE_BYTES = 256 * 1024;
/**
 * The claiming home's own uid, so containers running as that uid can write
 * mounted project files. 500 keeps macOS accounts (from 501) claimable;
 * 60000 is useradd's regular-account ceiling. An integer outside the range
 * (a directory-service or systemd-homed account) is dropped, never refused:
 * home sends its uid automatically, so the claim must still succeed.
 */
const MIN_CLAIM_UID = 500;
const MAX_CLAIM_UID = 60000;

function isSemver(value) {
  return typeof value === "string" && SEMVER.test(value);
}

/** An absolute path in normal form whose segments are plain names. */
function isPlainAbsolutePath(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.length > 4096
  )
    return false;
  if (path.posix.normalize(value) !== value || value.endsWith("/"))
    return false;
  const segments = value.split("/").slice(1);
  return segments.every((s) => PATH_SEGMENT.test(s) && s !== "." && s !== "..");
}

function isInside(child, parent) {
  return child.startsWith(`${parent}/`);
}

function validateHomePath(value) {
  if (
    !isPlainAbsolutePath(value) ||
    !HOME_ROOTS.some((root) => isInside(value, root))
  ) {
    throw invalid(
      `homePath must be a plain absolute path under ${HOME_ROOTS.join(", ")}.`,
    );
  }
  return value;
}

function validateEnv(env) {
  if (env === undefined) return {};
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    throw invalid("providerAuth.env must be an object of strings.");
  }
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY.test(key) || RESERVED_ENV_KEYS.has(key)) {
      throw invalid(
        `providerAuth.env key ${JSON.stringify(key)} is not allowed.`,
      );
    }
    if (typeof value !== "string" || /[\0\r\n]/.test(value)) {
      throw invalid(`providerAuth.env.${key} must be a single-line string.`);
    }
    if (Buffer.byteLength(value) > MAX_ENV_VALUE_BYTES) {
      throw invalid(`providerAuth.env.${key} is too long.`);
    }
    out[key] = value;
  }
  return out;
}

function parseMode(mode) {
  if (mode === undefined) return 0o600;
  const parsed =
    typeof mode === "string" && /^0?[0-7]{3}$/.test(mode)
      ? parseInt(mode, 8)
      : mode;
  // Credential files stay private to the user.
  if (parsed !== 0o600 && parsed !== 0o400) {
    throw invalid("providerAuth.files[].mode must be 0600 or 0400.");
  }
  return parsed;
}

function validateFiles(files, homePath) {
  if (files === undefined) return [];
  if (!Array.isArray(files) || files.length > MAX_FILES) {
    throw invalid(
      `providerAuth.files must be an array of at most ${MAX_FILES} entries.`,
    );
  }
  // A stored Claude login would take precedence over CLAUDE_CODE_OAUTH_TOKEN.
  const refused = new Set(
    REFUSED_HOME_FILES.map((file) => `${homePath}/${file}`),
  );
  const seen = new Set();
  return files.map((file, index) => {
    const where = `providerAuth.files[${index}]`;
    if (file === null || typeof file !== "object")
      throw invalid(`${where} must be an object.`);
    if (!isPlainAbsolutePath(file.path) || !isInside(file.path, homePath)) {
      throw invalid(
        `${where}.path must be a plain absolute path inside homePath.`,
      );
    }
    if (refused.has(file.path)) throw invalid(`${where}.path is not allowed.`);
    if (seen.has(file.path)) throw invalid(`${where}.path is listed twice.`);
    seen.add(file.path);
    if (
      typeof file.contentBase64 !== "string" ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(file.contentBase64)
    ) {
      throw invalid(`${where}.contentBase64 must be base64.`);
    }
    const content = Buffer.from(file.contentBase64, "base64");
    if (content.length > MAX_FILE_BYTES)
      throw invalid(`${where} is too large.`);
    return { path: file.path, mode: parseMode(file.mode), content };
  });
}

/**
 * Checks a claim body and returns it normalized. Error messages name fields,
 * never values: the body carries provider credentials.
 */
function validateClaim(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw invalid("The claim body must be a JSON object.");
  }
  const { userName, homePath, uid, version, port, providerAuth = {} } = body;
  if (typeof userName !== "string" || !USER_NAME.test(userName)) {
    throw invalid(
      "userName must be a POSIX user name (lowercase, at most 32 characters).",
    );
  }
  validateHomePath(homePath);
  if (uid !== undefined && !Number.isInteger(uid)) {
    throw invalid("uid must be an integer.");
  }
  const claimUid =
    uid !== undefined && uid >= MIN_CLAIM_UID && uid <= MAX_CLAIM_UID
      ? uid
      : undefined;
  if (!isSemver(version)) throw invalid("version must be a semantic version.");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw invalid("port must be an integer from 1024 to 65535.");
  }
  if (
    providerAuth === null ||
    typeof providerAuth !== "object" ||
    Array.isArray(providerAuth)
  ) {
    throw invalid("providerAuth must be an object.");
  }
  return {
    userName,
    homePath,
    ...(claimUid !== undefined ? { uid: claimUid } : {}),
    version,
    port,
    env: validateEnv(providerAuth.env),
    files: validateFiles(providerAuth.files, homePath),
  };
}

module.exports = {
  BootstrapError,
  USER_NAME,
  HOME_ROOTS,
  MIN_CLAIM_UID,
  MAX_CLAIM_UID,
  REFUSED_HOME_FILES,
  validateClaim,
  isSemver,
  isPlainAbsolutePath,
  isInside,
};
