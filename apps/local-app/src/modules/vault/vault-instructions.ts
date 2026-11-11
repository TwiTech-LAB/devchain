/**
 * How agents use the Vault. The `devchain_vault_list` response owns the usage rules;
 * the initial-prompt block only points at the tool and repeats the never-print rule.
 * Agents act on the rules verbatim, so the never-print rule comes first. Keep the
 * `devchain_vault_request` tool description consistent with them.
 */
const NEVER_PRINT =
  '- Never print a Vault value. Never write one to a file in the repository, and never put one in a message, comment or commit.';
const EXEC =
  '- To use secrets, run the command through `devchain vault exec --only NAME,NAME2 -- <command> [args…]`. Only that command gets them, as $NAME; a file entry gives the path of a file. Example: `devchain vault exec --only API_TOKEN -- sh -c \'curl -H "Authorization: Bearer $API_TOKEN" https://api.example.com\'`';
const ONLY = '- Always name the entries the command needs with --only.';
const REQUEST =
  '- If you need a secret you do not have, call devchain_vault_request. Never ask for a secret value in a message.';
const APPROVAL =
  "- An entry can need the user's approval. Then `devchain vault exec` stops and DevChain asks the user. When you get the approval notice, run the command again.";
const LOCKED =
  '- Status vault_locked: the user must unlock the Vault in DevChain before `devchain vault exec` can give that entry.';

/**
 * Appended to the initial prompt of an agent with Vault access: a pointer at
 * `devchain_vault_list`, which owns the usage rules, plus the never-print rule —
 * the one rule that must hold even for an agent that never calls the tool.
 */
export function vaultInstructionBlock(grantedEntryCount: number): string {
  const count = grantedEntryCount === 0 ? 'no' : grantedEntryCount;
  const noun = grantedEntryCount === 1 ? 'entry' : 'entries';
  const granted = `You have ${count} granted Vault ${noun} now.`;
  return [
    `Vault: DevChain keeps secrets (API keys, tokens, key files) for this project in its Vault. ${granted} Call devchain_vault_list with your sessionId to see them and how to use them.`,
    NEVER_PRINT,
  ].join('\n');
}

/** The `instructions` of a `devchain_vault_list` response. */
export function vaultListInstructions(): string {
  return [NEVER_PRINT, EXEC, ONLY, REQUEST, APPROVAL, LOCKED].join('\n');
}
