const { execFileSync } = require("node:child_process");
const {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} = require("node:fs");
const { homedir } = require("node:os");
const { basename, delimiter, dirname, join, resolve } = require("node:path");

/** Git 2.31 added `rev-parse --path-format=absolute`, which the shim's one identity fork needs. */
const MINIMUM_GIT = [2, 31, 0];

const RC_BLOCK_START = "# >>> devchain git shim >>>";
const RC_BLOCK_END = "# <<< devchain git shim <<<";
const SHELL_SETUP_COMMAND = 'eval "$(devchain git shim install --shell)"';

function shimHome(home = homedir()) {
  return join(home, ".devchain", "git-shim");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * The POSIX `sh` shim. It never evaluates its arguments: they only reach `case` patterns and
 * the exec'd Git or supervisor. See docs/git-coordinator.md (Git shim).
 */
function renderShim({ realGit, node, supervisor, home }) {
  return `#!/bin/sh
# DevChain git shim: Git writes in DevChain-connected projects go through the supervisor.
# Written by \`devchain git shim install\` and \`devchain start\`; do not edit.
real_git=${shellQuote(realGit)}
shim_home=${shellQuote(home)}
node=${shellQuote(node)}
supervisor=${shellQuote(supervisor)}

[ -n "\${DEVCHAIN_GIT_BYPASS:-}" ] && exec "$real_git" "$@"

# Global options come before the subcommand; -C, -c, --git-dir and --work-tree pick the repository.
n=0 cmd= value=
for arg do
  if [ -n "$value" ]; then value= n=$((n + 1)); continue; fi
  case $arg in
    -C|-c|--git-dir|--work-tree|--namespace|--config-env|--attr-source|--super-prefix) value=1 ;;
    -p|-P|--paginate|--no-pager|--bare|--no-replace-objects|--no-lazy-fetch|--no-optional-locks|\\
    --no-advice|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|\\
    --git-dir=*|--work-tree=*|--namespace=*|--config-env=*|--attr-source=*|--super-prefix=*) ;;
    *) cmd=$arg; break ;;
  esac
  n=$((n + 1))
done
case $cmd in ''|-*|version|help) exec "$real_git" "$@" ;; esac

# Runs real Git with only the leading global options, then the given query.
query() {
  keep=$1 what=$2 i=0
  shift 2
  total=$#
  while [ "$i" -lt "$total" ]; do
    arg=$1
    shift
    [ "$i" -lt "$keep" ] && set -- "$@" "$arg"
    i=$((i + 1))
  done
  case $what in
    dirs) "$real_git" "$@" rev-parse --path-format=absolute --absolute-git-dir --git-common-dir ;;
    alias) "$real_git" "$@" config --get "alias.$cmd" ;;
  esac 2>/dev/null
}

nl='
'
dirs=$(query "$n" dirs "$@") || exec "$real_git" "$@"
devchain_common=\${dirs##*"$nl"}
devchain_project=
[ -r "$shim_home/projects.sh" ] && . "$shim_home/projects.sh"
[ -n "$devchain_project" ] || exec "$real_git" "$@"
# A write already holding this project runs its nested Git (hooks, for example) directly.
if [ -n "\${DEVCHAIN_GIT_HOLD:-}" ] && [ "\${DEVCHAIN_GIT_HOLD_PROJECT:-}" = "$devchain_project" ]; then
  exec "$real_git" "$@"
fi
owner= generation=
[ -r "$devchain_state" ] && read -r owner generation < "$devchain_state"

# Splits an alias into its verb and arguments; a function, so the script's own "$@" stays intact.
split_alias() {
  verb=$1
  shift
  alias_args="$*"
}

verb=$cmd alias_args=
case $cmd in
  add|am|apply|bisect|blame|branch|cat-file|check-attr|check-ignore|checkout|cherry-pick|clean|\\
  clone|commit|config|describe|diff|fetch|for-each-ref|gc|grep|init|log|ls-files|ls-tree|\\
  maintenance|merge|merge-base|mv|name-rev|notes|prune|pull|push|rebase|remote|repack|reset|\\
  restore|rev-list|rev-parse|revert|rm|shortlog|show|show-ref|stash|status|submodule|switch|tag|\\
  update-index|var|worktree) ;;
  *)
    expansion=$(query "$n" alias "$@")
    case $expansion in
      '') ;;
      '!'*) verb='!' ;;
      *)
        set -f
        split_alias $expansion
        set +f
        ;;
    esac
    ;;
esac

# Sets kind to read, write, gc or fetch from the verb and its arguments.
classify() {
  skip=$((n + 1))
  while [ "$skip" -gt 0 ]; do shift; skip=$((skip - 1)); done
  if [ -n "$alias_args" ]; then
    set -f
    set -- $alias_args "$@"
    set +f
  fi
  kind=write
  case $verb in
    status|diff|log|show|blame|rev-parse|ls-files|ls-tree|cat-file|for-each-ref|show-ref|\\
    rev-list|describe|grep|shortlog|check-ignore|check-attr|merge-base|name-rev|var|version|help)
      kind=read ;;
    branch) list_form branch "$@" ;;
    tag) list_form tag "$@" ;;
    remote)
      case \${1:-} in ''|-v|--verbose|show|get-url) kind=read ;; esac ;;
    stash) case \${1:-} in list|show) kind=read ;; esac ;;
    worktree) [ "\${1:-}" = list ] && kind=read ;;
    config) config_form "$@" ;;
    update-index)
      kind=read
      [ $# -gt 0 ] || kind=write
      for arg do
        case $arg in --refresh|--really-refresh|-q|--ignore-missing|--unmerged|--ignore-submodules) ;; *) kind=write ;; esac
      done
      ;;
    gc|prune) kind=gc ;;
    repack) for arg do case $arg in --*) ;; -*d*) kind=gc ;; esac; done ;;
    maintenance) [ "\${1:-}" = run ] && kind=gc ;;
    fetch) kind=fetch ;;
  esac
}

# branch and tag list when every option only lists or filters. A name is a pattern, not a new
# ref, only with -l/--list or a filter option that implies it; any other option writes.
list_form() {
  form=$1
  shift
  kind=read listing= names=0 value=
  for arg do
    if [ -n "$value" ]; then value=; continue; fi
    case $arg in
      -l|--list) listing=1 ;;
      --contains|--no-contains|--merged|--no-merged|--points-at) listing=1 value=1 ;;
      --contains=*|--no-contains=*|--merged=*|--no-merged=*|--points-at=*) listing=1 ;;
      --sort|--format) value=1 ;;
      -n|-n[0-9]*) [ "$form" = tag ] && listing=1 ;;
      -a|--all|-r|--remotes|-v|-vv|--verbose|--show-current|--column|--no-column|-i|--ignore-case|\\
      --sort=*|--format=*|--color|--color=*|--no-color|--abbrev=*|--no-abbrev|--omit-empty) ;;
      -*) kind=write; return ;;
      *) names=$((names + 1)) ;;
    esac
  done
  [ "$names" -eq 0 ] || [ -n "$listing" ] || kind=write
}

# config reads: --get forms, --list, the get and list subcommands, or a single name.
config_form() {
  kind=write
  names=0
  for arg do
    case $arg in
      --get|--get-all|--get-regexp|--get-urlmatch|--get-color|--get-colorbool|-l|--list|get|list) kind=read; return ;;
      --unset|--unset-all|--add|--replace-all|--rename-section|--remove-section|-e|--edit|set|unset|\\
      rename-section|remove-section|edit|-f|--file|--blob) return ;;
      -*) ;;
      *) names=$((names + 1)) ;;
    esac
  done
  [ "$names" -eq 1 ] && kind=read
}

classify "$@"
case $kind in
  read)
    [ "$owner" = "$devchain_side" ] || export GIT_OPTIONAL_LOCKS=0
    exec "$real_git" "$@"
    ;;
  gc)
    if [ "$devchain_side" = home ]; then
      printf "git: run 'git %s' on the VM '%s'; this PC does not run Git maintenance for this project.\\n" "$verb" "$devchain_remote" >&2
      exit 1
    fi
    ;;
  fetch)
    # An IDE's background fetch on the non-owner PC would move Git here; skip it quietly.
    if [ "$devchain_side" = home ] && [ "$owner" != home ] && [ ! -t 0 ]; then exit 0; fi
    ;;
esac
export DEVCHAIN_REAL_GIT="$real_git" DEVCHAIN_GIT_PROJECT="$devchain_project"
export DEVCHAIN_GIT_SIDE="$devchain_side" DEVCHAIN_GIT_REMOTE_NAME="$devchain_remote"
exec "$node" "$supervisor" "$@"
`;
}

function parseGitVersion(output) {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

function supportsShim(version) {
  for (let i = 0; i < MINIMUM_GIT.length; i++) {
    if (version[i] !== MINIMUM_GIT[i]) return version[i] > MINIMUM_GIT[i];
  }
  return true;
}

/** The first `git` on PATH that is not the shim itself. */
function findRealGit(pathValue, bin) {
  for (const directory of (pathValue ?? "").split(delimiter)) {
    if (!directory || resolve(directory) === resolve(bin)) continue;
    const candidate = join(directory, "git");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

/**
 * Writes the shim for this user. Returns its paths and the real Git, or an `error` line when
 * no usable Git exists; an older Git gets no shim, so it never reaches the supervisor.
 */
function installShim(options = {}) {
  const home = options.home ?? shimHome();
  const bin = join(home, "bin");
  const realGit = options.realGit ?? findRealGit(options.path ?? process.env.PATH, bin);
  if (!realGit) return { error: "Git was not found on PATH." };
  const versionOutput = (options.gitVersion ?? ((git) =>
    execFileSync(git, ["--version"], { encoding: "utf8" })))(realGit);
  const version = parseGitVersion(versionOutput);
  if (!version || !supportsShim(version)) {
    return {
      error: `${versionOutput.trim() || "This Git"} is older than 2.31; the DevChain git shim needs Git 2.31 or newer.`,
      realGit,
    };
  }
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, "git");
  const temporary = `${shim}.${process.pid}.tmp`;
  writeFileSync(
    temporary,
    renderShim({
      realGit,
      node: options.node ?? process.execPath,
      supervisor: options.supervisor ?? join(__dirname, "git-supervisor.js"),
      home,
    }),
    { mode: 0o755 },
  );
  // Git may run the shim at any moment; it must never see a partial file.
  renameSync(temporary, shim);
  return { shim, bin, realGit, version: version.join(".") };
}

/**
 * One line of POSIX `sh` that drops every shim-directory entry from PATH, puts the directory
 * first and clears the command hash. The rc block and the `--shell` stdout are this same line,
 * so `eval` switches the current shell the way a new shell would start.
 */
function renderShellLine(bin) {
  return (
    `__dc_bin=${shellQuote(bin)} __dc_rest=$PATH: __dc_path=; ` +
    'while [ -n "$__dc_rest" ]; do ' +
    "__dc_entry=${__dc_rest%%:*}; __dc_rest=${__dc_rest#*:}; " +
    '[ -z "$__dc_entry" ] || [ "$__dc_entry" = "$__dc_bin" ] || ' +
    "__dc_path=${__dc_path:+$__dc_path:}$__dc_entry; done; " +
    "PATH=$__dc_bin${__dc_path:+:$__dc_path}; export PATH; " +
    "unset __dc_bin __dc_rest __dc_path __dc_entry; hash -r"
  );
}

/** The startup file for the user's shell, `{ file }`, or `{ reason }` when the shell is unsupported. */
function selectRcFile({ env, platform, home }) {
  const shell = env.SHELL ? basename(env.SHELL) : "";
  if (shell === "bash") {
    if (platform !== "darwin") return { file: join(home, ".bashrc") };
    // bash reads the first of these that exists, so a new file must not hide an existing ~/.profile.
    const candidates = [".bash_profile", ".bash_login", ".profile"].map((name) => join(home, name));
    return {
      file: candidates.find((candidate) => existsSync(candidate)) ?? candidates[0],
    };
  }
  if (shell === "zsh") return { file: join(env.ZDOTDIR || home, ".zshrc") };
  return {
    reason: shell ? `Shell "${shell}" is not bash or zsh.` : "SHELL is not set.",
  };
}

/**
 * Adds or replaces the marked block, leaving the rest of the file untouched. The file is written
 * in place, never renamed over, so a symlinked rc file keeps pointing at its target.
 */
function writeRcBlock(file, line) {
  let content = "";
  try {
    content = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const block = `${RC_BLOCK_START}\n${line}\n${RC_BLOCK_END}`;
  const start = new RegExp(`^${RC_BLOCK_START}$`, "m").exec(content);
  let next;
  if (start) {
    const rest = content.slice(start.index);
    const end = new RegExp(`^${RC_BLOCK_END}$`, "m").exec(rest);
    if (!end)
      throw new Error(`the "${RC_BLOCK_START}" block has no closing "${RC_BLOCK_END}" line`);
    next = content.slice(0, start.index) + block + rest.slice(end.index + end[0].length);
  } else {
    const separator = content && !content.endsWith("\n") ? "\n" : "";
    next = `${content}${separator}${block}\n`;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
}

/** `--shell`: writes the rc block; stdout holds only the shell line so `eval "$(…)"` works. */
function setUpShell(result, { out, err, manual, env, platform, stdoutIsTTY }) {
  const line = renderShellLine(result.bin);
  const rc = selectRcFile({ env, platform, home: env.HOME || homedir() });
  let failure = null;
  if (rc.reason) {
    failure = `${rc.reason} Your shell startup file was not changed.`;
  } else {
    try {
      writeRcBlock(rc.file, line);
    } catch (error) {
      failure = `Could not write ${rc.file}: ${error.message}`;
    }
  }
  if (failure) {
    err.write(`${failure}\nAdd this line to your shell startup file:\n${manual}\n`);
  }

  if (stdoutIsTTY) {
    if (!failure) out.write(`Updated ${rc.file}\n`);
    out.write(`For this terminal, run: ${SHELL_SETUP_COMMAND}\n`);
  } else {
    out.write(`${line}\n`);
  }
  return failure ? 1 : 0;
}

/** `devchain git shim install`: writes the shim and prints how to put it first on PATH. */
function runGitShimInstall(dependencies = {}) {
  const out = dependencies.stdout ?? process.stdout;
  const err = dependencies.stderr ?? process.stderr;
  const result = installShim(dependencies.options);
  if (result.error) {
    err.write(`${result.error}\n`);
    return 1;
  }
  const installed = `Installed the DevChain git shim: ${result.shim}`;
  const manual = `  export PATH=${shellQuote(result.bin)}:"$PATH"`;
  if (dependencies.shell) {
    err.write(`${installed}\n`);
    return setUpShell(result, {
      out,
      err,
      manual,
      env: dependencies.env ?? process.env,
      platform: dependencies.platform ?? process.platform,
      stdoutIsTTY: dependencies.stdoutIsTTY ?? Boolean(out.isTTY),
    });
  }
  out.write(
    [
      installed,
      `It runs ${result.realGit} (Git ${result.version}).`,
      "",
      "Put it first on PATH, for example in ~/.bashrc or ~/.zshrc:",
      manual,
      `Or set up your shell: ${SHELL_SETUP_COMMAND}`,
      "",
      "VS Code, in your user settings.json:",
      `  "git.path": ${JSON.stringify(result.shim)}`,
      "",
      "JetBrains IDEs, Settings > Version Control > Git > Path to Git executable:",
      `  ${result.shim}`,
      "",
    ].join("\n"),
  );
  return 0;
}

module.exports = {
  findRealGit,
  installShim,
  parseGitVersion,
  renderShim,
  runGitShimInstall,
  shimHome,
  supportsShim,
};
