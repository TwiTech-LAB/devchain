import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import DOMPurify from 'dompurify';
import { MarkdownRenderer, renderMarkdown } from './MarkdownRenderer';

jest.mock('dompurify', () => ({
  __esModule: true,
  default: {
    sanitize: jest.fn((html: string) => html),
  },
}));

describe('MarkdownRenderer memoization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not recompute markdown html when only className changes', () => {
    const sanitizeMock = DOMPurify.sanitize as jest.Mock;

    const { rerender } = render(<MarkdownRenderer content="**hello**" className="foo" />);

    expect(sanitizeMock).toHaveBeenCalledTimes(1);

    rerender(<MarkdownRenderer content="**hello**" className="bar" />);

    expect(sanitizeMock).toHaveBeenCalledTimes(1);
  });

  it('recomputes markdown html when content changes', () => {
    const sanitizeMock = DOMPurify.sanitize as jest.Mock;

    const { rerender } = render(<MarkdownRenderer content="**hello**" />);

    expect(sanitizeMock).toHaveBeenCalledTimes(1);

    rerender(<MarkdownRenderer content="**goodbye**" />);

    expect(sanitizeMock).toHaveBeenCalledTimes(2);
  });
});

describe('MarkdownRenderer — contrast contract (T1)', () => {
  it('wrapper class includes dark:prose-invert', () => {
    const { container } = render(<MarkdownRenderer content="hello" />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain('dark:prose-invert');
    expect(wrapper.className).toContain('prose');
    expect(wrapper.className).toContain('prose-sm');
  });

  it('dark:prose-invert is not overridden by custom className', () => {
    const { container } = render(<MarkdownRenderer content="hello" className="custom-class" />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain('dark:prose-invert');
    expect(wrapper.className).toContain('custom-class');
  });

  it('renders rich markdown without muted color on any prose element', () => {
    const html = renderMarkdown(
      '# Heading\n\nParagraph **bold** with `code` and a [link](https://example.com)\n\n- item\n\n1. a\n2. b\n\n> quote',
    );
    expect(html).not.toMatch(/<(?:p|ul|ol|blockquote)[^>]*text-muted-foreground/);
  });
});

describe('MarkdownRenderer — copyable code blocks', () => {
  const script = [
    '#!/usr/bin/env bash',
    'if [ "$a" -lt 3 ] && echo "<ok>"; then',
    '    printf \'%s\\n\' "indented & long line that a terminal would wrap"',
    '',
    'fi',
  ].join('\n');
  const content = ['Run this:', '', '```bash', script, '```'].join('\n');

  beforeEach(() => {
    // The real sanitizer must keep the Copy button.
    const actual = jest.requireActual('dompurify');
    const purify = actual.default ?? actual;
    (DOMPurify.sanitize as jest.Mock).mockImplementation((html: string, config: object) =>
      purify.sanitize(html, config),
    );
  });

  it('copies the exact code text, and shows no button unless asked', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const { container, rerender } = render(<MarkdownRenderer content={content} copyableCode />);
    const button = screen.getByRole('button', { name: 'Copy code' });
    fireEvent.click(button);

    await waitFor(() => expect(button).toHaveTextContent('Copied'));
    expect(writeText).toHaveBeenCalledWith(script);

    rerender(<MarkdownRenderer content={content} />);
    expect(screen.queryByRole('button', { name: 'Copy code' })).not.toBeInTheDocument();
    expect(container.querySelector('code')?.textContent).toBe(script);
  });
});
