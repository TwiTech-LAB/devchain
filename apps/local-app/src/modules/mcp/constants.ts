export const RECORDS_TOOLS_ENABLED = false;

export const RECORDS_TOOL_NAMES = [
  'devchain_create_record',
  'devchain_update_record',
  'devchain_get_record',
  'devchain_list_records',
  'devchain_add_tags',
  'devchain_remove_tags',
];

export function filterHiddenTools<T extends { name: string }>(tools: T[]): T[] {
  const hidden = new Set<string>();
  if (!RECORDS_TOOLS_ENABLED) {
    RECORDS_TOOL_NAMES.forEach((name) => hidden.add(name));
  }
  if (!hidden.size) return tools;
  return tools.filter((tool) => !hidden.has(tool.name));
}
