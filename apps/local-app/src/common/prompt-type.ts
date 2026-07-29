import { parseTag } from './tags';

export const PROMPT_TYPE = {
  System: 'system',
  Custom: 'custom',
} as const;

export type PromptType = (typeof PROMPT_TYPE)[keyof typeof PROMPT_TYPE];

export const PROMPT_TYPE_TAG = {
  [PROMPT_TYPE.System]: 'type:system',
  [PROMPT_TYPE.Custom]: 'type:custom',
} as const satisfies Record<PromptType, string>;

const TYPE_TAG_KEY = 'type';

export function isPromptTypeTag(tag: string): boolean {
  const parsed = parseTag(tag);
  return parsed.isKeyValue && parsed.key?.trim().toLowerCase() === TYPE_TAG_KEY;
}

function getTypeTagValue(tag: string): string | null {
  if (!isPromptTypeTag(tag)) {
    return null;
  }

  const parsed = parseTag(tag);
  return parsed.value?.trim().toLowerCase() ?? null;
}

export function getPromptType(tags: readonly string[], untypedFallback: PromptType): PromptType {
  let hasTypeTag = false;

  for (const tag of tags) {
    const value = getTypeTagValue(tag);
    if (value === null) {
      continue;
    }

    hasTypeTag = true;
    if (value === PROMPT_TYPE.System) {
      return PROMPT_TYPE.System;
    }
  }

  return hasTypeTag ? PROMPT_TYPE.Custom : untypedFallback;
}

export function canonicalizePromptTypeTags(
  tags: readonly string[],
  promptType: PromptType,
): string[] {
  const unrelatedTags = tags.filter((tag) => !isPromptTypeTag(tag));
  return [...unrelatedTags, PROMPT_TYPE_TAG[promptType]];
}
