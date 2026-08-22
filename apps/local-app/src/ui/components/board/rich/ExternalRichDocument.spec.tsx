import { render, screen } from '@testing-library/react';
import { ExternalRichDocument } from './ExternalRichDocument';
import type { ExternalRichDocumentV1 } from '@/modules/external-integrations/models/external-rich-document';

// Pure component over a closed model — the cheapest reliable layer for the
// renderer contract, including the no-HTML guarantee.

function text(text: string, marks: Array<Record<string, unknown>> = []) {
  return { type: 'text', text, marks };
}

const FULL_DOCUMENT: ExternalRichDocumentV1 = {
  version: 1,
  blocks: [
    { type: 'heading', level: 2, content: [text('Section title')] },
    {
      type: 'paragraph',
      content: [
        text('plain '),
        text('bold', [{ type: 'bold' }]),
        text(' '),
        text('italic', [{ type: 'italic' }]),
        text(' '),
        text('code', [{ type: 'code' }]),
        { type: 'hardBreak' },
        text('after break'),
      ],
    },
    {
      type: 'bulletList',
      items: [[text('one')], [text('two ', []), text('strong', [{ type: 'bold' }])]],
    },
    {
      type: 'blockquote',
      paragraphs: [
        [text('quoted ', []), text('linked', [{ type: 'link', href: 'https://example.com/x' }])],
      ],
    },
  ],
};

describe('ExternalRichDocument read-only renderer', () => {
  it('renders every closed block and mark through explicit elements', () => {
    const { container } = render(<ExternalRichDocument document={FULL_DOCUMENT} />);

    expect(screen.getByText('Section title').tagName).toBe('H2');
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('italic').tagName).toBe('EM');
    expect(screen.getByText('code').tagName).toBe('CODE');
    expect(container.querySelectorAll('br')).toHaveLength(1);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    const quote = container.querySelector('blockquote');
    expect(quote).not.toBeNull();

    const link = screen.getByText('linked');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', 'https://example.com/x');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders heading levels one through six with the matching tags', () => {
    const document: ExternalRichDocumentV1 = {
      version: 1,
      blocks: [1, 2, 3, 4, 5, 6].map((level) => ({
        type: 'heading',
        level: level as 1 | 2 | 3 | 4 | 5 | 6,
        content: [text(`heading-${level}`)],
      })),
    };
    render(<ExternalRichDocument document={document} />);
    for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      expect(screen.getByText(`heading-${tag.slice(1)}`).tagName).toBe(tag.toUpperCase());
    }
  });

  it('uses no dangerouslySetInnerHTML and no raw HTML parsing', () => {
    const xss: ExternalRichDocumentV1 = {
      version: 1,
      blocks: [
        {
          type: 'paragraph',
          content: [text('<script>alert(1)</script> <img src=x onerror=alert(1)>')],
        },
      ],
    };
    const { container } = render(<ExternalRichDocument document={xss} />);
    // The payload is text content only; no script or img elements exist.
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).toContain('&lt;script&gt;');
  });

  it('renders nothing for unknown block shapes (closed switch)', () => {
    const document = {
      version: 1,
      blocks: [{ type: 'table', rows: [] }],
    } as unknown as ExternalRichDocumentV1;
    const { container } = render(<ExternalRichDocument document={document} />);
    expect(container.querySelector('div')?.childElementCount).toBe(0);
  });
});
