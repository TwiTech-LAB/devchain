import React from 'react';
import { render } from '@testing-library/react';
import DOMPurify from 'dompurify';
import { MarkdownRenderer } from './MarkdownRenderer';

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
