import { adfToRichDocument, richDocumentToAdf } from '../adapters/rich/jira-adf-converter';
import {
  markdownToRichDocument,
  richDocumentToMarkdown,
} from '../adapters/rich/clickup-markdown-converter';
import {
  clickupCommentDeltaToRichDocument,
  richDocumentToClickUpCommentDelta,
} from '../adapters/rich/clickup-comment-converter';
import {
  canonicalizeRichDocument,
  richDocumentFingerprint,
  RICH_MAX_BLOCK_COUNT,
  RICH_MAX_DEPTH,
  RICH_MAX_NODE_COUNT,
  RICH_MAX_TEXT_RUN_LENGTH,
  RICH_MAX_TOTAL_TEXT_LENGTH,
  RICH_COMMENT_MAX_SEGMENT_COUNT,
  type ExternalRichDocumentV1,
} from './external-rich-document';

/**
 * Phase-13 gate fixture matrix: one place that exercises every converter
 * direction over the complete supported set plus the hostile inputs
 * (XSS-shaped payloads, unsafe URLs, over-cap documents) and proves the
 * fail-closed fallback. Pure functions — the cheapest reliable layer.
 */

type Fixture = Record<string, unknown>;

function asDoc(value: Fixture): ExternalRichDocumentV1 {
  return value as unknown as ExternalRichDocumentV1;
}

function expectReadonly(result: { supported: boolean; reason?: string }): void {
  expect(result.supported).toBe(false);
}

describe('Phase 13 gate: converter fixture matrix', () => {
  describe('supported ADF set round-trips through canonical in both directions', () => {
    const adfText = (text: string, marks?: Fixture[]) =>
      marks ? { type: 'text', text, marks } : { type: 'text', text };
    const paragraph = (...content: unknown[]) => ({ type: 'paragraph', content });

    const SUPPORTED_ADF_FIXTURES: Array<[string, Fixture]> = [
      ['plain paragraph', { type: 'doc', version: 1, content: [paragraph(adfText('plain'))] }],
      [
        'heading levels',
        {
          type: 'doc',
          version: 1,
          content: [1, 2, 6].map((level) => ({
            type: 'heading',
            attrs: { level },
            content: [adfText(`h${level}`)],
          })),
        },
      ],
      [
        'all marks',
        {
          type: 'doc',
          version: 1,
          content: [
            paragraph(
              adfText('a', [{ type: 'strong' }]),
              adfText('b', [{ type: 'em' }]),
              adfText('c', [{ type: 'code' }]),
              adfText('d', [{ type: 'link', attrs: { href: 'https://example.com/d' } }]),
              adfText('stacked', [{ type: 'strong' }, { type: 'em' }]),
            ),
          ],
        },
      ],
      [
        'bullet list',
        {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'bulletList',
              content: [
                { type: 'listItem', content: [paragraph(adfText('one'))] },
                { type: 'listItem', content: [paragraph(adfText('two'))] },
              ],
            },
          ],
        },
      ],
      [
        'blockquote and hardBreak',
        {
          type: 'doc',
          version: 1,
          content: [
            { type: 'blockquote', content: [paragraph(adfText('quoted'))] },
            paragraph(adfText('line'), { type: 'hardBreak' }, adfText('break')),
          ],
        },
      ],
      [
        'unicode content',
        {
          type: 'doc',
          version: 1,
          content: [paragraph(adfText('héllo wörld 你好 🌍 ⁉️'))],
        },
      ],
    ];

    it.each(SUPPORTED_ADF_FIXTURES)('%s', (_name, adf) => {
      const first = adfToRichDocument(adf);
      expect(first.supported).toBe(true);
      if (!first.supported) {
        return;
      }
      const fingerprint = richDocumentFingerprint(first.document);
      const emitted = richDocumentToAdf(first.document);
      const second = adfToRichDocument(emitted);
      expect(second.supported).toBe(true);
      if (second.supported) {
        expect(richDocumentFingerprint(second.document)).toBe(fingerprint);
      }
    });
  });

  describe('Markdown normalization round-trips', () => {
    const MARKDOWN_FIXTURES: Array<[string, string]> = [
      ['provider bullet style', '# T\n\n*   a\n*   b'],
      ['dash bullets', '# T\n\n- a\n- b'],
      ['underscore and asterisk emphasis', 'has _em_ and *em* text'],
      ['backslash-escaped literals', 'literal \\* \\_ \\[ \\] \\# \\- \\+ \\< \\> \\\\'],
      ['ordered-list-like text', '3\\. fourteen'],
      ['safe URLs', '[a](https://example.com/x) and [b](http://example.com/y)'],
      ['quote line', '> quoted words'],
      ['multi-line paragraph joins', 'first line\nsecond line'],
      ['whitespace-heavy input', '   lots   of \t spaces   '],
      ['unicode content', 'héllo wörld 你好 🌍'],
    ];

    it.each(MARKDOWN_FIXTURES)('%s', (_name, markdown) => {
      const first = markdownToRichDocument(markdown);
      expect(first.supported).toBe(true);
      if (!first.supported) {
        return;
      }
      const fingerprint = richDocumentFingerprint(first.document);
      const emitted = richDocumentToMarkdown(first.document);
      expect(emitted.ok).toBe(true);
      if (!emitted.ok) {
        return;
      }
      const second = markdownToRichDocument(emitted.markdown);
      expect(second.supported).toBe(true);
      if (second.supported) {
        expect(richDocumentFingerprint(second.document)).toBe(fingerprint);
      }
    });
  });

  describe('ClickUp rich comment segments round-trip', () => {
    const DELTA_FIXTURES: Array<[string, Fixture[]]> = [
      ['plain', [{ text: 'plain' }]],
      [
        'all attributes',
        [
          { text: 'b', attributes: { bold: true } },
          { text: 'i', attributes: { italic: true } },
          { text: 'c', attributes: { code: true } },
          { text: 'l', attributes: { link: 'https://example.com/l' } },
        ],
      ],
      ['provider op splitting normalizes', [{ text: 'a' }, { text: 'b' }, { text: 'c' }]],
      ['unicode', [{ text: 'héllo 🌍 你好' }]],
    ];

    it.each(DELTA_FIXTURES)('%s', (_name, delta) => {
      const first = clickupCommentDeltaToRichDocument(delta);
      expect(first.supported).toBe(true);
      if (!first.supported) {
        return;
      }
      const fingerprint = richDocumentFingerprint(first.document);
      const emitted = richDocumentToClickUpCommentDelta(first.document);
      expect(emitted.ok).toBe(true);
      if (!emitted.ok) {
        return;
      }
      const second = clickupCommentDeltaToRichDocument(emitted.delta);
      expect(second.supported).toBe(true);
      if (second.supported) {
        expect(richDocumentFingerprint(second.document)).toBe(fingerprint);
      }
    });
  });

  describe('unsafe URLs fail closed in every converter', () => {
    const UNSAFE_HREFS = [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox(1)',
      'ftp://example.com/f',
      'https://user:pass@example.com/',
      '//example.com/protocol-relative',
      '/relative/path',
      'mailto:someone@example.com',
      '',
      '   ',
    ];

    it.each(UNSAFE_HREFS)('rejects href %j', (href) => {
      const adf = adfToRichDocument({
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href } }] }],
          },
        ],
      });
      expectReadonly(adf);

      const markdown = markdownToRichDocument(`[x](${href})`);
      expectReadonly(markdown);

      const delta = clickupCommentDeltaToRichDocument([{ text: 'x', attributes: { link: href } }]);
      expectReadonly(delta);
    });

    it('accepts the backslash-obfuscated href only because the URL parser neutralizes it', () => {
      // WHATWG parsing resolves https://example.com\@evil.com/ to host
      // example.com with empty userinfo — no credential or host confusion.
      const parsed = new URL('https://example.com\\@evil.com/');
      expect(parsed.hostname).toBe('example.com');
      expect(parsed.username).toBe('');
      const result = markdownToRichDocument('[x](https://example.com\\@evil.com/)');
      expect(result.supported).toBe(true);
    });

    it('rejects direct-model links with unsafe hrefs', () => {
      expect(
        canonicalizeRichDocument({
          version: 1,
          blocks: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'x', marks: [{ type: 'link', href: 'javascript:alert(1)' }] },
              ],
            },
          ],
        }),
      ).toBeNull();
    });
  });

  describe('XSS-shaped inputs stay inert data', () => {
    const XSS_TEXTS = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '"><svg onload=alert(1)>',
      "'; DROP TABLE epics; --",
      '{{7*7}}',
      '${alert(1)}',
      'javascript:alert(1) as plain text',
      '<iframe src="https://evil.example.com"></iframe>',
    ];

    it.each(XSS_TEXTS)('carries %j as literal text with no HTML interpretation', (text) => {
      const adf = adfToRichDocument({
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      });
      expect(adf.supported).toBe(true);
      if (adf.supported) {
        // Emission is JSON data, never HTML: the literal text survives
        // verbatim inside the text node, with no script execution surface.
        const emitted = richDocumentToAdf(adf.document);
        const emittedText = (emitted as { content: Array<{ content: Array<{ text?: string }> }> })
          .content[0]!.content[0]!.text;
        expect(emittedText).toBe(text);
      }

      const delta = clickupCommentDeltaToRichDocument([{ text }]);
      expect(delta.supported).toBe(true);
      if (delta.supported) {
        const emitted = richDocumentToClickUpCommentDelta(delta.document);
        expect(emitted.ok).toBe(true);
        if (emitted.ok) {
          expect(emitted.delta).toEqual([{ text }]);
        }
      }

      // Markdown emission escapes structural characters; the requirement is
      // semantic survival (the text reparses to the same literal content),
      // not byte-identical output.
      const escapedMarkdown = richDocumentToMarkdown({
        version: 1,
        blocks: [{ type: 'paragraph', content: [{ type: 'text', text, marks: [] }] }],
      } as unknown as ExternalRichDocumentV1);
      expect(escapedMarkdown.ok).toBe(true);
      if (escapedMarkdown.ok) {
        const reparsed = markdownToRichDocument(escapedMarkdown.markdown);
        expect(reparsed.supported).toBe(true);
        if (reparsed.supported) {
          const block = reparsed.document.blocks[0];
          expect(block?.type).toBe('paragraph');
          if (block?.type === 'paragraph') {
            expect(block.content[0]?.type).toBe('text');
            if (block.content[0]?.type === 'text') {
              expect(block.content[0].text).toBe(text.replace(/\s+/g, ' ').trim());
            }
          }
        }
      }
    });
  });

  describe('caps fail closed', () => {
    it('rejects over-depth nesting in the canonicalizer', () => {
      let block: Fixture = { type: 'paragraph', content: [{ type: 'text', text: 'deep' }] };
      for (let depth = 0; depth <= RICH_MAX_DEPTH + 1; depth += 1) {
        block = { type: 'blockquote', paragraphs: [[block]] };
      }
      expect(canonicalizeRichDocument({ version: 1, blocks: [block] })).toBeNull();
    });

    it('rejects over-count node documents in ADF', () => {
      const content = Array.from({ length: RICH_MAX_NODE_COUNT + 1 }, () => ({
        type: 'text',
        text: 'x',
      }));
      expectReadonly(
        adfToRichDocument({
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content }],
        }),
      );
    });

    it('rejects over-count blocks', () => {
      const blocks = Array.from({ length: RICH_MAX_BLOCK_COUNT + 1 }, () => ({
        type: 'paragraph',
        content: [{ type: 'text', text: 'x' }],
      }));
      expect(canonicalizeRichDocument({ version: 1, blocks })).toBeNull();
    });

    it('rejects oversized runs and total text', () => {
      const oversizedRun = {
        type: 'paragraph',
        content: [{ type: 'text', text: 'a'.repeat(RICH_MAX_TEXT_RUN_LENGTH + 1) }],
      };
      expect(canonicalizeRichDocument({ version: 1, blocks: [oversizedRun] })).toBeNull();

      const manyBlocks = Array.from(
        { length: Math.ceil(RICH_MAX_TOTAL_TEXT_LENGTH / RICH_MAX_TEXT_RUN_LENGTH) + 1 },
        () => ({
          type: 'paragraph',
          content: [{ type: 'text', text: 'a'.repeat(RICH_MAX_TEXT_RUN_LENGTH) }],
        }),
      );
      expect(canonicalizeRichDocument({ version: 1, blocks: manyBlocks })).toBeNull();
    });

    it('rejects comment deltas over the segment cap', () => {
      const overflow = Array.from({ length: RICH_COMMENT_MAX_SEGMENT_COUNT + 1 }, (_, index) => ({
        text: `s${index}`,
      }));
      expectReadonly(clickupCommentDeltaToRichDocument(overflow));
    });
  });

  describe('unsupported nodes make the whole document read-only', () => {
    const UNSUPPORTED_ADF: Array<[string, Fixture]> = [
      ['table', { type: 'table', content: [] }],
      ['mediaSingle', { type: 'mediaSingle', content: [{ type: 'media', attrs: {} }] }],
      ['panel', { type: 'panel', content: [] }],
      ['extension', { type: 'extension', attrs: {} }],
      ['bodiedExtension', { type: 'bodiedExtension', content: [] }],
      ['orderedList', { type: 'orderedList', content: [] }],
      ['codeBlock', { type: 'codeBlock', content: [] }],
      [
        'nested list',
        {
          type: 'bulletList',
          content: [{ type: 'listItem', content: [{ type: 'bulletList', content: [] }] }],
        },
      ],
      ['unknown inline', { type: 'paragraph', content: [{ type: 'mention', attrs: {} }] }],
      ['date node', { type: 'paragraph', content: [{ type: 'date', attrs: { timestamp: '0' } }] }],
      ['emoji node', { type: 'paragraph', content: [{ type: 'emoji', attrs: {} }] }],
      ['layoutSection', { type: 'layoutSection', content: [] }],
      ['decisionList', { type: 'decisionList', content: [] }],
    ];

    it.each(UNSUPPORTED_ADF)('ADF %s keeps the whole document read-only', (_name, node) => {
      const adf = {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'supported part' }] }, node],
      };
      const result = adfToRichDocument(adf);
      expectReadonly(result);
      if (!result.supported) {
        expect(['unsupported_node', 'unsupported_mark', 'invalid_input']).toContain(result.reason);
      }
    });

    it.each([
      ['ordered list', '1. real\n2. list'],
      ['indented code', '    indented'],
      ['fenced code', '```\nfenced\n```'],
      ['nested bullet', '  - nested'],
      ['nested quote', '  > nested'],
    ])('Markdown %s stays read-only', (_name, markdown) => {
      expectReadonly(markdownToRichDocument(markdown));
    });

    it.each([
      ['tag op', [{ text: 'hi ' }, { type: 'tag', user: { id: 1 } }]],
      ['emoticon op', [{ text: 'U1F60A', type: 'emoticon', emoticon: { code: '1f60a' } }]],
      ['checklist attribute', [{ text: 'x', attributes: { list: { list: 'checked' } } }]],
      ['code-block attribute', [{ text: 'x', attributes: { 'code-block': {} } }]],
      ['unknown attribute', [{ text: 'x', attributes: { underline: true } }]],
    ])('ClickUp delta %s stays read-only', (_name, delta) => {
      expectReadonly(clickupCommentDeltaToRichDocument(delta));
    });
  });

  it('markdown-unrepresentable canonical documents fail on emit (fallback path)', () => {
    // hardBreak has no verified markdown representation.
    const withBreak: Fixture = {
      version: 1,
      blocks: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'a', marks: [] }, { type: 'hardBreak' }],
        },
      ],
    };
    expect(canonicalizeRichDocument(asDoc(withBreak))).not.toBeNull();
    expect(richDocumentToMarkdown(asDoc(withBreak)).ok).toBe(false);
  });
});
