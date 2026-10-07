const {
  LocalApiHttpError: HostInstallHttpError,
  POLL_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  getOperation,
  printOperationSteps,
  requestJson,
  writeLine,
} = require("./local-api");
const fs = require("node:fs/promises");
const readline = require("node:readline");
const { homedir, userInfo } = require("node:os");
const { join, resolve } = require("node:path");
const { StringDecoder } = require("node:string_decoder");

const PROVIDERS = ["claude", "copilot", "codex", "agy", "opencode"];
const GENERATABLE_PROVIDERS = new Set(["copilot", "codex", "agy", "opencode"]);
const REUSE_CHOICE = /^reuse:([0-9a-f-]{36})$/i;
const USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
const HOME_ROOT = /^\/(home|Users|var\/home)\//;
const ESTIMATE_REQUEST_TIMEOUT_MS = 75_000;

class HostInstallInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "HostInstallInputError";
    this.exitCode = 2;
  }
}

/** Ctrl-C at a prompt: the conventional shell exit status for SIGINT. */
class HostInstallCancelledError extends Error {
  constructor(message) {
    super(message);
    this.name = "HostInstallCancelledError";
    this.exitCode = 130;
  }
}

function defaultHomeDefaults() {
  let user = process.env.USER || "devchain";
  try {
    user = userInfo().username || user;
  } catch {
    // The environment fallback is sufficient in stripped-down runtimes.
  }
  return { user, path: homedir() };
}

function createStdinSecretReader(input) {
  let lineReader;
  let iterator;

  return {
    async read(flag) {
      if (input.isTTY) {
        throw new HostInstallInputError(
          `${flag} reads from piped stdin; omit it to enter the secret without echo.`,
        );
      }
      if (!iterator) {
        lineReader = readline.createInterface({
          input,
          crlfDelay: Infinity,
          terminal: false,
        });
        iterator = lineReader[Symbol.asyncIterator]();
      }
      const next = await iterator.next();
      if (next.done) {
        throw new HostInstallInputError(`${flag} expected a line on stdin.`);
      }
      return next.value;
    },
    close() {
      lineReader?.close();
    },
  };
}

function promptLine(question, defaultValue, { input, output }) {
  if (!input.isTTY) {
    throw new HostInstallInputError(
      `Cannot prompt for ${question} without a terminal; supply its command option.`,
    );
  }
  const terminal = Boolean(output.isTTY);
  const rl = readline.createInterface({ input, output, terminal });
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  return new Promise((resolvePrompt, rejectPrompt) => {
    let answered = false;
    // Without the explicit pause a closed readline leaves stdin flowing and
    // keeps the process alive after the command has finished.
    const settle = (settleFn) => {
      answered = true;
      rl.close();
      input.pause();
      settleFn();
    };
    rl.once("close", () => {
      if (!answered)
        settle(() =>
          rejectPrompt(
            new HostInstallInputError(
              "Input ended before the prompt was answered.",
            ),
          ),
        );
    });
    rl.once("SIGINT", () => {
      if (!answered)
        settle(() =>
          rejectPrompt(new HostInstallCancelledError("Prompt cancelled.")),
        );
    });
    rl.question(`${question}${suffix}: `, (answer) => {
      settle(() => resolvePrompt(answer.trim() || defaultValue || ""));
    });
  });
}

function promptSecret(question, { input, output, allowEmpty = false }) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new HostInstallInputError(
      "A secret prompt requires a terminal; use the matching --*-stdin option.",
    );
  }

  return new Promise((resolvePrompt, rejectPrompt) => {
    const wasRaw = Boolean(input.isRaw);
    const decoder = new StringDecoder("utf8");
    let value = "";
    let finished = false;

    const restore = () => {
      input.removeListener("data", onData);
      input.setRawMode(wasRaw);
      // A resumed raw stdin keeps the process alive after the prompt ends;
      // pausing it lets the command exit with its real exit code.
      input.pause();
      output.write("\n");
    };
    const finish = (error) => {
      if (finished) return;
      finished = true;
      restore();
      if (error) rejectPrompt(error);
      else resolvePrompt(value);
    };
    const onData = (chunk) => {
      for (const character of decoder.write(chunk)) {
        if (character === "\r" || character === "\n") {
          if (!allowEmpty && value.length === 0) {
            output.write(`${question} cannot be empty. `);
            output.write(`${question}: `);
            continue;
          }
          finish();
          return;
        }
        if (character === "\u0003") {
          finish(new HostInstallCancelledError("Secret prompt cancelled."));
          return;
        }
        if (character === "\u0004") {
          finish(new HostInstallInputError("Secret prompt cancelled."));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = Array.from(value).slice(0, -1).join("");
        } else if (character >= " ") {
          value += character;
        }
      }
    };

    input.setRawMode(true);
    input.resume();
    output.write(`${question}: `);
    input.on("data", onData);
  });
}

function normalizeAddress(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new HostInstallInputError("VM address is required.");
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new HostInstallInputError(
      "Enter the VM address as https://host:3000.",
    );
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) {
    throw new HostInstallInputError(
      "Enter the VM address as https://host:3000.",
    );
  }
  return candidate;
}

function normalizeProjectIds(projects) {
  if (projects === undefined) return undefined;
  const values = Array.isArray(projects) ? projects : [projects];
  const ids = values
    .flatMap((value) => String(value).split(","))
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    throw new HostInstallInputError(
      "--projects requires at least one project id.",
    );
  }
  return [...new Set(ids)];
}

function parseProviderAuthFlags(values) {
  const choices = new Map();
  for (const value of values ?? []) {
    const separator = String(value).indexOf("=");
    if (separator <= 0) {
      throw new HostInstallInputError(
        `Invalid --provider-auth value "${value}"; use provider=skip, provider=generate or provider=reuse:<id>.`,
      );
    }
    const provider = String(value).slice(0, separator).trim().toLowerCase();
    const choice = String(value)
      .slice(separator + 1)
      .trim();
    if (!PROVIDERS.includes(provider)) {
      throw new HostInstallInputError(
        `Unknown provider in --provider-auth: ${provider}.`,
      );
    }
    if (choices.has(provider)) {
      throw new HostInstallInputError(
        `--provider-auth was repeated for ${provider}.`,
      );
    }
    if (
      choice !== "skip" &&
      choice !== "generate" &&
      !REUSE_CHOICE.test(choice)
    ) {
      throw new HostInstallInputError(
        `Invalid choice for ${provider}; use skip, generate or reuse:<entry-id>.`,
      );
    }
    if (choice === "generate" && !GENERATABLE_PROVIDERS.has(provider)) {
      throw new HostInstallInputError(
        `${provider} does not support generated logins.`,
      );
    }
    choices.set(provider, choice);
  }
  return choices;
}

async function chooseProviderAuth(entries, options, context) {
  const explicit = parseProviderAuthFlags(options.providerAuth);
  const selection = {};

  for (const provider of PROVIDERS) {
    const available = entries.filter((entry) => entry.provider === provider);
    let choice = explicit.get(provider);
    if (choice === undefined && available.length === 1) {
      choice = `reuse:${available[0].id}`;
    }
    if (choice === undefined && context.interactive) {
      choice = await promptProviderChoice(provider, available, context);
    }
    if (choice === undefined || choice === "skip") continue;

    if (choice === "generate") {
      if (!GENERATABLE_PROVIDERS.has(provider)) {
        throw new HostInstallInputError(
          `${provider} does not support generated logins.`,
        );
      }
      selection[provider] = choice;
      continue;
    }

    const reuse = REUSE_CHOICE.exec(choice);
    const entry = available.find(
      (candidate) => candidate.id.toLowerCase() === reuse?.[1].toLowerCase(),
    );
    if (!entry) {
      throw new HostInstallInputError(
        `The selected saved login is not available for ${provider}. Refresh the provider logins and retry.`,
      );
    }
    selection[provider] = choice;
  }

  return selection;
}

async function promptProviderChoice(provider, entries, context) {
  const lines = [`Provider login for ${provider}:`];
  entries.forEach((entry, index) => {
    const label = String(entry.label || entry.id).replace(/[\r\n\t]/g, " ");
    lines.push(
      `  ${index + 1}) Reuse ${label}${entry.kind === "family" ? " (family)" : ""}`,
    );
  });
  if (GENERATABLE_PROVIDERS.has(provider))
    lines.push("  g) Generate a new login");
  lines.push("  s) Skip");

  for (;;) {
    const answer = (
      await context.promptLine(lines.join("\n"), "s")
    ).toLowerCase();
    if (answer === "s" || answer === "skip") return "skip";
    if (
      (answer === "g" || answer === "generate") &&
      GENERATABLE_PROVIDERS.has(provider)
    ) {
      return "generate";
    }
    if (/^[1-9]\d*$/.test(answer)) {
      const entry = entries[Number(answer) - 1];
      if (entry) return `reuse:${entry.id}`;
    }
    writeLine(
      context.stderr,
      "Choose a listed number, g, or s.",
      context.secrets,
    );
  }
}

function expandHomePath(value, home) {
  const trimmed = String(value ?? "").trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/")) return join(home, trimmed.slice(2));
  return trimmed;
}

async function collectSshCredentials(options, context, previous) {
  const reauth = Boolean(previous);
  if (reauth && !context.interactive) return previous;

  let user = options.sshUser?.trim();
  if (reauth) {
    user = await context.promptLine("SSH user", previous.user);
  } else if (!user && context.interactive) {
    user = await context.promptLine("SSH user", context.homeDefaults.user);
  }
  if (!user) {
    throw new HostInstallInputError("SSH user is required; supply --ssh-user.");
  }

  const passwordStdin = Boolean(options.passwordStdin);
  const hasKey = Boolean(options.key);
  if (!reauth && passwordStdin && hasKey) {
    throw new HostInstallInputError(
      "Choose --password-stdin or --key, not both.",
    );
  }
  if (!reauth && options.passphraseStdin && !hasKey) {
    throw new HostInstallInputError("--passphrase-stdin requires --key.");
  }

  let authKind;
  if (reauth) {
    authKind = (
      await context.promptLine(
        "SSH authentication method (password or key)",
        previous.authKind,
      )
    ).toLowerCase();
  } else if (passwordStdin) {
    authKind = "password";
  } else if (hasKey) {
    authKind = "key";
  } else if (context.interactive) {
    authKind = (
      await context.promptLine(
        "SSH authentication method (password or key)",
        "password",
      )
    ).toLowerCase();
  } else {
    throw new HostInstallInputError(
      "Non-interactive use requires --password-stdin or --key <path>.",
    );
  }
  if (authKind !== "password" && authKind !== "key") {
    throw new HostInstallInputError(
      "SSH authentication must be password or key.",
    );
  }

  const credentials = { user, authKind };
  if (authKind === "password") {
    if (!reauth && hasKey) {
      throw new HostInstallInputError(
        "Remove --key when using SSH password authentication.",
      );
    }
    const password =
      !reauth && passwordStdin
        ? await context.readStdinSecret("--password-stdin")
        : await context.promptSecret("SSH password", { allowEmpty: false });
    credentials.password = password;
  } else {
    let keyPath = options.key || previous?.keyPath || "";
    if (context.interactive && (!hasKey || reauth)) {
      keyPath = await context.promptLine("SSH private key file", keyPath);
    }
    if (!keyPath) {
      throw new HostInstallInputError(
        "SSH key authentication requires --key <path>.",
      );
    }
    const resolvedKeyPath = resolve(
      expandHomePath(keyPath, context.homeDefaults.path),
    );
    let privateKey;
    try {
      privateKey = await fs.readFile(resolvedKeyPath, "utf8");
    } catch {
      throw new HostInstallInputError(
        `Cannot read the SSH private key file ${resolvedKeyPath}.`,
      );
    }
    credentials.privateKey = privateKey;
    credentials.keyPath = resolvedKeyPath;

    const passphrase =
      !reauth && options.passphraseStdin
        ? await context.readStdinSecret("--passphrase-stdin")
        : context.interactive
          ? await context.promptSecret("SSH key passphrase (optional)", {
              allowEmpty: true,
            })
          : undefined;
    if (passphrase) credentials.passphrase = passphrase;
  }

  const sudoPassword =
    !reauth && options.sudoPasswordStdin
      ? await context.readStdinSecret("--sudo-password-stdin")
      : context.interactive
        ? await context.promptSecret("Sudo password (optional)", {
            allowEmpty: true,
          })
        : undefined;
  if (sudoPassword || previous?.sudoPassword) {
    credentials.sudoPassword = sudoPassword || previous.sudoPassword;
  }

  context.addSecrets(credentials);
  return credentials;
}

function credentialsForRequest(credentials) {
  return {
    user: credentials.user,
    ...(credentials.password !== undefined
      ? { password: credentials.password }
      : {}),
    ...(credentials.privateKey !== undefined
      ? { privateKey: credentials.privateKey }
      : {}),
    ...(credentials.passphrase !== undefined
      ? { passphrase: credentials.passphrase }
      : {}),
    ...(credentials.sudoPassword !== undefined
      ? { sudoPassword: credentials.sudoPassword }
      : {}),
  };
}

function validateHomeTarget(userName, homePath) {
  if (!USER_NAME.test(userName)) {
    throw new HostInstallInputError(
      "Linux user must start with a lowercase letter or underscore and use lowercase letters, digits, - or _.",
    );
  }
  if (!HOME_ROOT.test(homePath)) {
    throw new HostInstallInputError(
      "Home path must start with /home/, /Users/ or /var/home/.",
    );
  }
}

async function runHostInstallCommand(options, dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const stdin = dependencies.stdin ?? process.stdin;
  const interactive = dependencies.isInteractive ?? Boolean(stdin.isTTY);
  const secrets = [];
  const secretReader = createStdinSecretReader(stdin);
  const addSecrets = (credentials) => {
    for (const key of [
      "password",
      "privateKey",
      "passphrase",
      "sudoPassword",
    ]) {
      if (typeof credentials[key] === "string") secrets.push(credentials[key]);
    }
  };
  const context = {
    stdin,
    stdout,
    stderr,
    interactive,
    secrets,
    addSecrets,
    now: dependencies.now ?? (() => performance.now()),
    sleep:
      dependencies.sleep ??
      ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))),
    homeDefaults: dependencies.homeDefaults ?? defaultHomeDefaults(),
    promptLine: (question, defaultValue) =>
      (dependencies.promptLine ?? promptLine)(question, defaultValue, {
        input: stdin,
        output: stderr,
      }),
    promptSecret: (question, { allowEmpty }) =>
      (dependencies.promptSecret ?? promptSecret)(question, {
        input: stdin,
        output: stderr,
        allowEmpty,
      }),
    readStdinSecret: async (flag) => {
      const value = await secretReader.read(flag);
      secrets.push(value);
      return value;
    },
  };

  try {
    const baseUrl = await dependencies.getLocalApiBaseUrl?.();
    if (!baseUrl) {
      writeLine(stderr, "Start DevChain first (devchain start).", secrets);
      return 1;
    }

    let address = options.address?.trim();
    if (!address && interactive)
      address = await context.promptLine("VM address", "");
    address = normalizeAddress(address);

    let ssh = await collectSshCredentials(options, context);
    const fetchImpl = dependencies.fetch ?? global.fetch;
    // The VM always receives the running home server's identity; the local
    // user and home are never sent.
    const identity = await requestJson(
      fetchImpl,
      baseUrl,
      "/api/remotes/host-install/identity",
    );
    const userName =
      typeof identity?.user === "string" ? identity.user.trim() : "";
    const homePath =
      typeof identity?.homePath === "string" ? identity.homePath.trim() : "";
    if (!userName || !homePath) {
      throw new Error("DevChain returned an incomplete VM identity.");
    }
    writeLine(
      stdout,
      `Claiming the VM as ${userName} with home ${homePath} (this PC's identity).`,
      secrets,
    );
    validateHomeTarget(userName, homePath);

    const authResponse = await requestJson(
      fetchImpl,
      baseUrl,
      "/api/provider-auth",
    );
    if (!Array.isArray(authResponse?.items)) {
      throw new Error("DevChain returned an invalid provider-login list.");
    }
    const providerAuth = await chooseProviderAuth(
      authResponse.items,
      options,
      context,
    );

    let minDiskGib = 8;
    const projectIds = normalizeProjectIds(options.projects);
    if (projectIds) {
      const estimate = await requestJson(
        fetchImpl,
        baseUrl,
        "/api/remotes/host-install/estimate",
        {
          method: "POST",
          body: { projectIds },
          timeoutMs: ESTIMATE_REQUEST_TIMEOUT_MS,
        },
      );
      if (
        !Number.isInteger(estimate?.requiredDiskGib) ||
        estimate.requiredDiskGib < 1
      ) {
        throw new Error("DevChain returned an invalid host disk estimate.");
      }
      minDiskGib = estimate.requiredDiskGib;
      for (const project of estimate.projects ?? []) {
        const size =
          project.bytes === null
            ? "size unknown"
            : `${(project.bytes / 1024 ** 3).toFixed(1)} GiB`;
        const approximate = project.approximate ? " (approximate)" : "";
        writeLine(
          stdout,
          `Project ${project.name}: ${size}${approximate}`,
          secrets,
        );
      }
      writeLine(stdout, `Estimated minimum disk: ${minDiskGib} GiB.`, secrets);
    }

    const operation = await requestJson(
      fetchImpl,
      baseUrl,
      "/api/remotes/host-install",
      {
        method: "POST",
        body: {
          address,
          ssh: credentialsForRequest(ssh),
          providerAuth,
          minDiskGib,
          // Docker is installed at claim unless --no-docker opts out.
          ...(options.docker === false ? {} : { installDocker: true }),
        },
      },
    );
    if (
      !operation ||
      typeof operation.id !== "string" ||
      !Array.isArray(operation.steps)
    ) {
      throw new Error("DevChain returned an invalid host-install operation.");
    }
    writeLine(
      stdout,
      `Host installation started (operation ${operation.id}).`,
      secrets,
    );

    const stepStates = new Map();
    let current = operation;
    for (;;) {
      printOperationSteps(current, stepStates, context);
      if (current.state === "done") {
        writeLine(stdout, "Host installation complete.", secrets);
        return 0;
      }
      if (current.state === "failed" || current.state === "cancelled") {
        const failed = (current.steps ?? []).find(
          (step) => step.state === "failed",
        );
        const error = failed?.error;
        if (error?.code === "SSH_CREDENTIALS_REQUIRED") {
          writeLine(
            stderr,
            "DevChain needs SSH credentials again to continue.",
            secrets,
          );
          ssh = await collectSshCredentials(options, context, ssh);
          const retried = await requestJson(
            fetchImpl,
            baseUrl,
            `/api/remotes/operations/${encodeURIComponent(current.id)}/retry`,
            { method: "POST", body: { ssh: credentialsForRequest(ssh) } },
          );
          stepStates.clear();
          current = retried;
          continue;
        }

        if (error?.code === "SSH_SUDO_PASSWORD_REQUIRED") {
          if (!interactive) {
            if (error.message) writeLine(stderr, error.message, secrets);
            return 1;
          }
          writeLine(
            stderr,
            "sudo on the VM needs a password for the SSH account.",
            secrets,
          );
          const sudoPassword = await context.promptSecret("Sudo password", {
            allowEmpty: false,
          });
          ssh = { ...ssh, sudoPassword };
          context.addSecrets(ssh);
          const retried = await requestJson(
            fetchImpl,
            baseUrl,
            `/api/remotes/operations/${encodeURIComponent(current.id)}/retry`,
            { method: "POST", body: { ssh: credentialsForRequest(ssh) } },
          );
          stepStates.clear();
          current = retried;
          continue;
        }

        if (error?.message) writeLine(stderr, error.message, secrets);
        if (current.state === "cancelled") {
          writeLine(stderr, "Host installation was cancelled.", secrets);
          return 1;
        }
        return failed?.id === "check" ||
          error?.code === "HOST_INSTALL_CHECK_FAILED"
          ? 2
          : 1;
      }

      await context.sleep(POLL_INTERVAL_MS);
      current = await getOperation(fetchImpl, baseUrl, current.id, context);
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Host installation failed.";
    writeLine(stderr, message, secrets);
    if (error instanceof HostInstallInputError) return error.exitCode;
    if (error instanceof HostInstallCancelledError) return error.exitCode;
    if (
      error instanceof HostInstallHttpError &&
      [400, 409].includes(error.status)
    )
      return 2;
    return 1;
  } finally {
    secretReader.close();
  }
}

module.exports = {
  HostInstallInputError,
  runHostInstallCommand,
  __test__: {
    ESTIMATE_REQUEST_TIMEOUT_MS,
    REQUEST_TIMEOUT_MS,
    chooseProviderAuth,
    collectSshCredentials,
    credentialsForRequest,
    expandHomePath,
    normalizeAddress,
    normalizeProjectIds,
    parseProviderAuthFlags,
    promptLine,
    promptSecret,
    requestJson,
  },
};
