import React from 'react';
import { render } from '@testing-library/react';
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

  it('renders <p> without text-muted-foreground class', () => {
    const html = renderMarkdown('hello world');
    expect(html).toContain('<p class="my-3 leading-relaxed">');
    expect(html).not.toMatch(/<p[^>]*text-muted-foreground/);
  });

  it('renders <ul> without text-muted-foreground class', () => {
    const html = renderMarkdown('- a\n- b');
    expect(html).not.toMatch(/<ul[^>]*text-muted-foreground/);
  });

  it('renders <ol> without text-muted-foreground class', () => {
    const html = renderMarkdown('1. a\n2. b');
    expect(html).not.toMatch(/<ol[^>]*text-muted-foreground/);
  });

  it('renders <blockquote> without text-muted-foreground class', () => {
    const html = renderMarkdown('> quoted text');
    expect(html).not.toMatch(/<blockquote[^>]*text-muted-foreground/);
  });

  it('renders rich markdown without muted color on any prose element', () => {
    const html = renderMarkdown(
      '# Heading\n\nParagraph **bold** with `code` and a [link](https://example.com)\n\n- item\n\n> quote',
    );
    expect(html).not.toMatch(/<(?:p|ul|ol|blockquote)[^>]*text-muted-foreground/);
  });
});
