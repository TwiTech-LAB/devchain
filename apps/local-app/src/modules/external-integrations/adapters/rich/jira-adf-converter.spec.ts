import { adfToRichDocument, richDocumentToAdf } from './jira-adf-converter';
import {
  canonicalizeRichDocument,
  richDocumentFingerprint,
  type ExternalRichDocumentV1,
} from '../../models/external-rich-document';

// Pure converter contract against recorded probe-verified ADF shapes — the
// cheapest reliable layer because conversion is pure with no I/O or DI.

function adfText(text: string, marks?: Array<Record<string, unknown>>) {
  return marks ? { type: 'text', text, marks } : { type: 'text', text };
}

const strong = (text: string) => adfText(text, [{ type: 'strong' }]);
const em = (text: string) => adfText(text, [{ type: 'em' }]);
const code = (text: string) => adfText(text, [{ type: 'code' }]);
const link = (text: string, href: string) => adfText(text, [{ type: 'link', attrs: { href } }]);

function paragraph(...content: unknown[]) {
  return { type: 'paragraph', content };
}

// The exact description ADF the live probe verified with Jira.
const PROBE_VERIFIED_ADF = {
  type: 'doc',
  version: 1,
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [adfText('DevChain probe heading')] },
    paragraph(
      adfText('Paragraph with '),
      strong('bold text'),
      adfText(', '),
      em('italic text'),
      adfText(', and '),
      code('inline code'),
    ),
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [paragraph(adfText('bullet alpha'))] },
        { type: 'listItem', content: [paragraph(adfText('bullet beta'))] },
      ],
    },
    paragraph(link('probe link', 'https://example.com/devchain-probe')),
    { type: 'blockquote', content: [paragraph(adfText('quoted probe line'))] },
  ],
};

function roundTrip(adf: unknown): string | null {
  const parsed = adfToRichDocument(adf);
  if (!parsed.supported) {
    throw new Error(`parse failed: ${parsed.reason}`);
  }
  const emitted = richDocumentToAdf(parsed.document);
  const reparsed = adfToRichDocument(emitted);
  if (!reparsed.supported) {
    throw new Error(`reparse failed: ${reparsed.reason}`);
  }
  return richDocumentFingerprint(reparsed.document);
}

describe('Jira ADF converter', () => {
  it('preserves canonical semantics of the probe-verified ADF in both directions', () => {
    const first = adfToRichDocument(PROBE_VERIFIED_ADF);
    expect(first.supported).toBe(true);
    if (!first.supported) {
      return;
    }
    const fingerprint = richDocumentFingerprint(first.document);
    expect(fingerprint).toBe(roundTrip(PROBE_VERIFIED_ADF));

    // Provider-side normalization (split runs, reordered marks, extra
    // whitespace) must not change the fingerprint.
    const reordered = structuredClone(PROBE_VERIFIED_ADF);
    (reordered.content[1] as { content: Array<Record<string, unknown>> }).content.splice(
      1,
      0,
      adfText(''),
    );
    const normalized = adfToRichDocument(reordered);
    expect(normalized.supported).toBe(true);
    expect(normalized.supported ? richDocumentFingerprint(normalized.document) : null).toBe(
      fingerprint,
    );
  });

  it('carries hardBreak and stacked marks through the canonical model', () => {
    const adf = {
      type: 'doc',
      version: 1,
      content: [
        paragraph(adfText('line one'), { type: 'hardBreak' }, adfText('line two')),
        paragraph(adfText('both', [{ type: 'strong' }, { type: 'em' }])),
      ],
    };
    const parsed = adfToRichDocument(adf);
    expect(parsed.supported).toBe(true);
    const emitted = parsed.supported ? richDocumentToAdf(parsed.document) : null;
    const reparsed = emitted ? adfToRichDocument(emitted) : null;
    expect(reparsed?.supported).toBe(true);
    if (parsed.supported && reparsed?.supported) {
      expect(richDocumentFingerprint(reparsed.document)).toBe(
        richDocumentFingerprint(parsed.document),
      );
    }
  });

  it('emits canonical ADF that re-parses to the same document', () => {
    const document = {
      version: 1,
      blocks: [
        { type: 'heading', level: 2, content: [{ type: 'text', text: 'h2', marks: [] }] },
        {
          type: 'blockquote',
          paragraphs: [
            [{ type: 'text', text: 'q1', marks: [] }],
            [{ type: 'text', text: 'q2', marks: [] }],
          ],
        },
      ],
    } as unknown as ExternalRichDocumentV1;
    expect(canonicalizeRichDocument(document)).not.toBeNull();
    const emitted = richDocumentToAdf(document);
    expect(emitted).toEqual({
      type: 'doc',
      version: 1,
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'h2' }] },
        {
          type: 'blockquote',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'q1' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'q2' }] },
          ],
        },
      ],
    });
    const reparsed = adfToRichDocument(emitted);
    expect(reparsed.supported).toBe(true);
  });

  describe('unsupported content fails the whole document closed', () => {
    it.each([
      ['table', { type: 'table', content: [] }],
      ['media', paragraph({ type: 'media', attrs: {} })],
      ['panel', { type: 'panel', attrs: { panelType: 'info' }, content: [] }],
      ['extension', { type: 'extension', attrs: { extensionKey: 'x' }, content: [] }],
      [
        'orderedList',
        {
          type: 'orderedList',
          content: [{ type: 'listItem', content: [paragraph(adfText('x'))] }],
        },
      ],
      [
        'nested list',
        {
          type: 'bulletList',
          content: [{ type: 'listItem', content: [{ type: 'bulletList', content: [] }] }],
        },
      ],
      ['unknown block', { type: 'decisionList', content: [] }],
      ['unknown inline', paragraph({ type: 'mention', attrs: {} })],
      [
        'multi-block list item',
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [paragraph(adfText('a')), paragraph(adfText('b'))] },
          ],
        },
      ],
    ])('rejects %s', (_name, node) => {
      const adf = { type: 'doc', version: 1, content: [node] };
      const result = adfToRichDocument(adf);
      expect(result.supported).toBe(false);
      if (!result.supported) {
        expect(['unsupported_node', 'invalid_input']).toContain(result.reason);
      }
    });

    it('rejects unsupported marks and unsafe link hrefs as unsupported_mark', () => {
      const underline = adfToRichDocument({
        type: 'doc',
        version: 1,
        content: [paragraph(adfText('x', [{ type: 'underline' }]))],
      });
      expect(underline).toEqual({ supported: false, reason: 'unsupported_mark' });

      const unsafeLink = adfToRichDocument({
        type: 'doc',
        version: 1,
        content: [paragraph(link('x', 'javascript:alert(1)'))],
      });
      expect(unsafeLink).toEqual({ supported: false, reason: 'unsupported_mark' });
    });

    it('rejects invalid wrappers as invalid_input', () => {
      expect(adfToRichDocument(null)).toEqual({ supported: false, reason: 'invalid_input' });
      expect(adfToRichDocument({ type: 'doc', version: 2, content: [] })).toEqual({
        supported: false,
        reason: 'invalid_input',
      });
    });
  });

  it('reports limit_exceeded for node-count overflow', () => {
    const content = Array.from({ length: 10_001 }, () => adfText('x'));
    const result = adfToRichDocument({ type: 'doc', version: 1, content: [paragraph(...content)] });
    expect(result).toEqual({ supported: false, reason: 'limit_exceeded' });
  });
});
