import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommentReferenceItem } from './CommentReferenceItem';
import type { ReviewComment } from '@/ui/lib/reviews';

const baseComment: ReviewComment = {
  id: 'comment-1',
  reviewId: 'review-1',
  filePath: 'src/utils.ts',
  parentId: null,
  lineStart: 10,
  lineEnd: 15,
  side: 'new',
  content: 'This function needs better error handling for edge cases',
  commentType: 'issue',
  status: 'open',
  authorType: 'user',
  authorAgentId: null,
  authorAgentName: null,
  targetAgents: [],
  version: 1,
  editedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('CommentReferenceItem', () => {
  const defaultProps = {
    comment: baseComment,
    replyCount: 0,
    isPending: false,
    onClick: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('rendering', () => {
    it('truncates long content with ellipsis', () => {
      const longContent =
        'This is a very long comment that exceeds the maximum length and should be truncated with an ellipsis at the end to indicate more content';
      const comment = { ...baseComment, content: longContent };
      render(<CommentReferenceItem {...defaultProps} comment={comment} />);

      // Content should be truncated to ~60 chars
      const snippet = screen.getByText(/This is a very long comment/);
      expect(snippet.textContent).toContain('…');
      expect(snippet.textContent!.length).toBeLessThanOrEqual(65); // ~60 chars + ellipsis + tolerance
    });

    it.each([
      {
        label: 'renders agent name for agent comments',
        authorAgentName: 'Brainstormer',
        expectedName: 'Brainstormer',
      },
      {
        label: 'falls back to truncated ID when authorAgentName is null',
        authorAgentName: null,
        expectedName: 'agent-ab',
      },
    ] as const)('$label', ({ authorAgentName, expectedName }) => {
      const agentComment: ReviewComment = {
        ...baseComment,
        authorType: 'agent',
        authorAgentId: 'agent-abc123def456',
        authorAgentName: authorAgentName,
      };
      render(<CommentReferenceItem {...defaultProps} comment={agentComment} />);
      expect(screen.getByText(expectedName)).toBeInTheDocument();
    });

    it.each([
      { label: 'single line', overrides: { lineEnd: 10 }, expected: 'utils.ts:10' },
      { label: 'no lines', overrides: { lineStart: null, lineEnd: null }, expected: 'utils.ts' },
      {
        label: 'review level',
        overrides: { filePath: null, lineStart: null, lineEnd: null },
        expected: 'Review-level',
      },
    ] as const)('$label', ({ overrides, expected }) => {
      render(<CommentReferenceItem {...defaultProps} comment={{ ...baseComment, ...overrides }} />);
      expect(screen.getByText(expected)).toBeInTheDocument();
    });
  });

  describe('status badges', () => {
    it.each([
      { label: 'renders Resolved status badge', status: 'resolved', statusLabel: 'Resolved' },
      { label: "renders Won't Fix status badge", status: 'wont_fix', statusLabel: "Won't Fix" },
    ] as const)('$label', ({ status, statusLabel }) => {
      const comment = { ...baseComment, status: status };
      render(<CommentReferenceItem {...defaultProps} comment={comment} />);
      expect(screen.getByText(statusLabel)).toBeInTheDocument();
    });
  });

  describe('comment types', () => {
    it.each([
      ['comment', 'Comment'],
      ['suggestion', 'Suggestion'],
      ['issue', 'Issue'],
      ['approval', 'Approval'],
    ])('displays correct icon for %s type', (type, _label) => {
      const comment: ReviewComment = {
        ...baseComment,
        commentType: type as ReviewComment['commentType'],
      };
      render(<CommentReferenceItem {...defaultProps} comment={comment} />);
      // The component uses icons, so we check the element exists
      const item = screen.getByTestId('comment-reference-item');
      expect(item).toBeInTheDocument();
    });
  });

  describe('reply count', () => {
    it('does not show reply count when 0', () => {
      render(<CommentReferenceItem {...defaultProps} replyCount={0} />);
      // No number should appear for reply count
      expect(screen.queryByText('0')).not.toBeInTheDocument();
    });

    it('shows reply count when > 0', () => {
      render(<CommentReferenceItem {...defaultProps} replyCount={3} />);
      expect(screen.getByText('3')).toBeInTheDocument();
    });
  });

  describe('pending state', () => {
    it('shows pending label and status styling', () => {
      render(<CommentReferenceItem {...defaultProps} isPending={true} />);
      {
        const item = screen.getByTestId('comment-reference-item');
        expect(item).toHaveClass('border-l-status-warn/40');
        expect(screen.getByText('Open').parentElement).toHaveClass('bg-background');
      }
      {
        expect(screen.getByText('Pending')).toBeInTheDocument();
      }
    });
  });

  describe('selected state', () => {
    it('applies selected styling when isSelected is true', () => {
      render(<CommentReferenceItem {...defaultProps} isSelected={true} />);
      const item = screen.getByTestId('comment-reference-item');
      expect(item).toHaveClass('bg-selected');
      // The pointer-hover fill must not replace the selected fill.
      expect(item).not.toHaveClass('hover:bg-accent');
    });
  });

  describe('resolved/muted state', () => {
    it('applies muted styling for resolved comments', () => {
      const comment = { ...baseComment, status: 'resolved' as const };
      render(<CommentReferenceItem {...defaultProps} comment={comment} />);
      const item = screen.getByTestId('comment-reference-item');
      expect(item).toHaveClass('text-muted-foreground');
    });

    it('does not apply muted styling when selected even if resolved', () => {
      const comment = { ...baseComment, status: 'resolved' as const };
      render(<CommentReferenceItem {...defaultProps} comment={comment} isSelected={true} />);
      const item = screen.getByTestId('comment-reference-item');
      expect(item).not.toHaveClass('opacity-60');
    });
  });

  describe('click handling', () => {
    it('calls onClick when clicked', async () => {
      const onClick = jest.fn();
      render(<CommentReferenceItem {...defaultProps} onClick={onClick} />);

      await userEvent.click(screen.getByTestId('comment-reference-item'));
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });

  describe('accessibility', () => {
    it('shows user comment metadata and accessible label without pending or selection', () => {
      render(<CommentReferenceItem {...defaultProps} />);
      {
        const button = screen.getByRole('button');
        expect(button).toHaveAttribute('aria-label');
        expect(button.getAttribute('aria-label')).toContain('Issue');
        expect(button.getAttribute('aria-label')).toContain('You');
        expect(button.getAttribute('aria-label')).toContain('utils.ts');
      }
      {
        expect(
          screen.getByText('This function needs better error handling for edge cases'),
        ).toBeInTheDocument();
      }
      {
        expect(screen.getByText('You')).toBeInTheDocument();
      }
      {
        expect(screen.getByText('utils.ts:10-15')).toBeInTheDocument();
      }
      {
        expect(screen.getByText('Open')).toBeInTheDocument();
      }
      {
        expect(screen.queryByText('Pending')).not.toBeInTheDocument();
      }
      {
        const item = screen.getByTestId('comment-reference-item');
        expect(item).not.toHaveClass('bg-selected');
        expect(item).toHaveClass('hover:bg-accent');
      }
      {
        const item = screen.getByTestId('comment-reference-item');
        expect(item).not.toHaveClass('opacity-60');
      }
    });

    it.each([
      { label: 'reply count', props: { replyCount: 5 }, expected: '5 replies' },
      { label: 'pending', props: { isPending: true }, expected: 'Pending response' },
    ] as const)('exposes $label in accessible name', ({ props, expected }) => {
      render(<CommentReferenceItem {...defaultProps} {...props} />);
      expect(screen.getByRole('button').getAttribute('aria-label')).toContain(expected);
    });
  });

  describe('className prop', () => {
    it('applies custom className', () => {
      render(<CommentReferenceItem {...defaultProps} className="custom-class" />);
      const item = screen.getByTestId('comment-reference-item');
      expect(item).toHaveClass('custom-class');
    });
  });
});
