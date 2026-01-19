import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SuggestionBlock, parseSuggestionBlocks, hasSuggestionBlocks } from './SuggestionBlock';

// Mock clipboard API
const mockWriteText = jest.fn();
Object.assign(navigator, {
  clipboard: {
    writeText: mockWriteText,
  },
});

describe('parseSuggestionBlocks', () => {
  it('parses single suggestion block', () => {
    const content = '```suggestion\nconst x = 1;\n```';
    const blocks = parseSuggestionBlocks(content);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: 'suggestion', content: 'const x = 1;' });
  });

  it('parses suggestion block with surrounding text', () => {
    const content =
      'This is a suggestion:\n```suggestion\nconst x = 1;\n```\nPlease consider this.';
    const blocks = parseSuggestionBlocks(content);

    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ type: 'text', content: 'This is a suggestion:' });
    expect(blocks[1]).toEqual({ type: 'suggestion', content: 'const x = 1;' });
    expect(blocks[2]).toEqual({ type: 'text', content: 'Please consider this.' });
  });

  it('parses multiple suggestion blocks', () => {
    const content = '```suggestion\ncode1\n```\nand\n```suggestion\ncode2\n```';
    const blocks = parseSuggestionBlocks(content);

    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ type: 'suggestion', content: 'code1' });
    expect(blocks[1]).toEqual({ type: 'text', content: 'and' });
    expect(blocks[2]).toEqual({ type: 'suggestion', content: 'code2' });
  });

  it('handles multi-line suggestion', () => {
    const content = '```suggestion\nline1\nline2\nline3\n```';
    const blocks = parseSuggestionBlocks(content);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: 'suggestion', content: 'line1\nline2\nline3' });
  });

  it('returns text block if no suggestion', () => {
    const content = 'Just a regular comment with no suggestions.';
    const blocks = parseSuggestionBlocks(content);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: 'text',
      content: 'Just a regular comment with no suggestions.',
    });
  });

  it('handles empty content', () => {
    const blocks = parseSuggestionBlocks('');
    expect(blocks).toHaveLength(0);
  });
});

describe('hasSuggestionBlocks', () => {
  it('returns true when content has suggestion block', () => {
    expect(hasSuggestionBlocks('```suggestion\ncode\n```')).toBe(true);
  });

  it('returns false when content has no suggestion block', () => {
    expect(hasSuggestionBlocks('Regular comment')).toBe(false);
  });

  it('returns false for regular code blocks', () => {
    expect(hasSuggestionBlocks('```javascript\nconst x = 1;\n```')).toBe(false);
  });
});

describe('SuggestionBlock', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders suggested code', () => {
    render(<SuggestionBlock suggestedCode="const x = 1;" />);

    expect(screen.getByText('const x = 1;')).toBeInTheDocument();
  });

  it('renders suggestion badge', () => {
    render(<SuggestionBlock suggestedCode="code" />);

    expect(screen.getByText('Suggestion')).toBeInTheDocument();
  });

  it('renders file path and line info', () => {
    render(
      <SuggestionBlock suggestedCode="code" filePath="src/test.ts" lineStart={10} lineEnd={15} />,
    );

    expect(screen.getByText('src/test.ts:L10-15')).toBeInTheDocument();
  });

  it('renders single line info when lineStart equals lineEnd', () => {
    render(
      <SuggestionBlock suggestedCode="code" filePath="src/test.ts" lineStart={10} lineEnd={10} />,
    );

    expect(screen.getByText('src/test.ts:L10')).toBeInTheDocument();
  });

  it('renders apply button when onApply is provided', () => {
    const mockOnApply = jest.fn();
    render(<SuggestionBlock suggestedCode="code" onApply={mockOnApply} />);

    expect(screen.getByText('Apply Suggestion')).toBeInTheDocument();
  });

  it('does not render apply button when showApplyButton is false', () => {
    const mockOnApply = jest.fn();
    render(<SuggestionBlock suggestedCode="code" onApply={mockOnApply} showApplyButton={false} />);

    expect(screen.queryByText('Apply Suggestion')).not.toBeInTheDocument();
  });

  it('calls onApply when apply button is clicked', async () => {
    const mockOnApply = jest.fn().mockResolvedValue(undefined);
    render(<SuggestionBlock suggestedCode="code" onApply={mockOnApply} />);

    await userEvent.click(screen.getByText('Apply Suggestion'));

    expect(mockOnApply).toHaveBeenCalledTimes(1);
  });

  it('shows loading state when isApplying is true', () => {
    render(<SuggestionBlock suggestedCode="code" onApply={jest.fn()} isApplying={true} />);

    expect(screen.getByText('Applying...')).toBeInTheDocument();
  });

  it('shows applied indicator when isApplied is true', () => {
    render(<SuggestionBlock suggestedCode="code" isApplied={true} />);

    expect(screen.getByText('Suggestion applied')).toBeInTheDocument();
  });

  it('does not show apply button when isApplied is true', () => {
    render(<SuggestionBlock suggestedCode="code" onApply={jest.fn()} isApplied={true} />);

    expect(screen.queryByText('Apply Suggestion')).not.toBeInTheDocument();
  });

  it('renders original code when provided', () => {
    render(<SuggestionBlock suggestedCode="const y = 2;" originalCode="const x = 1;" />);

    expect(screen.getByText('const x = 1;')).toBeInTheDocument();
    expect(screen.getByText('const y = 2;')).toBeInTheDocument();
  });

  it('copies suggestion to clipboard when copy button is clicked', async () => {
    mockWriteText.mockResolvedValue(undefined);
    render(<SuggestionBlock suggestedCode="const x = 1;" />);

    const copyButton = screen.getByTitle('Copy suggestion');
    await userEvent.click(copyButton);

    expect(mockWriteText).toHaveBeenCalledWith('const x = 1;');
  });

  it('renders multi-line suggestion with diff markers', () => {
    const { container } = render(<SuggestionBlock suggestedCode="line1\nline2" />);

    // Check that the suggested code lines exist in the green section
    const greenSection = container.querySelector('.bg-green-50');
    expect(greenSection).toBeInTheDocument();
    expect(greenSection?.textContent).toContain('line1');
    expect(greenSection?.textContent).toContain('line2');
    // Check for + markers in the green section
    expect(greenSection?.textContent).toContain('+');
  });

  it('renders multi-line original code with diff markers', () => {
    const { container } = render(
      <SuggestionBlock suggestedCode="newcode" originalCode="old1\nold2" />,
    );

    // Check that the original code lines exist in the red section
    const redSection = container.querySelector('.bg-red-50');
    expect(redSection).toBeInTheDocument();
    expect(redSection?.textContent).toContain('old1');
    expect(redSection?.textContent).toContain('old2');
    // Check for - markers in the red section
    expect(redSection?.textContent).toContain('-');

    // Check suggested code in green section
    const greenSection = container.querySelector('.bg-green-50');
    expect(greenSection).toBeInTheDocument();
    expect(greenSection?.textContent).toContain('newcode');
  });
});
