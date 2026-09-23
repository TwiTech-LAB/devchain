import { applyEpicDescriptionEdits, type EpicDescriptionEdit } from './apply-description-edits';
import {
  DescriptionEditAmbiguousError,
  DescriptionEditNotFoundError,
} from '../../../common/errors/error-types';

describe('applyEpicDescriptionEdits', () => {
  describe('single edit', () => {
    it('replaces a unique find and reports the final text, context, and length', () => {
      const result = applyEpicDescriptionEdits({
        text: 'Alpha beta gamma',
        edits: [{ find: 'beta', replace: 'BETA' }],
      });

      expect(result.text).toBe('Alpha BETA gamma');
      expect(result.descriptionLength).toBe(16);
      expect(result.descriptionEdits).toEqual([{ index: 0, context: 'Alpha BETA gamma' }]);
      expect(result.appended).toBeUndefined();
    });

    it('keeps $&, $1, and $$ in replace as plain text', () => {
      const result = applyEpicDescriptionEdits({
        text: 'price: 10',
        edits: [{ find: '10', replace: '$& $1 $$' }],
      });

      expect(result.text).toBe('price: $& $1 $$');
    });

    it('never treats find as a pattern', () => {
      const result = applyEpicDescriptionEdits({
        text: 'a.c and abc',
        edits: [{ find: 'a.c', replace: 'X' }],
      });

      expect(result.text).toBe('X and abc');
    });
  });

  describe('multiple edits', () => {
    it('applies edits in order', () => {
      const result = applyEpicDescriptionEdits({
        text: 'one two three',
        edits: [
          { find: 'one', replace: '1' },
          { find: 'three', replace: '3' },
        ],
      });

      expect(result.text).toBe('1 two 3');
      expect(result.descriptionEdits).toHaveLength(2);
    });

    it('tracks earlier spans through later edits that shift them', () => {
      // Edit 0 replaces 'bbb' with 'XX'; edit 1 then shrinks the text before
      // that span, so edit 0's context must come from the shifted final text.
      const result = applyEpicDescriptionEdits({
        text: 'aaa bbb ccc',
        edits: [
          { find: 'bbb', replace: 'XX' },
          { find: 'aaa', replace: 'Y' },
        ],
      });

      expect(result.text).toBe('Y XX ccc');
      expect(result.descriptionEdits![0].context).toBe('Y XX ccc');
      expect(result.descriptionEdits![1].context).toBe('Y XX ccc');
    });

    it('grows an earlier span when a later edit lands inside its replacement', () => {
      const result = applyEpicDescriptionEdits({
        text: 'aaa bbb ccc',
        edits: [
          { find: 'bbb', replace: 'XX' },
          { find: 'XX', replace: 'Z' },
        ],
      });

      expect(result.text).toBe('aaa Z ccc');
      // The first span covers the full union 'Z' after the nested replacement.
      expect(result.descriptionEdits![0].context).toBe('aaa Z ccc');
      expect(result.descriptionEdits![1].context).toBe('aaa Z ccc');
    });
  });

  describe('match failures', () => {
    it('throws DESCRIPTION_EDIT_NOT_FOUND data for zero matches', () => {
      let caught: unknown;
      try {
        applyEpicDescriptionEdits({
          text: 'alpha beta',
          edits: [{ find: 'gamma', replace: 'X' }],
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(DescriptionEditNotFoundError);
      const error = caught as DescriptionEditNotFoundError;
      expect(error.details).toEqual({ index: 0, find: 'gamma', matchCount: 0 });
    });

    it('throws DESCRIPTION_EDIT_AMBIGUOUS counting overlapping occurrences', () => {
      let caught: unknown;
      try {
        applyEpicDescriptionEdits({
          text: 'aaa',
          edits: [{ find: 'aa', replace: 'X' }],
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(DescriptionEditAmbiguousError);
      const error = caught as DescriptionEditAmbiguousError;
      expect(error.details).toEqual({ index: 0, find: 'aa', matchCount: 2 });
    });

    it('reports the failing edit index for a later edit', () => {
      const edits: EpicDescriptionEdit[] = [
        { find: 'one', replace: '1' },
        { find: 'zz', replace: 'q' },
      ];

      expect(() => applyEpicDescriptionEdits({ text: 'one zz zz', edits })).toThrow(
        DescriptionEditAmbiguousError,
      );
      try {
        applyEpicDescriptionEdits({ text: 'one zz zz', edits });
      } catch (error) {
        expect((error as DescriptionEditAmbiguousError).details).toEqual({
          index: 1,
          find: 'zz',
          matchCount: 2,
        });
      }
    });

    it('treats a null description with edits as not found', () => {
      expect(() =>
        applyEpicDescriptionEdits({
          text: null,
          edits: [{ find: 'x', replace: 'y' }],
        }),
      ).toThrow(DescriptionEditNotFoundError);
    });

    it('treats an empty find as no match instead of matching everywhere', () => {
      expect(() =>
        applyEpicDescriptionEdits({
          text: 'abc',
          edits: [{ find: '', replace: 'y' }],
        }),
      ).toThrow(DescriptionEditNotFoundError);
    });
  });

  describe('append', () => {
    it('appends with a blank line after non-empty text', () => {
      const result = applyEpicDescriptionEdits({ text: 'first', append: 'second' });

      expect(result.text).toBe('first\n\nsecond');
      expect(result.descriptionLength).toBe(13);
      expect(result.appended).toEqual({ context: 'first\n\nsecond' });
      expect(result.descriptionEdits).toBeUndefined();
    });

    it('makes the append the whole text for a null description', () => {
      const result = applyEpicDescriptionEdits({ text: null, append: 'only' });

      expect(result.text).toBe('only');
      expect(result.appended).toEqual({ context: 'only' });
    });

    it('makes the append the whole text for an empty description', () => {
      const result = applyEpicDescriptionEdits({ text: '', append: 'only' });

      expect(result.text).toBe('only');
      expect(result.appended).toEqual({ context: 'only' });
    });

    it('caps the append context at the last 160 characters before the append point plus 400 total', () => {
      const result = applyEpicDescriptionEdits({
        text: 'x'.repeat(200),
        append: 'y'.repeat(500),
      });

      const expected = `${'x'.repeat(160)}\n\n${'y'.repeat(238)}`;
      expect(result.appended).toEqual({ context: expected });
      expect(result.appended!.context.length).toBe(400);
    });

    it('combines edits with an append', () => {
      const result = applyEpicDescriptionEdits({
        text: 'a b',
        edits: [{ find: 'a', replace: 'A' }],
        append: 'c',
      });

      expect(result.text).toBe('A b\n\nc');
      expect(result.descriptionEdits).toEqual([{ index: 0, context: 'A b\n\nc' }]);
      expect(result.appended).toEqual({ context: 'A b\n\nc' });
    });
  });

  describe('context windows', () => {
    const longText = `${'A'.repeat(100)}TARGET${'B'.repeat(100)}`;

    it('uses up to 80 characters per side and marks window cuts with an ellipsis', () => {
      const result = applyEpicDescriptionEdits({
        text: longText,
        edits: [{ find: 'TARGET', replace: 'X' }],
      });

      expect(result.descriptionEdits![0].context).toBe(`…${'A'.repeat(80)}X${'B'.repeat(80)}…`);
    });

    it('adds no ellipsis at the text bounds', () => {
      const result = applyEpicDescriptionEdits({
        text: 'HEAD TAIL',
        edits: [{ find: 'TAIL', replace: 'T' }],
      });

      expect(result.descriptionEdits![0].context).toBe('HEAD T');
    });
  });
});
