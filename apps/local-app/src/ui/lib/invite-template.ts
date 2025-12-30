export const TEMPLATE_SIZE_LIMIT = 4096;

export const DEFAULT_INVITE_TEMPLATE = `Welcome {{ invited_agent_name }} to thread "{{ thread_title }}" ({{ thread_id }}).
Invited by {{ inviter_name }} on {{ created_at }}.
Participants: {{ participant_names }}

Please review prior context:
{{ mcp_read_history_cmd }}

See who is here:
{{ mcp_list_members_cmd }}

When you are ready, please acknowledge:
{{ mcp_ack_hint }}`;

export const ALLOWED_TEMPLATE_TOKENS = [
  'thread_id',
  'thread_title',
  'inviter_name',
  'participant_names',
  'invited_agent_name',
  'created_at',
  'mcp_read_history_cmd',
  'mcp_ack_hint',
  'mcp_list_members_cmd',
];

const TEMPLATE_TOKEN_REGEX = /\{\{\s*([\w]+)\s*\}\}/g;

export interface InviteTemplateContext {
  threadId: string;
  threadTitle: string;
  inviterName: string;
  participantNames: string;
  invitedAgentName: string;
  createdAt: string;
  messageId?: string;
  historyLimit?: number;
}

export function extractTemplateTokens(template: string): string[] {
  const tokens: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = TEMPLATE_TOKEN_REGEX.exec(template)) !== null) {
    tokens.push(match[1]);
  }

  return tokens;
}

export function findUnknownTokens(template: string): string[] {
  const tokens = extractTemplateTokens(template);
  const unknown = new Set<string>();

  for (const token of tokens) {
    if (!ALLOWED_TEMPLATE_TOKENS.includes(token)) {
      unknown.add(token);
    }
  }

  return Array.from(unknown);
}

export function renderInviteTemplate(template: string, context: InviteTemplateContext): string {
  const effectiveTemplate =
    template && template.trim().length > 0 ? template : DEFAULT_INVITE_TEMPLATE;

  const historyLimit = context.historyLimit ?? 50;
  const messageId = context.messageId ?? 'preview-message-id';

  const replacements: Record<string, string> = {
    thread_id: context.threadId,
    thread_title: context.threadTitle,
    inviter_name: context.inviterName,
    participant_names: context.participantNames || 'Unknown',
    invited_agent_name: context.invitedAgentName,
    created_at: context.createdAt,
    mcp_read_history_cmd: `tools/call { name: "devchain_chat_read_history", arguments: { thread_id: "${context.threadId}", limit: ${historyLimit} } }`,
    mcp_ack_hint: `tools/call { name: "devchain_chat_ack", arguments: { thread_id: "${context.threadId}", message_id: "${messageId}", agent_name: "${context.invitedAgentName}" } }`,
    mcp_list_members_cmd: `tools/call { name: "devchain_chat_list_members", arguments: { thread_id: "${context.threadId}" } }`,
  };

  return effectiveTemplate.replace(TEMPLATE_TOKEN_REGEX, (match, key) => {
    return replacements[key] ?? match;
  });
}

export const INVITE_TEMPLATE_VARIABLES: Array<{
  token: string;
  label: string;
  description: string;
}> = [
  {
    token: 'thread_id',
    label: 'Thread ID',
    description: 'UUID of the active chat thread.',
  },
  {
    token: 'thread_title',
    label: 'Thread Title',
    description: 'Display title or generated name for the thread.',
  },
  {
    token: 'inviter_name',
    label: 'Inviter Name',
    description: 'Display name of the user sending the invite.',
  },
  {
    token: 'participant_names',
    label: 'Participant Names',
    description: 'Comma-separated agent names currently in the thread.',
  },
  {
    token: 'invited_agent_name',
    label: 'Invited Agent Name',
    description: 'Name of the agent being invited.',
  },
  {
    token: 'created_at',
    label: 'Created At',
    description: 'ISO timestamp when the invite is generated.',
  },
];

export const INVITE_TEMPLATE_SNIPPETS: Array<{
  token: string;
  label: string;
  description: string;
}> = [
  {
    token: 'mcp_read_history_cmd',
    label: 'History Command',
    description: 'Insert MCP command for agents to read prior chat history.',
  },
  {
    token: 'mcp_list_members_cmd',
    label: 'List Members Command',
    description: 'Insert MCP command for agents to list current participants.',
  },
  {
    token: 'mcp_ack_hint',
    label: 'Ack Command',
    description: 'Insert MCP acknowledgement hint for the invite message.',
  },
];
