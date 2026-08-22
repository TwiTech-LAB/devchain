import {
  markdownToRichDocument,
  parseMarkdownInline,
  richDocumentToMarkdown,
} from './clickup-markdown-converter';
import {
  richDocumentFingerprint,
  type ExternalRichDocumentV1,
} from '../../models/external-rich-document';

// Pure converter contract — the cheapest reliable layer for pure functions.
// Fixtures mirror the provider markdown shapes the live probe observed,
// including ClickUp's `*` bullet re-emission and `_italic_` normalization.

function text(text: string, marks: Array<Record<string, unknown>> = []) {
  return { type: 'text', text, marks };
}

function roundTripFingerprint(markdown: string): {
  parsed: string | null;
  restabilized: string | null;
} {
  const first = markdownToRichDocument(markdown);
  if (!first.supported) {
    return { parsed: null, restabilized: null };
  }
  const fingerprint = richDocumentFingerprint(first.document);
  const emitted = richDocumentToMarkdown(first.document);
  if (!emitted.ok) {
    return { parsed: fingerprint, restabilized: null };
  }
  const second = markdownToRichDocument(emitted.markdown);
  return {
    parsed: fingerprint,
    restabilized: second.supported ? richDocumentFingerprint(second.document) : null,
  };
}

describe('ClickUp markdown converter', () => {
  it('round-trips the exact provider output the live probe recorded', () => {
    // ClickUp re-emits bullets as `*   item` and italic as `_em_`.
    const providerOutput = [
      '# DevChain probe heading',
      '',
      'Paragraph with **bold text**, _italic text_, and `inline code`.',
      '',
      '*   bullet alpha',
      '*   bullet beta',
      '',
      '[probe link](https://example.com/devchain-probe)',
      '',
      '> quoted probe line',
    ].join('\n');
    const { parsed, restabilized } = roundTripFingerprint(providerOutput);
    expect(parsed).not.toBeNull();
    expect(restabilized).toBe(parsed);
  });

  it('preserves semantics through both directions for supported documents', () => {
    const cases = [
      '# Top\n\nSimple paragraph.\n\n- one\n- two',
      '## Heading two with `code` and **bold**',
      '> quoted with [link](https://example.com/x)',
      'Text before\ncontinued on the next line',
    ];
    for (const markdown of cases) {
      const { parsed, restabilized } = roundTripFingerprint(markdown);
      expect(parsed).not.toBeNull();
      expect(restabilized).toBe(parsed);
    }
  });

  describe('escaping', () => {
    it('keeps literal markdown characters as text, not structure', () => {
      const literal = 'Not \\*emphasis\\*, not \\_italic\\_, not \\`code\\*, not \\[link\\]';
      const result = markdownToRichDocument(literal);
      expect(result.supported).toBe(true);
      if (!result.supported) {
        return;
      }
      expect(result.document.blocks[0]).toEqual({
        type: 'paragraph',
        content: [text('Not *emphasis*, not _italic_, not `code*, not [link]')],
      });
    });

    it('round-trips text that looks like structure: bullets, headings, quotes', () => {
      const tricky = ['\\- not a bullet', '', '\\# not a heading', '', '\\> not a quote'].join(
        '\n',
      );
      const { parsed, restabilized } = roundTripFingerprint(tricky);
      expect(parsed).not.toBeNull();
      expect(restabilized).toBe(parsed);
    });

    it('round-trips list-like ordered text via digit-dot escaping', () => {
      const { parsed, restabilized } = roundTripFingerprint('1\\. not an ordered list');
      expect(parsed).not.toBeNull();
      expect(restabilized).toBe(parsed);
      const parsedDoc = markdownToRichDocument('1\\. not an ordered list');
      expect(parsedDoc.supported).toBe(true);
      if (parsedDoc.supported) {
        expect(parsedDoc.document.blocks[0]).toEqual({
          type: 'paragraph',
          content: [text('1. not an ordered list')],
        });
      }
    });

    it('round-trips backticks, angle brackets, and asterisks inside code spans', () => {
      const { parsed, restabilized } = roundTripFingerprint(
        'Use \\<tags\\> and \\`escaped\\` and a \\*star\\*',
      );
      expect(parsed).not.toBeNull();
      expect(restabilized).toBe(parsed);
    });

    it('keeps intra-word underscores as plain text', () => {
      const parsed = parseMarkdownInline('snake_case_name stays plain');
      expect(parsed.inline).toEqual([text('snake_case_name stays plain')]);
    });
  });

  describe('URLs', () => {
    it('accepts safe http(s) links', () => {
      const result = markdownToRichDocument('[docs](https://example.com/docs?a=1#frag)');
      expect(result.supported).toBe(true);
      if (result.supported) {
        expect(result.document.blocks[0]!.content).toEqual([
          text('docs', [{ type: 'link', href: 'https://example.com/docs?a=1#frag' }]),
        ]);
      }
    });

    it('fails unsafe hrefs closed as unsupported_mark', () => {
      for (const href of ['javascript:alert(1)', 'data:text/html,Hi', 'ftp://example.com/f']) {
        expect(markdownToRichDocument(`[x](${href})`)).toEqual({
          supported: false,
          reason: 'unsupported_mark',
        });
      }
    });
  });

  describe('unsupported structure fails the whole document closed', () => {
    it('rejects provider ordered lists', () => {
      expect(markdownToRichDocument('1. real item\n2. second')).toEqual({
        supported: false,
        reason: 'unsupported_node',
      });
    });

    it('rejects indented (code-block-like) and nested-list lines', () => {
      expect(markdownToRichDocument('    indented code')).toEqual({
        supported: false,
        reason: 'unsupported_node',
      });
      expect(markdownToRichDocument('\ttabbed')).toEqual({
        supported: false,
        reason: 'unsupported_node',
      });
      expect(markdownToRichDocument('  - nested bullet')).toEqual({
        supported: false,
        reason: 'unsupported_node',
      });
    });

    it('rejects fenced code blocks', () => {
      expect(markdownToRichDocument('```\nfenced\n```')).toEqual({
        supported: false,
        reason: 'unsupported_node',
      });
    });

    it('rejects non-string input and empty documents', () => {
      expect(markdownToRichDocument(42)).toEqual({ supported: false, reason: 'invalid_input' });
      expect(markdownToRichDocument('   \n  ')).toEqual({
        supported: false,
        reason: 'invalid_input',
      });
    });
  });

  describe('emit fails closed for markdown-unrepresentable content', () => {
    it('rejects hard breaks', () => {
      const document = {
        version: 1,
        blocks: [
          {
            type: 'paragraph',
            content: [text('a'), { type: 'hardBreak' }, text('b')],
          },
        ],
      } as unknown as ExternalRichDocumentV1;
      expect(richDocumentToMarkdown(document)).toEqual({
        ok: false,
        reason: 'unsupported_mark',
      });
    });

    it('rejects stacked marks on code or link runs', () => {
      const codePlusBold = {
        version: 1,
        blocks: [{ type: 'paragraph', content: [text('x', [{ type: 'code' }, { type: 'bold' }])] }],
      } as unknown as ExternalRichDocumentV1;
      expect(richDocumentToMarkdown(codePlusBold)).toEqual({
        ok: false,
        reason: 'unsupported_mark',
      });

      const linkPlusItalic = {
        version: 1,
        blocks: [
          {
            type: 'paragraph',
            content: [
              text('x', [{ type: 'link', href: 'https://example.com' }, { type: 'italic' }]),
            ],
          },
        ],
      } as unknown as ExternalRichDocumentV1;
      expect(richDocumentToMarkdown(linkPlusItalic)).toEqual({
        ok: false,
        reason: 'unsupported_mark',
      });
    });

    it('rejects code runs containing a literal backtick', () => {
      // ClickUp re-emits backticks inside code spans as escaped plain text,
      // so such runs cannot round-trip at the provider.
      const document = {
        version: 1,
        blocks: [{ type: 'paragraph', content: [text('inline `tick` code', [{ type: 'code' }])] }],
      } as unknown as ExternalRichDocumentV1;
      expect(richDocumentToMarkdown(document)).toEqual({
        ok: false,
        reason: 'unsupported_mark',
      });
    });

    it('rejects multi-paragraph blockquotes', () => {
      const document = {
        version: 1,
        blocks: [{ type: 'blockquote', paragraphs: [[text('a')], [text('b')]] }],
      } as unknown as ExternalRichDocumentV1;
      expect(richDocumentToMarkdown(document)).toEqual({ ok: false, reason: 'unsupported_node' });
    });
  });

  it('emits block-separated markdown that re-parses identically', () => {
    const document = {
      version: 1,
      blocks: [
        { type: 'heading', level: 1, content: [text('Title')] },
        { type: 'paragraph', content: [text('a '), text('b', [{ type: 'bold' }])] },
        { type: 'bulletList', items: [[text('x')], [text('y', [{ type: 'code' }])]] },
        { type: 'blockquote', paragraphs: [[text('quote')]] },
      ],
    } as unknown as ExternalRichDocumentV1;
    const emitted = richDocumentToMarkdown(document);
    expect(emitted.ok).toBe(true);
    if (!emitted.ok) {
      return;
    }
    expect(emitted.markdown.split('\n\n')).toEqual(['# Title', 'a **b**', '- x\n- `y`', '> quote']);
    const reparsed = markdownToRichDocument(emitted.markdown);
    expect(reparsed.supported).toBe(true);
    if (reparsed.supported) {
      expect(richDocumentFingerprint(reparsed.document)).toBe(richDocumentFingerprint(document));
    }
  });
});
