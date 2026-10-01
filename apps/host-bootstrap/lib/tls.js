"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { X509Certificate, createPrivateKey } = require("node:crypto");

/**
 * The VM's one TLS identity. The bootstrap serves it on port 3000 and the
 * claim copies it into the claimed user's home for DevChain, so home pins the
 * same certificate before and after the claim.
 */
const KEY_FILE = "key.pem";
const CERT_FILE = "cert.pem";
/** The name in the certificate's only SAN; clients pin the certificate, not the name. */
const CERT_NAME = "devchain-host";
const CERT_DAYS = 3650;
/** Environment names in host.env and devchain-host.service that point DevChain to the copy. */
const TLS_KEY_ENV = "DEVCHAIN_HOST_TLS_KEY_FILE";
const TLS_CERT_ENV = "DEVCHAIN_HOST_TLS_CERT_FILE";
/** The claimed user's copy of the identity, relative to their home. */
const USER_TLS_DIR = ".devchain/tls";

class TlsError extends Error {
  constructor(message) {
    super(message);
    this.code = "TLS_UNAVAILABLE";
  }
}

function tlsFiles(dir) {
  return {
    key: path.join(dir, KEY_FILE),
    cert: path.join(dir, CERT_FILE),
  };
}

/** `<home>/.devchain/tls/{key,cert}.pem`: the claimed user's copy. */
function userTlsFiles(homePath) {
  return tlsFiles(path.join(homePath, USER_TLS_DIR));
}

function readIfPresent(file) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new TlsError(`${file} is unreadable: ${error.message}`);
  }
}

/** Throws unless `key` and `cert` are one EC P-256 pair. */
function checkPair(key, cert, dir) {
  let certificate;
  let privateKey;
  try {
    certificate = new X509Certificate(cert);
    privateKey = createPrivateKey(key);
  } catch (error) {
    throw new TlsError(
      `The TLS files in ${dir} do not parse: ${error.message}`,
    );
  }
  if (
    privateKey.asymmetricKeyType !== "ec" ||
    privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1" ||
    !certificate.checkPrivateKey(privateKey)
  ) {
    throw new TlsError(
      `The TLS files in ${dir} are not one EC P-256 key and its certificate.`,
    );
  }
}

/**
 * The key and certificate in `dir` as PEM buffers, or null when neither file
 * exists. Anything else (one file, an unreadable file, a mismatched pair)
 * throws: the identity is never silently replaced.
 */
function readTlsDir(dir) {
  const files = tlsFiles(dir);
  const key = readIfPresent(files.key);
  const cert = readIfPresent(files.cert);
  if (!key && !cert) return null;
  if (!key || !cert) {
    throw new TlsError(
      `${dir} holds only ${key ? KEY_FILE : CERT_FILE}. Remove the directory to create a new certificate on an unclaimed VM, or reset the VM.`,
    );
  }
  checkPair(key, cert, dir);
  return { key, cert };
}

/** The VM's certificate; throws when it is missing or unusable. */
function loadTls(sys) {
  const tls = readTlsDir(sys.paths.tlsDir);
  if (!tls) {
    throw new TlsError(
      `${sys.paths.tlsDir} has no certificate; devchain-bootstrap --ensure-certificate creates it on an unclaimed VM.`,
    );
  }
  return tls;
}

/**
 * Creates the VM's certificate when the VM is unclaimed and has none, and
 * keeps an existing one. A claimed VM never gets a new certificate: home has
 * pinned the old one. Returns "kept" or "created".
 */
async function ensureCertificate(sys) {
  const dir = sys.paths.tlsDir;
  if (readTlsDir(dir)) return "kept";
  // The same test as devchain-bootstrap.service's condition: a claim record
  // exists, readable or not.
  if (fs.existsSync(path.join(sys.paths.etcDir, "claim.json"))) {
    throw new TlsError(
      `This VM is claimed and ${dir} has no certificate; a new one would not match the certificate home trusts. Reset the VM.`,
    );
  }
  const parent = path.dirname(dir);
  fs.mkdirSync(parent, { recursive: true, mode: 0o755 });
  // Built beside the target and renamed into place, so the directory is
  // either absent or complete.
  const staging = fs.mkdtempSync(path.join(parent, ".tls-"));
  try {
    const files = tlsFiles(staging);
    await sys.run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-sha256",
      "-days",
      String(CERT_DAYS),
      "-subj",
      `/CN=${CERT_NAME}`,
      "-addext",
      `subjectAltName=DNS:${CERT_NAME}`,
      "-keyout",
      files.key,
      "-out",
      files.cert,
    ]);
    fs.chmodSync(files.key, 0o600);
    fs.chmodSync(files.cert, 0o644);
    checkPair(fs.readFileSync(files.key), fs.readFileSync(files.cert), staging);
    fs.chmodSync(staging, 0o755);
    // rename replaces an empty directory and fails on a non-empty one.
    fs.renameSync(staging, dir);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return "created";
}

module.exports = {
  KEY_FILE,
  CERT_FILE,
  USER_TLS_DIR,
  TLS_KEY_ENV,
  TLS_CERT_ENV,
  CERT_NAME,
  TlsError,
  tlsFiles,
  userTlsFiles,
  readTlsDir,
  loadTls,
  ensureCertificate,
};
