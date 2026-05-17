import {
  ListReviewsParamsSchema,
  GetReviewParamsSchema,
  GetReviewCommentsParamsSchema,
  ReplyCommentParamsSchema,
  ResolveCommentParamsSchema,
  ApplySuggestionParamsSchema,
} from '../dtos/mcp.dto';
import type { ToolMetadataEntry } from './types';

export const reviewMetadata: ToolMetadataEntry[] = [
  {
    name: 'devchain_list_reviews',
    description:
      'List code reviews for the project. Use this to find reviews to work on or check review status.',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        status: {
          type: 'string',
          enum: ['draft', 'pending', 'changes_requested', 'approved', 'closed'],
          description: 'Filter by review status',
        },
        epicId: { type: 'string', description: 'Filter by epic UUID' },
        limit: { type: 'number', description: 'Max results (default 100)' },
        offset: { type: 'number', description: 'Pagination offset (default 0)' },
      },
      additionalProperties: false,
    },
    paramsSchema: ListReviewsParamsSchema,
  },
  {
    name: 'devchain_get_review',
    description:
      'Get a code review by ID, including changed files and comments. Use this to understand the context of a review before replying to comments.',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'reviewId'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        reviewId: { type: 'string', description: 'Review UUID' },
      },
      additionalProperties: false,
    },
    paramsSchema: GetReviewParamsSchema,
  },
  {
    name: 'devchain_get_review_comments',
    description:
      'List comments for a code review with optional filters. Returns comments with author information and thread structure.',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'reviewId'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        reviewId: { type: 'string', description: 'Review UUID' },
        status: {
          type: 'string',
          enum: ['open', 'resolved', 'wont_fix'],
          description: 'Filter by comment status',
        },
        filePath: { type: 'string', description: 'Filter by file path' },
        limit: { type: 'number', description: 'Max results (default 100)' },
        offset: { type: 'number', description: 'Pagination offset (default 0)' },
      },
      additionalProperties: false,
    },
    paramsSchema: GetReviewCommentsParamsSchema,
  },
  {
    name: 'devchain_reply_comment',
    description:
      'Create a new comment or reply to an existing comment on a code review. Use parentCommentId to reply to a specific comment.',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'reviewId', 'content'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        reviewId: { type: 'string', description: 'Review UUID' },
        parentCommentId: {
          type: 'string',
          description: 'Parent comment UUID to reply to (optional for new top-level comments)',
        },
        content: { type: 'string', description: 'Comment content' },
        filePath: {
          type: 'string',
          description: 'File path for file-specific comments (optional for replies)',
        },
        lineStart: { type: 'number', description: 'Starting line number (optional)' },
        lineEnd: { type: 'number', description: 'Ending line number (optional)' },
        commentType: {
          type: 'string',
          enum: ['comment', 'suggestion', 'issue', 'approval'],
          description: 'Type of comment (default: comment)',
        },
        targetAgentIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Agent UUIDs to notify about this comment. Use this to @mention specific agents.',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: ReplyCommentParamsSchema,
  },
  {
    name: 'devchain_resolve_comment',
    description:
      'Resolve a code review comment. Mark as resolved when the issue is addressed, or wont_fix if it will not be addressed.',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'commentId', 'version'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        commentId: { type: 'string', description: 'Comment UUID to resolve' },
        resolution: {
          type: 'string',
          enum: ['resolved', 'wont_fix'],
          description: 'Resolution status (default: resolved)',
        },
        version: {
          type: 'number',
          description: 'Current comment version for optimistic locking',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: ResolveCommentParamsSchema,
  },
  {
    name: 'devchain_apply_suggestion',
    description:
      'Apply a code review suggestion. Writes the suggested change to the file on disk and marks the comment as applied.',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'commentId', 'version'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        commentId: { type: 'string', description: 'Comment UUID whose suggestion to apply' },
        version: {
          type: 'number',
          description: 'Current comment version for optimistic locking',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: ApplySuggestionParamsSchema,
  },
];
