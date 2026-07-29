export interface ParsedTag {
  original: string;
  key: string | null;
  value: string | null;
  isKeyValue: boolean;
}

export function parseTag(tag: string): ParsedTag {
  const colonIndex = tag.indexOf(':');

  if (colonIndex === -1 || colonIndex === 0 || colonIndex === tag.length - 1) {
    return {
      original: tag,
      key: null,
      value: null,
      isKeyValue: false,
    };
  }

  return {
    original: tag,
    key: tag.substring(0, colonIndex),
    value: tag.substring(colonIndex + 1),
    isKeyValue: true,
  };
}
