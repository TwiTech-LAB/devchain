import {
  canonicalizeRichDocument,
  isSafeRichLinkHref,
  richDocumentFingerprint,
  RICH_MAX_BLOCK_COUNT,
  RICH_MAX_NODE_COUNT,
  RICH_MAX_TEXT_RUN_LENGTH,
  RICH_MAX_TOTAL_TEXT_LENGTH,
  type ExternalRichDocumentV1,
} from './external-rich-document';

// Pure schema/normalization contract — the cheapest reliable layer because the
// model has no I/O or DI.

type Fixture = Record<string, unknown>;

function asDocument(value: Fixture): ExternalRichDocumentV1 {
  return value as unknown as ExternalRichDocumentV1;
}

function textRun(
  text: string,
  marks: Array<Record<string, unknown>> = [],
): Record<string, unknown> {
  return { type: 'text', text, marks };
}

describe('ExternalRichDocumentV1', () => {
  describe('closed schema', () => {
    it('accepts the full closed block and mark inventory', () => {
      const document = {
        version: 1,
        blocks: [
          { type: 'paragraph', content: [textRun('plain')] },
          {
            type: 'heading',
            level: 3,
            content: [
              textRun('mixed', [{ type: 'bold' }, { type: 'italic' }]),
              { type: 'hardBreak' },
            ],
          },
          { type: 'bulletList', items: [[textRun('one')], [textRun('two', [{ type: 'code' }])]] },
          {
            type: 'blockquote',
            paragraphs: [[textRun('quoted', [{ type: 'link', href: 'https://example.com/a' }])]],
          },
        ],
      };
      const canonical = canonicalizeRichDocument(document);
      expect(canonical).not.toBeNull();
      expect(canonical!.blocks).toHaveLength(4);
    });

    it('rejects unknown node types, mark types, and heading levels', () => {
      expect(canonicalizeRichDocument({ version: 1, blocks: [{ type: 'table' }] })).toBeNull();
      expect(
        canonicalizeRichDocument({
          version: 1,
          blocks: [{ type: 'paragraph', content: [textRun('x', [{ type: 'underline' }])] }],
        }),
      ).toBeNull();
      expect(
        canonicalizeRichDocument({
          version: 1,
          blocks: [{ type: 'heading', level: 7, content: [textRun('x')] }],
        }),
      ).toBeNull();
      expect(canonicalizeRichDocument({ version: 2, blocks: [] })).toBeNull();
      expect(
        canonicalizeRichDocument({ version: 1, blocks: [{ type: 'orderedList', items: [] }] }),
      ).toBeNull();
    });

    it('rejects unsafe link hrefs', () => {
      for (const href of [
        'javascript:alert(1)',
        'data:text/html;base64,AAA',
        'ftp://example.com/file',
        'https://user:pass@example.com',
        'not a url',
        '',
      ]) {
        expect(isSafeRichLinkHref(href)).toBe(false);
        expect(
          canonicalizeRichDocument({
            version: 1,
            blocks: [{ type: 'paragraph', content: [textRun('x', [{ type: 'link', href }])] }],
          }),
        ).toBeNull();
      }
      expect(isSafeRichLinkHref('https://example.com/a?b=c#d')).toBe(true);
      expect(isSafeRichLinkHref('http://example.com')).toBe(true);
    });
  });

  describe('normalization', () => {
    it('merges adjacent runs with equal mark sets and collapses whitespace', () => {
      const canonical = canonicalizeRichDocument({
        version: 1,
        blocks: [
          {
            type: 'paragraph',
            content: [
              textRun('hello '),
              textRun('world', [{ type: 'bold' }]),
              textRun(' and', [{ type: 'bold' }]),
              textRun(' more\t\ttext  '),
            ],
          },
        ],
      });
      expect(canonical!.blocks[0]).toEqual({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'hello ', marks: [] },
          { type: 'text', text: 'world and', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' more text', marks: [] },
        ],
      });
    });

    it('sorts marks into canonical order regardless of input order and dedupes', () => {
      const canonical = canonicalizeRichDocument({
        version: 1,
        blocks: [
          {
            type: 'paragraph',
            content: [
              textRun('x', [
                { type: 'link', href: 'https://example.com' },
                { type: 'bold' },
                { type: 'bold' },
              ]),
            ],
          },
        ],
      });
      expect(canonical!.blocks[0]!.content[0]).toEqual({
        type: 'text',
        text: 'x',
        marks: [{ type: 'bold' }, { type: 'link', href: 'https://example.com' }],
      });
    });

    it('trims insignificant edge whitespace but keeps interior boundary spaces', () => {
      const canonical = canonicalizeRichDocument({
        version: 1,
        blocks: [
          {
            type: 'paragraph',
            content: [
              textRun('  lead'),
              textRun(' '),
              textRun('bold', [{ type: 'bold' }]),
              textRun(' tail  '),
            ],
          },
        ],
      });
      expect(canonical!.blocks[0]).toEqual({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'lead ', marks: [] },
          { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' tail', marks: [] },
        ],
      });
    });

    it('drops empty blocks and empty documents', () => {
      expect(canonicalizeRichDocument({ version: 1, blocks: [] })).toBeNull();
      expect(
        canonicalizeRichDocument({ version: 1, blocks: [{ type: 'paragraph', content: [] }] }),
      ).toBeNull();
      expect(
        canonicalizeRichDocument({
          version: 1,
          blocks: [{ type: 'paragraph', content: [textRun('   ')] }],
        }),
      ).toBeNull();
    });

    it('produces identical fingerprints for semantically identical documents', () => {
      const left = {
        version: 1,
        blocks: [
          {
            type: 'paragraph',
            content: [textRun('a '), textRun('b', [{ type: 'bold' }]), textRun(' c')],
          },
        ],
      };
      // The boundary space moved into an adjacent same-mark run plus a
      // trailing empty run: representation differs, semantics do not.
      const equivalent = {
        version: 1,
        blocks: [
          {
            type: 'paragraph',
            content: [
              textRun('a'),
              textRun(' '),
              textRun('b', [{ type: 'bold' }]),
              textRun(' c'),
              textRun(''),
            ],
          },
        ],
      };
      const different = {
        version: 1,
        blocks: [
          {
            type: 'paragraph',
            content: [textRun('a '), textRun('b c', [{ type: 'bold' }])],
          },
        ],
      };
      expect(richDocumentFingerprint(asDocument(left))).toBe(
        richDocumentFingerprint(asDocument(equivalent)),
      );
      expect(richDocumentFingerprint(asDocument(left))).not.toBe(
        richDocumentFingerprint(asDocument(different)),
      );
    });
  });

  describe('limits fail closed', () => {
    it('rejects over-depth nesting', () => {
      let block: Record<string, unknown> = { type: 'paragraph', content: [textRun('deep')] };
      for (let depth = 0; depth < 64; depth += 1) {
        block = { type: 'blockquote', paragraphs: [[block]] };
      }
      expect(canonicalizeRichDocument({ version: 1, blocks: [block] })).toBeNull();
    });

    it('rejects over-count blocks and nodes', () => {
      const blocks = Array.from({ length: RICH_MAX_BLOCK_COUNT + 1 }, () => ({
        type: 'paragraph',
        content: [textRun('x')],
      }));
      expect(canonicalizeRichDocument({ version: 1, blocks })).toBeNull();

      const manyNodes = {
        type: 'paragraph',
        content: Array.from({ length: RICH_MAX_NODE_COUNT + 1 }, () => textRun('x')),
      };
      expect(canonicalizeRichDocument({ version: 1, blocks: [manyNodes] })).toBeNull();
    });

    it('rejects oversized text runs and total text', () => {
      const oversized = {
        type: 'paragraph',
        content: [textRun('a'.repeat(RICH_MAX_TEXT_RUN_LENGTH + 1))],
      };
      expect(canonicalizeRichDocument({ version: 1, blocks: [oversized] })).toBeNull();

      const runCount = Math.ceil(RICH_MAX_TOTAL_TEXT_LENGTH / RICH_MAX_TEXT_RUN_LENGTH) + 1;
      const totalBlocks = Array.from({ length: runCount }, () => ({
        type: 'paragraph',
        content: [textRun('a'.repeat(RICH_MAX_TEXT_RUN_LENGTH))],
      }));
      expect(canonicalizeRichDocument({ version: 1, blocks: totalBlocks })).toBeNull();
    });
  });
});
