import { ZodError } from 'zod';
import { ChatAckParamsSchema, ChatListMembersParamsSchema } from './mcp.dto';

describe('MCP chat DTO schemas', () => {
  it('requires thread_id for list members tool', () => {
    expect(() => ChatListMembersParamsSchema.parse({})).toThrow(ZodError);
    expect(() =>
      ChatListMembersParamsSchema.parse({ thread_id: '00000000-0000-0000-0000-000000000000' }),
    ).not.toThrow();
  });

  it('validates devchain_chat_ack parameters', () => {
    expect(() =>
      ChatAckParamsSchema.parse({
        sessionId: '00000000-0000-0000-0000-000000000003',
        thread_id: '00000000-0000-0000-0000-000000000000',
        message_id: '00000000-0000-0000-0000-000000000001',
        agent_id: '00000000-0000-0000-0000-000000000002',
        agent_name: 'Agent Example',
      }),
    ).not.toThrow();

    expect(() => ChatAckParamsSchema.parse({ thread_id: 'missing' })).toThrow(ZodError);
  });
});
