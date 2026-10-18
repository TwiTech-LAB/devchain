const { execFileSync, spawnSync } = require("node:child_process");
const { existsSync, lstatSync, statSync } = require("node:fs");
const {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { delimiter, dirname, join } = require("node:path");
const { findRealGit, installShim, renderShim, runGitShimInstall } = require("../lib/git-shim");

// The shim is a shell script that forks real Git, so these run real sh and git. The supervisor
// is a stub that records what reached it; the real Git is wrapped to log each run it gets.
const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("git shim", () => {
  let directory;
  let home;
  let repo;
  let shim;
  let realGit;

  const stateFile = () => join(home, "state", "p1");

  async function register({ side = "home", owner = "vm" } = {}) {
    await writeFile(stateFile(), `${owner} 4\n`);
    const common = await realpath(join(repo, ".git"));
    await writeFile(
      join(home, "projects.sh"),
      `case $devchain_common in\n  '${common}') devchain_project='p1' devchain_side=${side} devchain_remote='vm-01' devchain_state='${stateFile()}' ;;\nesac\n`,
    );
  }

  function run(args, { cwd = repo, env = {}, input = "" } = {}) {
    const result = spawnSync(shim, args, {
      cwd,
      input,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "T",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@example.com",
        ...env,
      },
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  async function supervised() {
    const file = join(home, "supervised");
    if (!existsSync(file)) return null;
    const record = JSON.parse(await readFile(file, "utf8"));
    await rm(file);
    return record;
  }

  /** The real Git runs after the identity fork, with GIT_OPTIONAL_LOCKS as it saw it. */
  async function gitRuns() {
    const lines = (await readFile(join(directory, "git.log"), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean);
    await rm(join(directory, "git.log"), { force: true });
    return lines.filter((line) => !/\|(.* )?(rev-parse --path-format|config --get alias)/.test(line));
  }

  beforeAll(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "git-shim-")));
    home = join(directory, "shim");
    repo = join(directory, "repo");
    const system = findRealGit(process.env.PATH, join(home, "bin"));
    realGit = join(directory, "real-git");
    await writeFile(
      realGit,
      `#!/bin/sh\nprintf '%s|%s\\n' "\${GIT_OPTIONAL_LOCKS:-}" "$*" >> '${directory}/git.log'\nexec '${system}' "$@"\n`,
    );
    await chmod(realGit, 0o755);
    const supervisor = join(directory, "supervisor.js");
    await writeFile(
      supervisor,
      `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(join(home, "supervised"))}, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  project: process.env.DEVCHAIN_GIT_PROJECT,
  side: process.env.DEVCHAIN_GIT_SIDE,
  remote: process.env.DEVCHAIN_GIT_REMOTE_NAME,
  realGit: process.env.DEVCHAIN_REAL_GIT,
}));
process.stdout.write(fs.readFileSync(0, "utf8"));
process.exit(7);
`,
    );
    await mkdir(join(home, "bin"), { recursive: true });
    await mkdir(join(home, "state"), { recursive: true });
    shim = join(home, "bin", "git");
    await writeFile(shim, renderShim({ realGit, node: process.execPath, supervisor, home }), {
      mode: 0o755,
    });

    const git = (args, cwd = repo) =>
      execFileSync(system, args, { cwd, env: { PATH: process.env.PATH, HOME: directory } });
    await mkdir(repo);
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "T"]);
    git(["config", "alias.co", "checkout"]);
    git(["config", "alias.st", "status --short"]);
    git(["config", "alias.sh", "!echo shell"]);
    await mkdir(join(repo, "sub"));
    await writeFile(join(repo, "sub", "f"), "x");
    git(["add", "."]);
    git(["commit", "-q", "-m", "one"]);
    git(["worktree", "add", "-q", join(directory, "linked"), "-b", "lane"]);
    await mkdir(join(directory, "other"));
    git(["init", "-q"], join(directory, "other"));
    await mkdir(join(directory, "plain"));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  beforeEach(() => register());

  it.each([
    ["the project root", () => ({})],
    ["a subfolder", () => ({ cwd: join(repo, "sub") })],
    ["-C", () => ({ cwd: join(directory, "plain"), prefix: ["-C", repo] })],
    [
      "GIT_DIR and GIT_WORK_TREE",
      () => ({
        cwd: join(directory, "plain"),
        env: { GIT_DIR: join(repo, ".git"), GIT_WORK_TREE: repo },
      }),
    ],
    ["a linked worktree", () => ({ cwd: join(directory, "linked") })],
  ])("resolves the project from %s", async (_, options) => {
    const { prefix = [], ...rest } = options();
    expect(run([...prefix, "branch", "next"], rest).code).toBe(7);
    expect(await supervised()).toMatchObject({
      args: [...prefix, "branch", "next"],
      project: "p1",
      side: "home",
      remote: "vm-01",
      realGit,
    });
  });

  it.each([
    ["an unmanaged repository", "other"],
    ["a folder outside any repository", "plain"],
  ])("runs real Git in %s", async (_, folder) => {
    const result = run(["commit", "--allow-empty", "-q", "-m", "x"], {
      cwd: join(directory, folder),
    });
    expect(await supervised()).toBeNull();
    expect(result.code).toBe(folder === "other" ? 0 : 128);
    expect((await gitRuns()).at(-1)).toBe("|commit --allow-empty -q -m x");
  });

  it("runs real Git everywhere when DevChain has not listed any project", async () => {
    await rm(join(home, "projects.sh"));
    expect(run(["checkout", "-q", "main"]).code).toBe(0);
    expect(await supervised()).toBeNull();
  });

  it.each([
    [["status"], "read"],
    [["log", "-1"], "read"],
    [["rev-parse", "HEAD"], "read"],
    [["branch"], "read"],
    [["branch", "-a", "-v"], "read"],
    [["branch", "next"], "write"],
    [["branch", "-D", "next"], "write"],
    [["tag", "-l"], "read"],
    [["tag", "v1"], "write"],
    [["branch", "--merged", "main"], "read"],
    [["branch", "--contains", "HEAD", "-r"], "read"],
    [["branch", "--list", "feat/*"], "read"],
    [["tag", "-l", "v*"], "read"],
    [["tag", "--sort", "-version:refname"], "read"],
    [["tag", "-n3", "v*"], "read"],
    [["branch", "--list", "-D", "next"], "write"],
    [["tag", "-a", "v2", "-m", "x"], "write"],
    [["remote", "-v"], "read"],
    [["remote", "add", "x", "/tmp/x"], "write"],
    [["stash", "list"], "read"],
    [["stash"], "write"],
    [["worktree", "list"], "read"],
    [["worktree", "add", "../w"], "write"],
    [["config", "user.name"], "read"],
    [["config", "--get", "user.name"], "read"],
    [["config", "user.name", "x"], "write"],
    [["update-index", "--refresh"], "read"],
    [["update-index", "--add", "f"], "write"],
    [["commit", "-m", "x"], "write"],
    [["frobnicate"], "write"],
    [["st"], "read"],
    [["co", "-b", "x"], "write"],
    [["sh"], "write"],
    [["-c", "alias.zz=log", "zz", "-1"], "read"],
    [["-c", "alias.zz=reset", "zz"], "write"],
  ])("classifies git %j as a %s", async (args, kind) => {
    run(args);
    const record = await supervised();
    if (kind === "write") expect(record).toMatchObject({ args });
    else {
      expect(record).toBeNull();
      expect((await gitRuns()).at(-1)).toBe(`0|${args.join(" ")}`);
    }
  });

  it("reads without GIT_OPTIONAL_LOCKS on the owner", async () => {
    await register({ owner: "home" });
    expect(run(["status", "--short"]).code).toBe(0);
    expect((await gitRuns()).at(-1)).toBe("|status --short");
  });

  it.each([
    ["gc"],
    ["prune"],
    ["repack", "-a", "-d"],
    ["repack", "-ad"],
    ["maintenance", "run"],
  ])("refuses git %s at home with one line", async (...args) => {
    await gitRuns();
    const result = run(args);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      `git: run 'git ${args[0]}' on the VM 'vm-01'; this PC does not run Git maintenance for this project.\n`,
    );
    expect(await supervised()).toBeNull();
    expect(await gitRuns()).toEqual([]);
  });

  it("sends maintenance on the VM, and a repack that deletes nothing at home, to the supervisor", async () => {
    run(["repack", "-a"]);
    expect(await supervised()).toMatchObject({ args: ["repack", "-a"] });
    await register({ side: "vm", owner: "vm" });
    run(["gc"]);
    expect(await supervised()).toMatchObject({ args: ["gc"], side: "vm" });
  });

  it.each([
    [{ side: "home", owner: "vm" }, "skipped"],
    [{ side: "home", owner: "home" }, "write"],
    [{ side: "vm", owner: "home" }, "write"],
  ])("handles a fetch without a terminal on %j as %s", async (state, outcome) => {
    await register(state);
    const result = run(["fetch", "origin"]);
    if (outcome === "skipped") {
      expect(result.code).toBe(0);
      expect(await supervised()).toBeNull();
    } else expect(await supervised()).toMatchObject({ args: ["fetch", "origin"] });
  });

  it("passes argv, stdin, stdout and the exit code through without evaluating them", async () => {
    const args = ["commit", "-m", "two  words", "$(touch pwned)", "*", "`id`", "a\nb"];
    const result = run(args, { input: "from stdin" });
    expect(result).toMatchObject({ code: 7, stdout: "from stdin" });
    expect(await supervised()).toMatchObject({ args, cwd: repo });
    expect(existsSync(join(repo, "pwned"))).toBe(false);

    const read = run(["show", "no-such-ref"]);
    expect(read.code).toBe(128);
    expect(read.stderr).toMatch(/no-such-ref/);
  });

  it("runs real Git for DEVCHAIN_GIT_BYPASS and for a nested Git of this project's write", async () => {
    for (const env of [
      { DEVCHAIN_GIT_BYPASS: "1" },
      { DEVCHAIN_GIT_HOLD: "hw-1", DEVCHAIN_GIT_HOLD_PROJECT: "p1" },
    ]) {
      expect(run(["branch", "-q", "next"], { env }).code).toBe(0);
      expect(await supervised()).toBeNull();
      run(["branch", "-D", "-q", "next"], { env: { DEVCHAIN_GIT_BYPASS: "1" } });
    }
    run(["branch", "next"], { env: { DEVCHAIN_GIT_HOLD: "hw-1", DEVCHAIN_GIT_HOLD_PROJECT: "p2" } });
    expect(await supervised()).toMatchObject({ args: ["branch", "next"] });
  });
});

describePosix("git shim install", () => {
  let directory;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "git-shim-install-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const output = () => {
    const stream = { text: "", write: (chunk) => (stream.text += chunk) };
    return stream;
  };

  it("writes the shim and prints the PATH and --shell lines, the VS Code setting and the JetBrains path", async () => {
    const home = join(directory, "it's");
    const stdout = output();
    expect(runGitShimInstall({ stdout, options: { home } })).toBe(0);
    const shim = join(home, "bin", "git");
    expect(statSync(shim).mode & 0o777).toBe(0o755);
    expect(stdout.text).toContain(
      `export PATH='${join(directory, "it'\\''s")}/bin':"$PATH"\nOr set up your shell: eval "$(devchain git shim install --shell)"\n`,
    );
    expect(stdout.text).toContain(`"git.path": ${JSON.stringify(shim)}`);
    expect(stdout.text).toContain(`Path to Git executable:\n  ${shim}\n`);
    // A second install, as on every `devchain start`, finds the real Git, never the shim.
    const path = `${join(home, "bin")}:${process.env.PATH}`;
    expect(installShim({ home, path }).realGit).toBe(findRealGit(process.env.PATH, ""));
  });

  it("refuses a Git older than 2.31", () => {
    const stderr = output();
    const home = join(directory, "home");
    const code = runGitShimInstall({
      stderr,
      options: { home, realGit: "/usr/bin/git", gitVersion: () => "git version 2.30.9\n" },
    });
    expect(code).toBe(1);
    expect(stderr.text).toBe(
      "git version 2.30.9 is older than 2.31; the DevChain git shim needs Git 2.31 or newer.\n",
    );
    expect(existsSync(join(home, "bin", "git"))).toBe(false);
  });

  describe("--shell", () => {
    const START = "# >>> devchain git shim >>>";
    const END = "# <<< devchain git shim <<<";
    let user;
    let shimHome;
    const bin = () => join(shimHome, "bin");

    beforeEach(async () => {
      user = join(directory, "user");
      shimHome = join(directory, "shim home", "it's");
      await mkdir(user);
    });

    function install({ env = { SHELL: "/bin/bash" }, platform = "linux", tty = false } = {}) {
      const stdout = output();
      const stderr = output();
      const code = runGitShimInstall({
        shell: true,
        stdout,
        stderr,
        env: { HOME: user, ...env },
        platform,
        stdoutIsTTY: tty,
        options: {
          home: shimHome,
          realGit: "/usr/bin/git",
          gitVersion: () => "git version 2.43.0\n",
        },
      });
      return { code, stdout: stdout.text, stderr: stderr.text };
    }

    it("leaves one block after two runs and keeps the other content byte for byte", async () => {
      const rc = join(user, ".bashrc");
      const before = "export A=1\r\n# note\n";
      const after = "\nalias x=y";
      await writeFile(rc, `${before}${after}`);

      const first = install();
      expect(first.code).toBe(0);
      const once = await readFile(rc, "utf8");
      expect(once).toBe(`${before}${after}\n${START}\n${first.stdout.trimEnd()}\n${END}\n`);

      await writeFile(rc, `${before}${START}\nold\n${END}\n${after}`);
      expect(install().code).toBe(0);
      expect(install().code).toBe(0);
      const twice = await readFile(rc, "utf8");
      expect(twice).toBe(`${before}${START}\n${first.stdout.trimEnd()}\n${END}\n${after}`);
    });

    it("creates the rc file, and prints only the shell line on stdout when it is not a TTY", async () => {
      const result = install();
      expect(result.stdout).toMatch(/^__dc_bin=.*hash -r\n$/);
      expect(result.stderr).toContain("Installed the DevChain git shim");
      expect(await readFile(join(user, ".bashrc"), "utf8")).toContain(result.stdout);
    });

    it("names the changed file on a TTY", () => {
      const result = install({ tty: true });
      expect(result.stdout).toBe(
        `Updated ${join(user, ".bashrc")}\nFor this terminal, run: eval "$(devchain git shim install --shell)"\n`,
      );
    });

    it("keeps a symlinked rc file a symlink and writes the block to its target", async () => {
      const target = join(directory, "dotfiles-bashrc");
      await writeFile(target, "export A=1\n");
      await symlink(target, join(user, ".bashrc"));
      expect(install().code).toBe(0);
      expect(lstatSync(join(user, ".bashrc")).isSymbolicLink()).toBe(true);
      expect(await readFile(target, "utf8")).toContain(START);
    });

    it("gives an unsupported shell the shim, no rc change and exit 1", async () => {
      for (const env of [{ SHELL: "/usr/bin/fish" }, {}]) {
        const result = install({ env });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(
          `export PATH='${join(directory, "shim home", "it'\\''s")}/bin':"$PATH"`,
        );
        expect(result.stdout).toMatch(/^__dc_bin=/);
        expect(existsSync(join(shimHome, "bin", "git"))).toBe(true);
        expect(existsSync(join(user, ".bashrc"))).toBe(false);
      }
    });

    it("reports an unwritable rc file without a stack trace", async () => {
      await mkdir(join(user, ".bashrc"));
      const result = install();
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`Could not write ${join(user, ".bashrc")}:`);
      expect(result.stderr).toContain("export PATH=");
      expect(result.stderr).not.toContain("    at ");
      expect(result.stdout).toMatch(/^__dc_bin=/);
    });

    it("refuses a block that has no closing marker", async () => {
      const rc = join(user, ".bashrc");
      await writeFile(rc, `${START}\nhalf\n`);
      expect(install().code).toBe(1);
      expect(await readFile(rc, "utf8")).toBe(`${START}\nhalf\n`);
    });

    it("selects the rc file by shell and platform", async () => {
      expect(install({ env: { SHELL: "/bin/zsh" } }).code).toBe(0);
      expect(existsSync(join(user, ".zshrc"))).toBe(true);

      const zdotdir = join(directory, "zdot");
      await mkdir(zdotdir);
      expect(install({ env: { SHELL: "/bin/zsh", ZDOTDIR: zdotdir } }).code).toBe(0);
      expect(existsSync(join(zdotdir, ".zshrc"))).toBe(true);

      const mac = { env: { SHELL: "/bin/bash" }, platform: "darwin" };
      expect(install(mac).code).toBe(0);
      expect(existsSync(join(user, ".bash_profile"))).toBe(true);
      await rm(join(user, ".bash_profile"));
      await writeFile(join(user, ".profile"), "");
      expect(install(mac).code).toBe(0);
      expect(existsSync(join(user, ".bash_profile"))).toBe(false);
      expect(await readFile(join(user, ".profile"), "utf8")).toContain(START);
      await writeFile(join(user, ".bash_login"), "");
      expect(install(mac).code).toBe(0);
      expect(await readFile(join(user, ".bash_login"), "utf8")).toContain(START);
    });

    function evalIn(shell, line, path) {
      const result = spawnSync(
        shell,
        ["-c", `eval "$(printf '%s' "$LINE")"; command -v git; printf '%s\\n' "$PATH"`],
        { encoding: "utf8", env: { LINE: line, PATH: path, HOME: directory } },
      );
      const [git, resolved] = result.stdout.trimEnd().split("\n");
      return { git, path: resolved };
    }

    for (const name of ["bash", "zsh"]) {
      // An empty path means the shell is not installed, so its test is skipped.
      const shell = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
      (shell ? it : it.skip)(
        `puts the shim first under eval in ${name}, also when PATH had it last or twice`,
        () => {
          const shimGit = join(bin(), "git");
          const realBin = dirname(findRealGit(process.env.PATH, ""));
          const line = install().stdout.trimEnd();
          for (const path of [
            `${realBin}:/usr/bin:${bin()}`,
            `${bin()}:${realBin}:${bin()}::/usr/bin`,
            realBin,
          ]) {
            const result = evalIn(shell, line, path);
            expect(result.git).toBe(shimGit);
            const entries = result.path.split(delimiter);
            expect(entries[0]).toBe(bin());
            expect(entries.filter((entry) => entry === bin())).toHaveLength(1);
          }
        },
      );
    }
  });
});
