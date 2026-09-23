---
name: asd-ste100-skill
displayName: Simplified Technical English (ASD-STE100)
description: "Write or rewrite English with ASD-STE100 Simplified Technical English rules: one meaning per word, active voice, simple tenses, one instruction per sentence. Use for plans, reports, and user-facing messages, epic and task descriptions, tool descriptions, error messages, system prompts, and inter-agent instructions — any text a reader must understand with no follow-up questions. Triggers: STE, ASD-STE100, make this readable, reduce ambiguity."
version: 0.4.0
license: "MIT — adapted from danyuchn/asd-ste100-skill (https://github.com/danyuchn/asd-ste100-skill)"
---

# Simplified Technical English (ASD-STE100)

Use these rules for text that a reader must understand with no follow-up questions: human
users, non-native readers, and other agents. Do not use them for creative, marketing, or
persuasive copy.

There are two uses:
- **Write:** apply the rules while you write your own text. Do not write a draft and then
  rewrite it.
- **Rewrite:** apply the rules to text that you receive.

## Output

Output only the final text. Do not add a change table, a list of broken rules, a summary,
or a preamble.

- Keep the format of the input: the same headings, tables, lists, and code blocks.
- If the received text already obeys the rules, return it unchanged.
- If you cannot simplify a sentence without the loss of a fact, a condition, or a hedge,
  keep the long sentence. Name it in one line after the text.

## Rules

| Rule | Do | Not |
|---|---|---|
| One meaning per word | Use one word for one action, everywhere | `check`, `verify`, and `confirm` for the same action |
| Active voice | "The agent deletes the file." | "The file is deleted." Use passive only when the actor is unknown. |
| Simple tenses | "We received the report." | "We have received the report." |
| `-ing` as a noun only | "during processing" | "The tool is processing the queue." |
| One instruction per sentence | "Open the file. Read line 3." | "Open the file and read line 3, then check it." |
| Short sentences | ≤20 words for an instruction, ≤25 for a description | Stacked subordinate clauses |
| Short noun clusters | ≤3 nouns: "fuel pump valve" | "high pressure fuel pump inlet valve assembly" |
| No dropped words | Keep the subject, verb, and article | "Files not backed up will be lost." (Which files?) |
| Warning first | "Warning: a timeout can produce a partial artifact." | A condition buried mid-sentence |
| Lists for sequences | A numbered list for 3 or more steps or conditions | A sequence buried in prose |
| Plain words | "use", "start", "before", "validate the file" | "utilize", "initiate", "prior to", "perform validation of the file" |
| Domain terms | Keep a necessary technical term. Define it once. | Undefined jargon |

## Limits

- Never drop a fact, condition, exception, or scope qualifier to make a sentence shorter.
- Keep real uncertainty. Do not change "may", "might", or "we plan to" into certainty.
- Never change code, identifiers, file paths, numbers, or quoted text.
- For human readers, readability wins over strictness. You can join two short, related
  sentences with "and" or "if" when each part keeps one instruction or claim.
- This skill applies STE principles, not the official ASD dictionary. Its output is not
  certified STE. Do not search the web for the standard.

## Examples

**Tool description**
> Before: This tool will attempt to synchronize state across the various backends that have been configured, and if a conflict is detected it may resolve it automatically depending on the strategy that has been set, or otherwise it will surface the conflict for manual review.
>
> After: The tool synchronizes state across the configured backends. If it finds a conflict, it checks the current strategy. If the strategy allows automatic resolution, the tool resolves the conflict. If not, the tool reports the conflict for manual review.

**Error message**
> Before: An error may have occurred while processing your request due to a possible mismatch in the expected data format, which could be caused by an outdated client version.
>
> After: The request failed. The data format did not match the format that the server expects. An outdated client version can cause this error.

**Inter-agent instruction**
> Before: Once the upstream job has completed and assuming no errors were raised, the downstream agent should proceed to consume the output artifact, though it is worth noting that partial artifacts are sometimes produced under timeout conditions.
>
> After: Wait until the upstream job finishes with no errors. Then read the output artifact. Warning: a timeout can produce a partial artifact. Make sure that the artifact is complete before you use it.
