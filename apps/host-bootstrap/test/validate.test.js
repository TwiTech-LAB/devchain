"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateClaim } = require("../lib/validate");

const base = {
  userName: "alice",
  homePath: "/Users/alice",
  version: "0.24.0",
  port: 3000,
};
const b64 = (text) => Buffer.from(text).toString("base64");

function refused(body, pattern) {
  assert.throws(
    () => validateClaim(body),
    (error) =>
      error.status === 400 &&
      error.code === "INVALID_CLAIM" &&
      pattern.test(error.message),
  );
}

test("accepts Linux and macOS-style homes and defaults providerAuth", () => {
  assert.deepEqual(validateClaim(base), { ...base, env: {}, files: [] });
  assert.equal(
    validateClaim({ ...base, homePath: "/home/alice" }).homePath,
    "/home/alice",
  );
});

test("refuses user names, homes, versions and ports outside the contract", () => {
  refused({ ...base, userName: "Alice" }, /userName/);
  refused({ ...base, userName: "a".repeat(33) }, /userName/);
  refused({ ...base, homePath: "Users/alice" }, /homePath/);
  refused({ ...base, homePath: "/Users/../etc" }, /homePath/);
  refused({ ...base, homePath: "/opt/alice" }, /homePath/);
  refused({ ...base, homePath: "/Users" }, /homePath/);
  refused({ ...base, homePath: "/Users/al ice" }, /homePath/);
  refused({ ...base, version: "latest" }, /version/);
  refused({ ...base, version: "1.2" }, /version/);
  refused({ ...base, port: 80 }, /port/);
  refused({ ...base, port: "3000" }, /port/);
});

test("accepts provider env and files inside the home", () => {
  const claim = validateClaim({
    ...base,
    providerAuth: {
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-"quoted"$x' },
      files: [
        {
          path: "/Users/alice/.codex/auth.json",
          mode: "0600",
          contentBase64: b64("{}"),
        },
      ],
    },
  });
  assert.deepEqual(claim.env, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-"quoted"$x' });
  assert.equal(claim.files[0].mode, 0o600);
  assert.equal(claim.files[0].content.toString(), "{}");
});

test("refuses reserved env keys, multi-line values and files outside the home", () => {
  refused({ ...base, providerAuth: { env: { PATH: "/tmp" } } }, /PATH/);
  refused(
    { ...base, providerAuth: { env: { XDG_RUNTIME_DIR: "/run/user/1" } } },
    /XDG_RUNTIME_DIR/,
  );
  refused({ ...base, providerAuth: { env: { TOKEN: "a\nb" } } }, /single-line/);
  for (const key of [
    "DEVCHAIN_HOST_TLS_KEY_FILE",
    "DEVCHAIN_HOST_TLS_CERT_FILE",
  ]) {
    refused(
      { ...base, providerAuth: { env: { [key]: "/tmp/x.pem" } } },
      new RegExp(key),
    );
  }
  const file = (over) => ({
    ...base,
    providerAuth: {
      files: [{ path: "/Users/alice/x", contentBase64: b64("x"), ...over }],
    },
  });
  refused(file({ path: "/Users/bob/.codex/auth.json" }), /inside homePath/);
  refused(file({ path: "/Users/alice/../bob/x" }), /inside homePath/);
  refused(
    file({ path: "/Users/alice/.claude/.credentials.json" }),
    /not allowed/,
  );
  refused(file({ path: "/Users/alice/.devchain/host.env" }), /not allowed/);
  refused(file({ path: "/Users/alice/.devchain/tls/key.pem" }), /not allowed/);
  refused(file({ path: "/Users/alice/.devchain/tls/cert.pem" }), /not allowed/);
  refused(file({ mode: 0o644 }), /mode/);
  refused(file({ contentBase64: "not base64!" }), /base64/);
});

test("accepts an optional uid and drops one outside the account range", () => {
  assert.equal(validateClaim({ ...base, uid: 501 }).uid, 501);
  assert.equal(validateClaim({ ...base, uid: 1000 }).uid, 1000);
  assert.equal(validateClaim({ ...base, uid: 60000 }).uid, 60000);
  assert.equal("uid" in validateClaim(base), false);
  // Directory-service and systemd-homed uids must not block the claim.
  for (const uid of [0, 499, 60001, 70000, 1587600513]) {
    assert.equal("uid" in validateClaim({ ...base, uid }), false, String(uid));
  }
  refused({ ...base, uid: 1000.5 }, /uid/);
  refused({ ...base, uid: "1000" }, /uid/);
});

test("error messages never echo values", () => {
  try {
    validateClaim({
      ...base,
      providerAuth: { env: { TOKEN: "secret-value\n" } },
    });
    assert.fail("expected a refusal");
  } catch (error) {
    assert.doesNotMatch(error.message, /secret-value/);
  }
});
