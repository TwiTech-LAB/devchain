import {
  clickupCommentDeltaToRichDocument,
  richDocumentToClickUpCommentDelta,
} from './clickup-comment-converter';
import {
  richDocumentFingerprint,
  type ExternalRichDocumentV1,
} from '../../models/external-rich-document';

// Pure converter contract against the verified ClickUp rich-comment shapes
// the live probe recorded (including the provider's op-boundary whitespace
// trimming and op splitting).

function doc(runs: unknown[]): ExternalRichDocumentV1 {
  return {
    version: 1,
    blocks: [{ type: 'paragraph', content: runs }],
  } as unknown as ExternalRichDocumentV1;
}

describe('ClickUp comment converter', () => {
  it('round-trips the exact delta the live probe recorded', () => {
    // Provider returned op-boundary-trimmed segments after create.
    const providerDelta = [
      { text: 'probe rich ' },
      { text: 'bold text', attributes: { bold: true } },
      { text: ' plus' },
      { text: 'inline code', attributes: { code: true } },
    ];
    const parsed = clickupCommentDeltaToRichDocument(providerDelta);
    expect(parsed.supported).toBe(true);
    if (!parsed.supported) {
      return;
    }
    const emitted = richDocumentToClickUpCommentDelta(parsed.document);
    expect(emitted.ok).toBe(true);
    if (!emitted.ok) {
      return;
    }
    const reparsed = clickupCommentDeltaToRichDocument(emitted.delta);
    expect(reparsed.supported).toBe(true);
    expect(reparsed.supported ? richDocumentFingerprint(reparsed.document) : null).toBe(
      richDocumentFingerprint(parsed.document),
    );
  });

  it('normalizes provider op splitting and padding to one fingerprint', () => {
    const split = [
      { text: 'a' },
      { text: 'b', attributes: { bold: true } },
      { text: 'c', attributes: { bold: true } },
    ];
    const merged = [{ text: 'a' }, { text: 'bc', attributes: { bold: true } }];
    const splitParsed = clickupCommentDeltaToRichDocument(split);
    const mergedParsed = clickupCommentDeltaToRichDocument(merged);
    expect(splitParsed.supported).toBe(true);
    expect(mergedParsed.supported).toBe(true);
    if (splitParsed.supported && mergedParsed.supported) {
      expect(richDocumentFingerprint(splitParsed.document)).toBe(
        richDocumentFingerprint(mergedParsed.document),
      );
    }
  });

  it('carries the verified attribute set', () => {
    const delta = [
      { text: 'i', attributes: { italic: true } },
      { text: 'l', attributes: { link: 'https://example.com/x' } },
    ];
    const parsed = clickupCommentDeltaToRichDocument(delta);
    expect(parsed.supported).toBe(true);
    if (!parsed.supported) {
      return;
    }
    expect(parsed.document.blocks[0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'i', marks: [{ type: 'italic' }] },
        { type: 'text', text: 'l', marks: [{ type: 'link', href: 'https://example.com/x' }] },
      ],
    });
    const emitted = richDocumentToClickUpCommentDelta(parsed.document);
    expect(emitted).toEqual({
      ok: true,
      delta: [
        { text: 'i', attributes: { italic: true } },
        { text: 'l', attributes: { link: 'https://example.com/x' } },
      ],
    });
  });

  describe('unsupported content fails the whole comment closed', () => {
    it('rejects structural op types (tags, emoticons)', () => {
      const tagged = [{ text: 'ping ' }, { type: 'tag', user: { id: 123 } }];
      expect(clickupCommentDeltaToRichDocument(tagged)).toEqual({
        supported: false,
        reason: 'unsupported_node',
      });
      const emoticon = [{ text: 'U0001F60A', type: 'emoticon', emoticon: { code: '1f60a' } }];
      expect(clickupCommentDeltaToRichDocument(emoticon)).toEqual({
        supported: false,
        reason: 'unsupported_node',
      });
    });

    it('rejects unverified attributes and unsafe links', () => {
      expect(
        clickupCommentDeltaToRichDocument([
          { text: 'x', attributes: { 'code-block': { 'code-block': 'plain' } } },
        ]),
      ).toEqual({ supported: false, reason: 'unsupported_mark' });
      expect(
        clickupCommentDeltaToRichDocument([
          { text: 'x', attributes: { list: { list: 'bullet' } } },
        ]),
      ).toEqual({ supported: false, reason: 'unsupported_mark' });
      expect(
        clickupCommentDeltaToRichDocument([
          { text: 'x', attributes: { link: 'javascript:alert(1)' } },
        ]),
      ).toEqual({ supported: false, reason: 'unsupported_mark' });
    });

    it('rejects non-array input, empty deltas, and segment overflow', () => {
      expect(clickupCommentDeltaToRichDocument('text')).toEqual({
        supported: false,
        reason: 'invalid_input',
      });
      expect(clickupCommentDeltaToRichDocument([])).toEqual({
        supported: false,
        reason: 'invalid_input',
      });
      const overflow = Array.from({ length: 1_001 }, () => ({ text: 'x' }));
      expect(clickupCommentDeltaToRichDocument(overflow)).toEqual({
        supported: false,
        reason: 'limit_exceeded',
      });
    });
  });

  describe('emit fails closed outside the flat single-paragraph contract', () => {
    it('rejects multi-paragraph documents and hard breaks', () => {
      const multiParagraph = {
        version: 1,
        blocks: [
          { type: 'paragraph', content: [{ type: 'text', text: 'a', marks: [] }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'b', marks: [] }] },
        ],
      } as unknown as ExternalRichDocumentV1;
      expect(richDocumentToClickUpCommentDelta(multiParagraph)).toEqual({
        ok: false,
        reason: 'unsupported_node',
      });

      const withBreak = doc([{ type: 'text', text: 'a', marks: [] }, { type: 'hardBreak' }]);
      expect(richDocumentToClickUpCommentDelta(withBreak)).toEqual({
        ok: false,
        reason: 'unsupported_node',
      });
    });

    it('rejects non-paragraph blocks', () => {
      const heading = {
        version: 1,
        blocks: [{ type: 'heading', level: 1, content: [{ type: 'text', text: 'h', marks: [] }] }],
      } as unknown as ExternalRichDocumentV1;
      expect(richDocumentToClickUpCommentDelta(heading)).toEqual({
        ok: false,
        reason: 'unsupported_node',
      });
    });

    it('rejects whitespace-only documents', () => {
      // Canonicalization drops them entirely; emission cannot distinguish
      // that from over-limit input, so it fails closed either way.
      const result = richDocumentToClickUpCommentDelta(
        doc([{ type: 'text', text: '  ', marks: [] }]),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('limit_exceeded');
      }
    });
  });
});
