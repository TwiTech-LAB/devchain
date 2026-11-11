import { VaultListParamsSchema, VaultRequestParamsSchema } from '../dtos/mcp.dto';
import type { ToolMetadataEntry } from './types';

export const vaultMetadata: ToolMetadataEntry[] = [
  {
    name: 'devchain_vault_list',
    description:
      "List the Vault entries your agent can use: name, kind, description, status (`available`, or `vault_locked` until the user unlocks the Vault) and `approvalRequired` (the user must approve your session's use: `devchain vault exec` stops, DevChain asks the user, and after the approval notice you run the command again). Never returns a value. The response also has `instructions` on how to use the entries. Vault values are not in your environment: run a command with `devchain vault exec --only NAME -- <command>`, and only that command gets $NAME (a `file` entry gives a file path). Never print a value, write it to a repository file or post it. Ask for a missing secret with devchain_vault_request.",
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: {
          type: 'string',
          minLength: 8,
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: VaultListParamsSchema,
  },
  {
    name: 'devchain_vault_request',
    description:
      'Ask the user for a Vault entry you need. Returns at once and never blocks: `available` when you already have it; otherwise `pending` with a requestId (or `already_pending` for the same name). The user answers in the DevChain UI; you then get a message saying the secret is available (use `devchain vault exec --only NAME -- <cmd>`) or that the user denied it. Never send a value: there is no field for one.',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'name', 'description'],
      properties: {
        sessionId: {
          type: 'string',
          minLength: 8,
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 255,
          description:
            'Environment variable name of the entry, e.g. STRIPE_API_KEY: letters, digits and underscores, not starting with a digit',
        },
        description: {
          type: 'string',
          minLength: 1,
          maxLength: 1000,
          description: 'What the secret is and why you need it; the user sees this',
        },
        kind: {
          type: 'string',
          enum: ['secret', 'file'],
          description:
            'For a new entry: `secret` (single-line value, the default) or `file` (multi-line value such as a PEM key)',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: VaultRequestParamsSchema,
  },
];
