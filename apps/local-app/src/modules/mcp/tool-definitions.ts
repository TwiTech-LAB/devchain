/**
 * Canonical MCP tool definitions.
 * Single source of truth for both McpHttpController and McpSdkController.
 *
 * These definitions are used by the MCP servers to advertise available tools
 * to AI agents. Each tool has a name, description, and JSON Schema for its input.
 */
export function getToolDefinitions() {
  return [
    {
      name: 'devchain_list_sessions',
      description:
        'List active sessions for discovery. This is the bootstrap tool that requires no sessionId - use it to discover valid session IDs for other MCP calls.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_register_guest',
      description:
        'Register as a guest agent to join the DevChain system. Use this when you are an external AI agent running in a tmux session and want to appear in the Chat page alongside other agents. Returns a guestId that must be used as sessionId for all subsequent MCP tool calls. Your project is auto-detected from your tmux working directory.',
      inputSchema: {
        type: 'object',
        required: ['name', 'tmuxSessionId'],
        properties: {
          name: {
            type: 'string',
            description: 'Display name for the guest agent (must be unique within the project)',
          },
          tmuxSessionId: {
            type: 'string',
            description: 'The tmux session ID where the guest is running',
          },
          description: {
            type: 'string',
            description: 'Optional description of the guest agent',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_list_documents',
      description: 'List all documents for the project resolved from the session.',
      inputSchema: {
        type: 'object',
        required: ['sessionId'],
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID (full UUID or 8+ char prefix)',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Filter by tags (all must match)',
          },
          q: { type: 'string', description: 'Search query for title/content' },
          limit: { type: 'number', description: 'Max results (default: 100)' },
          offset: { type: 'number', description: 'Pagination offset (default: 0)' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_get_document',
      description: 'Get a single document by ID or slug, with optional link resolution',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Document UUID' },
          slug: { type: 'string', description: 'Document slug (requires projectId)' },
          projectId: { type: 'string', description: 'Project ID when using slug' },
          includeLinks: {
            type: 'string',
            enum: ['none', 'meta', 'inline'],
            description:
              'Link resolution: none (no links), meta (link metadata), inline (full content)',
          },
          maxDepth: {
            type: 'number',
            description: 'Max depth for inline resolution (default: 1)',
          },
          maxBytes: {
            type: 'number',
            description: 'Max bytes for inline content (default: 64KB)',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_create_document',
      description: 'Create a new markdown document in the project resolved from the session',
      inputSchema: {
        type: 'object',
        required: ['sessionId', 'title', 'contentMd'],
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID (full UUID or 8+ char prefix)',
          },
          title: { type: 'string', description: 'Document title' },
          contentMd: { type: 'string', description: 'Markdown content' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Document tags' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_update_document',
      description: 'Update an existing document',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Document UUID' },
          title: { type: 'string', description: 'New title' },
          slug: { type: 'string', description: 'New slug' },
          contentMd: { type: 'string', description: 'New markdown content' },
          tags: { type: 'array', items: { type: 'string' }, description: 'New tags' },
          archived: { type: 'boolean', description: 'Archive status' },
          version: { type: 'number', description: 'Version for optimistic locking' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_list_prompts',
      description: 'List prompts for the project resolved from the session',
      inputSchema: {
        type: 'object',
        required: ['sessionId'],
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID (full UUID or 8+ char prefix)',
          },
          tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' },
          q: { type: 'string', description: 'Search query' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_get_prompt',
      description: 'Get a specific prompt by ID or by (name + sessionId)',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Prompt UUID' },
          name: { type: 'string', description: 'Prompt name/title' },
          version: { type: 'number', description: 'Specific version number' },
          sessionId: {
            type: 'string',
            description: 'Session ID (full UUID or 8+ char prefix) required when querying by name',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_list_agents',
      description: 'List agents for the project resolved from the session',
      inputSchema: {
        type: 'object',
        required: ['sessionId'],
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID (full UUID or 8+ char prefix)',
          },
          limit: { type: 'number', description: 'Max results (default: 100)' },
          offset: { type: 'number', description: 'Pagination offset (default: 0)' },
          q: {
            type: 'string',
            description: 'Optional case-insensitive substring filter on agent name',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_get_agent_by_name',
      description: 'Fetch a single agent by name for the project resolved from the session',
      inputSchema: {
        type: 'object',
        required: ['sessionId', 'name'],
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID (full UUID or 8+ char prefix)',
          },
          name: {
            type: 'string',
            description: 'Agent name to look up (case-insensitive match)',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_list_statuses',
      description: 'List project statuses resolved from the session',
      inputSchema: {
        type: 'object',
        required: ['sessionId'],
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID (full UUID or 8+ char prefix)',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_list_epics',
      description: 'List epics for the project resolved from the session with optional filters',
      inputSchema: {
        type: 'object',
        required: ['sessionId'],
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID (full UUID or 8+ char prefix)',
          },
          statusName: {
            type: 'string',
            description: 'Optional status name filter (case-insensitive)',
          },
          limit: { type: 'number', description: 'Max results (default: 100)' },
          offset: { type: 'number', description: 'Pagination offset (default: 0)' },
          q: {
            type: 'string',
            description: 'Optional search query applied to epic titles and descriptions',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_list_assigned_epics_tasks',
      description:
        'List epics assigned to the specified agent within the project resolved from the session',
      inputSchema: {
        type: 'object',
        required: ['sessionId', 'agentName'],
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID (full UUID or 8+ char prefix)',
          },
          agentName: { type: 'string', description: 'Agent name to match (case-insensitive)' },
          limit: { type: 'number', description: 'Max results (default: 100)' },
          offset: { type: 'number', description: 'Pagination offset (default: 0)' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_create_epic',
      description: 'Create a new epic within the project resolved from the session',
      inputSchema: {
        type: 'object',
        required: ['sessionId', 'title'],
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID (full UUID or 8+ char prefix)',
          },
          title: { type: 'string', description: 'Epic title' },
          description: { type: 'string', description: 'Optional epic description' },
          statusName: {
            type: 'string',
            description: 'Optional status name (case-insensitive)',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of tags to assign to the epic',
          },
          agentName: {
            type: 'string',
            description: 'Optional agent name to assign (case-insensitive)',
          },
          parentId: {
            type: 'string',
            description: 'Optional parent epic UUID to nest this epic under',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_get_epic_by_id',
      description: 'Fetch a single epic, including comments and related hierarchy details',
      inputSchema: {
        type: 'object',
        required: ['sessionId', 'id'],
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID (full UUID or 8+ char prefix)',
          },
          id: { type: 'string', description: 'Epic UUID' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_add_epic_comment',
      description:
        'Add a comment to the specified epic within the project resolved from the session. Author is derived from session agent.',
      inputSchema: {
        type: 'object',
        required: ['sessionId', 'epicId', 'content'],
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID (full UUID or 8+ char prefix)',
          },
          epicId: { type: 'string', description: 'Epic UUID' },
          content: { type: 'string', description: 'Comment body content' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_update_epic',
      description:
        'Update an epic with flexible field updates including status (by name), assignment (by agent name or clear), parent hierarchy, and tags. Uses optimistic locking via version.',
      inputSchema: {
        type: 'object',
        required: ['sessionId', 'id', 'version'],
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID (full UUID or 8+ char prefix)',
          },
          id: { type: 'string', description: 'Epic UUID' },
          version: { type: 'number', description: 'Current version for optimistic locking' },
          title: { type: 'string', description: 'New epic title' },
          description: { type: 'string', description: 'New epic description' },
          statusName: {
            type: 'string',
            description: 'Status name (case-insensitive exact match)',
          },
          assignment: {
            type: 'object',
            description:
              'Assignment update: either { agentName: string } to assign or { clear: true } to unassign',
            oneOf: [
              {
                type: 'object',
                required: ['agentName'],
                properties: {
                  agentName: {
                    type: 'string',
                    description: 'Agent name (case-insensitive exact match)',
                  },
                },
                additionalProperties: false,
              },
              {
                type: 'object',
                required: ['clear'],
                properties: {
                  clear: {
                    type: 'boolean',
                    const: true,
                    description: 'Set to true to clear assignment',
                  },
                },
                additionalProperties: false,
              },
            ],
          },
          parentId: {
            type: 'string',
            description: 'Parent epic UUID (mutually exclusive with clearParent)',
          },
          clearParent: {
            type: 'boolean',
            description: 'Set to true to remove parent (mutually exclusive with parentId)',
          },
          setTags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Replace all tags with this array',
          },
          addTags: { type: 'array', items: { type: 'string' }, description: 'Tags to add' },
          removeTags: { type: 'array', items: { type: 'string' }, description: 'Tags to remove' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_create_record',
      description: 'Create a new record (generic data storage for epics)',
      inputSchema: {
        type: 'object',
        required: ['epicId', 'type', 'data'],
        properties: {
          epicId: { type: 'string', description: 'Epic UUID this record belongs to' },
          type: { type: 'string', description: 'Record type identifier' },
          data: { type: 'object', description: 'Arbitrary JSON data' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Record tags' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_update_record',
      description: 'Update an existing record',
      inputSchema: {
        type: 'object',
        required: ['id', 'version'],
        properties: {
          id: { type: 'string', description: 'Record UUID' },
          data: { type: 'object', description: 'New data (merged)' },
          type: { type: 'string', description: 'New type' },
          tags: { type: 'array', items: { type: 'string' }, description: 'New tags' },
          version: { type: 'number', description: 'Current version for optimistic locking' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_get_record',
      description: 'Get a record by ID',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', description: 'Record UUID' } },
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_list_records',
      description: 'List records for an epic with optional filtering',
      inputSchema: {
        type: 'object',
        required: ['epicId'],
        properties: {
          epicId: { type: 'string', description: 'Epic UUID' },
          type: { type: 'string', description: 'Filter by record type' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' },
          limit: { type: 'number', description: 'Max results' },
          offset: { type: 'number', description: 'Pagination offset' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_add_tags',
      description: 'Add tags to a record',
      inputSchema: {
        type: 'object',
        required: ['id', 'tags'],
        properties: {
          id: { type: 'string', description: 'Record UUID' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: 'Tags to add',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_remove_tags',
      description: 'Remove tags from a record',
      inputSchema: {
        type: 'object',
        required: ['id', 'tags'],
        properties: {
          id: { type: 'string', description: 'Record UUID' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: 'Tags to remove',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_send_message',
      description:
        'Send a chat message. Sender is derived from session agent. Provide threadId to reply in a thread, or recipientAgentNames to create a new agent-initiated group.',
      inputSchema: {
        type: 'object',
        required: ['sessionId', 'message'],
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID (full UUID or 8+ char prefix)',
          },
          threadId: {
            type: 'string',
            description:
              'Existing thread UUID. When provided, recipients may be omitted to fan-out to thread members.',
          },
          recipientAgentNames: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Agent names (case-insensitive) to receive the message. Required only when creating a new thread (no threadId).',
          },
          recipient: {
            type: 'string',
            enum: ['user', 'agents'],
            description: 'Set to "user" to DM the user without a threadId.',
          },
          message: { type: 'string', description: 'Message content to deliver.' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_chat_ack',
      description: 'Mark a chat message as read for an agent and emit a message.read event.',
      inputSchema: {
        type: 'object',
        required: ['sessionId', 'thread_id', 'message_id'],
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID (full UUID or 8+ char prefix)',
          },
          thread_id: { type: 'string', description: 'Chat thread UUID.' },
          message_id: { type: 'string', description: 'Chat message UUID to acknowledge.' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_chat_read_history',
      description:
        'Fetch recent messages for a chat thread so agents can catch up after an invite.',
      inputSchema: {
        type: 'object',
        required: ['thread_id'],
        properties: {
          thread_id: { type: 'string', description: 'Chat thread UUID.' },
          limit: { type: 'number', description: 'Max messages to return (default 50, max 200).' },
          since: {
            type: 'string',
            description: 'ISO timestamp; only messages after this time are returned.',
          },
          exclude_system: {
            type: 'boolean',
            description:
              'Exclude system messages. Defaults to true when omitted to show only user/agent authored messages.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_chat_list_members',
      description: 'List members of a chat thread along with their online status.',
      inputSchema: {
        type: 'object',
        required: ['thread_id'],
        properties: { thread_id: { type: 'string', description: 'Chat thread UUID.' } },
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_activity_start',
      description:
        'Start an activity for an agent; posts a system start message and begins a running timer (DM by default).',
      inputSchema: {
        type: 'object',
        required: ['sessionId', 'title'],
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID (full UUID or 8+ char prefix)',
          },
          title: { type: 'string', description: 'Activity title (<=256 chars)' },
          threadId: { type: 'string', description: 'Target thread UUID (optional)' },
          announce: { type: 'boolean', description: 'Whether to post the start system message' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'devchain_activity_finish',
      description:
        'Finish the latest running activity for an agent; optionally posts a finish system message.',
      inputSchema: {
        type: 'object',
        required: ['sessionId'],
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID (full UUID or 8+ char prefix)',
          },
          threadId: { type: 'string', description: 'Target thread UUID (optional)' },
          message: { type: 'string', description: 'Optional finish message (<=1000 chars)' },
          status: {
            type: 'string',
            enum: ['success', 'failed', 'canceled'],
            description: 'Final status (default success)',
          },
        },
        additionalProperties: false,
      },
    },
    // Code Review tools
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
    },
  ];
}
