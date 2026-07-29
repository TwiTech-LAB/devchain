import {
  canonicalizePromptTypeTags,
  getPromptType,
  isPromptTypeTag,
  PROMPT_TYPE,
  PROMPT_TYPE_TAG,
} from './prompt-type';

describe('prompt type tags', () => {
  describe('getPromptType', () => {
    it('recognizes canonical tags after trimming and case folding', () => {
      expect(getPromptType([' Type : SYSTEM '], PROMPT_TYPE.Custom)).toBe(PROMPT_TYPE.System);
      expect(getPromptType([' TYPE : CUSTOM '], PROMPT_TYPE.System)).toBe(PROMPT_TYPE.Custom);
    });

    it('gives explicit System precedence over other type tags', () => {
      expect(getPromptType(['type:custom', 'type:future', 'TYPE:SYSTEM'], PROMPT_TYPE.Custom)).toBe(
        PROMPT_TYPE.System,
      );
    });

    it('classifies unknown explicit types conservatively as Custom', () => {
      expect(getPromptType(['type:future'], PROMPT_TYPE.System)).toBe(PROMPT_TYPE.Custom);
    });

    it('uses the caller-supplied fallback only when tags are untyped', () => {
      expect(getPromptType(['feature', 'scope:local'], PROMPT_TYPE.System)).toBe(
        PROMPT_TYPE.System,
      );
      expect(getPromptType([], PROMPT_TYPE.Custom)).toBe(PROMPT_TYPE.Custom);
    });
  });

  describe('canonicalizePromptTypeTags', () => {
    it('preserves unrelated tag order and appends exactly one requested canonical type', () => {
      expect(
        canonicalizePromptTypeTags(
          ['first', 'type:custom', 'scope:local', ' TYPE : future ', 'last'],
          PROMPT_TYPE.System,
        ),
      ).toEqual(['first', 'scope:local', 'last', PROMPT_TYPE_TAG.system]);
    });
  });

  describe('isPromptTypeTag', () => {
    it('recognizes reserved type tags using the shared key:value grammar', () => {
      expect(isPromptTypeTag(' Type : system ')).toBe(true);
      expect(isPromptTypeTag('category:type')).toBe(false);
      expect(isPromptTypeTag('type')).toBe(false);
    });
  });
});
