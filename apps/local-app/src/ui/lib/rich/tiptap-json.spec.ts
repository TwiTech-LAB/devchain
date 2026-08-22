import { canonicalToTipTapJson, tipTapJsonToCanonical } from '@/ui/lib/rich/tiptap-json';
import {
  canonicalizeRichDocument,
  richDocumentFingerprint,
  type ExternalRichDocumentV1,
} from '@/modules/external-integrations/models/external-rich-document';

// Pure conversion contract — the cheapest reliable layer.

function text(value: string, marks: Array<Record<string, unknown>> = []) {
  return { type: 'text', text: value, marks };
}

const DOCUMENT: ExternalRichDocumentV1 = {
  version: 1,
  blocks: [
    { type: 'heading', level: 3, content: [text('Head')] },
    {
      type: 'paragraph',
      content: [
        text('a '),
        text('b', [{ type: 'bold' }]),
        { type: 'hardBreak' },
        text('c', [{ type: 'code' }]),
        text('d', [{ type: 'link', href: 'https://example.com/d' }]),
        text('e', [{ type: 'italic' }]),
      ],
    },
    { type: 'bulletList', items: [[text('one')], [text('two')]] },
    { type: 'blockquote', paragraphs: [[text('q1')], [text('q2')]] },
  ],
};

describe('tiptap-json conversion', () => {
  it('round-trips every closed construct losslessly', () => {
    const json = canonicalToTipTapJson(DOCUMENT);
    const back = tipTapJsonToCanonical(json);
    expect(back).not.toBeNull();
    expect(richDocumentFingerprint(back!)).toBe(richDocumentFingerprint(DOCUMENT));
  });

  it('produces editor nodes the configured schema understands', () => {
    const json = canonicalToTipTapJson(DOCUMENT);
    const types = new Set<string>();
    const visit = (node: Record<string, unknown>): void => {
      types.add(String(node.type));
      if (Array.isArray(node.content)) {
        (node.content as Array<Record<string, unknown>>).forEach(visit);
      }
    };
    visit(json as Record<string, unknown>);
    expect([...types].sort()).toEqual([
      'blockquote',
      'bulletList',
      'doc',
      'hardBreak',
      'heading',
      'listItem',
      'paragraph',
      'text',
    ]);
  });

  it('maps marks both ways', () => {
    const json = canonicalToTipTapJson(DOCUMENT);
    const serialized = JSON.stringify(json);
    expect(serialized).toContain('"type":"bold"');
    expect(serialized).toContain('"type":"italic"');
    expect(serialized).toContain('"type":"code"');
    expect(serialized).toContain('"type":"link"');
    expect(serialized).toContain('"href":"https://example.com/d"');
  });

  it('returns null for non-doc editor JSON and empty documents', () => {
    expect(tipTapJsonToCanonical({ type: 'paragraph' })).toBeNull();
    expect(tipTapJsonToCanonical({ type: 'doc', content: [] })).toBeNull();
    expect(tipTapJsonToCanonical('text')).toBeNull();
    expect(
      tipTapJsonToCanonical({ type: 'doc', content: [{ type: 'paragraph', content: [] }] }),
    ).toBeNull();
  });

  it('drops editor nodes outside the closed set without guessing', () => {
    const json = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [text('kept')] },
        {
          type: 'orderedList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [text('dropped')] }] },
          ],
        },
        { type: 'codeBlock', content: [text('also dropped')] },
      ],
    };
    const back = tipTapJsonToCanonical(json);
    expect(back?.blocks).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'kept', marks: [] }] },
    ]);
  });

  it('clamps invalid heading levels out of the result', () => {
    const json = {
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 9 }, content: [text('x')] }],
    };
    expect(tipTapJsonToCanonical(json)).toBeNull();
  });

  it('output stays inside the canonical closed set after normalization', () => {
    const back = tipTapJsonToCanonical(canonicalToTipTapJson(DOCUMENT))!;
    expect(canonicalizeRichDocument(back)).not.toBeNull();
  });
});
