# ASD-STE100 Skill — Simplified Technical English for Agent Output

A DevChain first-party skill that writes new text, or rewrites dense, ambiguous English, in [ASD-STE100 Simplified Technical English](https://www.asd-ste100.org/) (STE) — the controlled-language standard the aerospace and defense industry built so aircraft maintenance instructions cannot be misread.

This skill repurposes that same discipline for a different reader: an **AI agent** parsing another agent's output, a tool description, an error message, or an inter-agent instruction, with no human in the loop to resolve ambiguity.

## Why STE, and Why for Agents

STE exists because a misread instruction on an aircraft can kill people, and the intended readers were often not native English speakers with no author to call for clarification. The standard's fix: one meaning per word, active voice, simple tenses, one instruction per sentence, short sentences, no dropped words.

An LLM agent parsing another agent's output is in a strikingly similar position — no back-channel, no way to ask "did you mean X or Y?" The same rules that keep a mechanic from misreading a torque spec keep a downstream agent from misreading a tool description or an inter-agent message.

## Before / After

| Before | After |
|---|---|
| "This tool will attempt to synchronize state across the various backends that have been configured, and if a conflict is detected it may resolve it automatically depending on the strategy that has been set, or otherwise it will surface the conflict for manual review." | "The tool synchronizes state across the configured backends. If it finds a conflict, it checks the current strategy. If the strategy allows automatic resolution, the tool resolves the conflict. If not, the tool reports the conflict for manual review." |
| "An error may have occurred while processing your request due to a possible mismatch in the expected data format, which could be caused by an outdated client version." | "The request failed. The data format did not match the format that the server expects. An outdated client version can cause this error." |

More worked examples are at the end of [`SKILL.md`](SKILL.md).

## What This Skill Does

It has two uses:

- **Write:** an agent applies the rules while it writes its own text, such as a plan, an epic description, or a message to another agent. There is no separate rewrite pass.
- **Rewrite:** the skill applies the rules to text that it receives.

In both uses, the output is the final text only — no change table, no rule-by-rule list, no edit summary. It keeps the input format, and it returns compliant text unchanged. The one exception is a trade-off it could not resolve: if a sentence cannot be simplified without the loss of a fact, a condition, or a hedge, it keeps the long sentence and names it in one line.

It does **not** reproduce ASD's official ~900-word approved dictionary. It applies the underlying *principle* (plainest available word, used the same way every time) rather than checking against a fixed word list. For certified STE-compliant documentation, a human must check the text word by word against the real standard.

## Installation

The skill is self-contained: everything is in `SKILL.md`, and it calls no DevChain tool.
Copy the directory into `~/.claude/skills/` and Claude Code picks it up. Use `~/.claude/skills/asd-ste100-skill/` as the target — the directory name should match
the frontmatter `name`.

Download just this directory out of the monorepo, with [degit](https://github.com/Rich-Harris/degit):

```bash
npx degit TwiTech-LAB/devchain/apps/local-app/skills/asd-ste100-skill \
  ~/.claude/skills/asd-ste100-skill
```

Or with `curl` and `tar`, if you would rather not install anything:

```bash
mkdir -p ~/.claude/skills/asd-ste100-skill && \
curl -sL https://codeload.github.com/TwiTech-LAB/devchain/tar.gz/refs/heads/main \
  | tar -xz -C ~/.claude/skills/asd-ste100-skill --strip-components=5 \
    "devchain-main/apps/local-app/skills/asd-ste100-skill"
```

Both commands track `main`. There is no separate release tag for this skill — to update, run
the same command again and overwrite.

## Usage

Trigger with a request to write or rewrite English text in STE:

```
Apply ASD-STE100 to this tool description
Rewrite this error message so an agent can't misparse it
STE rewrite this instruction
Write the epic description in STE
```

Or paste text and ask Claude to "reduce ambiguity in this output."

> Do not trigger this with "simplify" alone — `devchain/code-simplifier` (and Claude Code's
> built-in `/simplify`) handle *code*. Say "STE" or "ASD-STE100" so the right skill loads.

## Scope

Built for: agent-to-agent messages, tool/function descriptions, error messages, system prompts, inter-agent instructions — any English text a machine or non-native reader has to parse without a human to ask.

Not built for: creative writing, marketing copy, or anything where voice and nuance are the point — STE is deliberately flat and literal by design.

## Sources

- [ASD-STE100 official site](https://www.asd-ste100.org/)
- [ASD-STE100 — About STE](https://www.asd-ste100.org/about_STE.html)
- [ASD Europe — Simplified Technical English](https://www.asd-europe.org/standards-specifications/simplified-technical-english/)
- [Simplified Technical English — Wikipedia](https://en.wikipedia.org/wiki/Simplified_Technical_English)
- [TechScribe — ASD-STE100 Simplified Technical English](https://www.techscribe.co.uk/techw/asd-simplified-technical-english.htm)

## Credits

Adapted for DevChain from [`danyuchn/asd-ste100-skill`](https://github.com/danyuchn/asd-ste100-skill)
by Dustin Yuchen Teng.

## License

MIT — see [LICENSE](LICENSE).
