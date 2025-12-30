export const DOCUMENT_TOOLS_ENABLED = false;
export const CHAT_TOOLS_ENABLED = false;
export const RECORDS_TOOLS_ENABLED = false;
export const ACTIVITY_TOOLS_ENABLED = false;

export const DOCUMENT_TOOL_NAMES = [
  'devchain_list_documents',
  'devchain_get_document',
  'devchain_create_document',
  'devchain_update_document',
];

// Chat "thread" tools (send_message is intentionally not gated here).
export const CHAT_TOOL_NAMES = [
  'devchain_chat_ack',
  'devchain_chat_read_history',
  'devchain_chat_list_members',
];
export const RECORDS_TOOL_NAMES = [
  'devchain_create_record',
  'devchain_update_record',
  'devchain_get_record',
  'devchain_list_records',
  'devchain_add_tags',
  'devchain_remove_tags',
];
export const ACTIVITY_TOOL_NAMES = ['devchain_activity_start', 'devchain_activity_finish'];

export function filterHiddenTools<T extends { name: string }>(tools: T[]): T[] {
  const hidden = new Set<string>();
  if (!DOCUMENT_TOOLS_ENABLED) {
    DOCUMENT_TOOL_NAMES.forEach((name) => hidden.add(name));
  }
  if (!CHAT_TOOLS_ENABLED) {
    CHAT_TOOL_NAMES.forEach((name) => hidden.add(name));
  }
  if (!RECORDS_TOOLS_ENABLED) {
    RECORDS_TOOL_NAMES.forEach((name) => hidden.add(name));
  }
  if (!ACTIVITY_TOOLS_ENABLED) {
    ACTIVITY_TOOL_NAMES.forEach((name) => hidden.add(name));
  }
  if (!hidden.size) return tools;
  return tools.filter((tool) => !hidden.has(tool.name));
}
