import { LegacyDeliveryFormatterAdapter } from './legacy-delivery-formatter.adapter';
import type { DeliveryMessage } from '../dtos/delivery.types';

/**
 * Unit tests for the delivery formatter — the single point that decides how a
 * `DeliveryMessage` is rendered into the agent's tmux. Layer: pure unit (the
 * adapter is a stateless function of its input, no DI), which is the cheapest
 * layer that proves every framing/kind branch. First-ever coverage: the AMD
 * service spec mocks the formatter, so these branches were previously untested.
 *
 * All assertions are EXACT observable-output (`toBe`), never loose `contains`,
 * because `deliverImmediate` pastes the output verbatim and then sends submit
 * keys — surrounding whitespace changes prompt/submission behavior.
 */
describe('LegacyDeliveryFormatterAdapter', () => {
  const formatter = new LegacyDeliveryFormatterAdapter();

  /** Minimal valid DeliveryMessage; tests override only what each case exercises. */
  function msg(over: Partial<DeliveryMessage>): DeliveryMessage {
    return {
      kind: 'mcp.direct',
      body: 'body',
      source: 'test',
      projectId: 'proj-1',
      senderName: 'Sender',
      ...over,
    };
  }

  describe('mcp.direct framing', () => {
    it("defaults to agent-banner for senderType 'agent' (existing behavior preserved)", () => {
      const out = formatter.format(
        msg({ kind: 'mcp.direct', senderName: 'Alpha', senderType: 'agent', body: 'do the thing' }),
      );
      expect(out).toBe(
        '\n[This message is sent from "Alpha" agent use devchain_send_message tool for communication]\ndo the thing\n',
      );
    });

    it("defaults to agent-banner for senderType 'guest' (existing behavior preserved)", () => {
      const out = formatter.format(
        msg({ kind: 'mcp.direct', senderName: 'Gamma', senderType: 'guest', body: 'hey' }),
      );
      expect(out).toBe(
        '\n[This message is sent from "Gamma" guest use devchain_send_message tool for communication]\nhey\n',
      );
    });

    it("defaults to agent-banner for senderType 'user' (default is agent-banner, NOT senderType-derived)", () => {
      // A human user with no explicit framing still gets the banner by default;
      // only an explicit framing:'plain' opts out. This guards the design
      // decision that the default does NOT key off senderType.
      const out = formatter.format(
        msg({
          kind: 'mcp.direct',
          senderName: 'Mobile User',
          senderType: 'user',
          body: 'hi there',
        }),
      );
      expect(out).toBe(
        '\n[This message is sent from "Mobile User" user use devchain_send_message tool for communication]\nhi there\n',
      );
    });

    it("returns EXACTLY the raw body for framing:'plain', regardless of senderType (no surrounding whitespace)", () => {
      const body = 'raw body text';
      for (const senderType of ['agent', 'guest', 'user'] as const) {
        const out = formatter.format(
          msg({ kind: 'mcp.direct', senderName: 'X', senderType, body, framing: 'plain' }),
        );
        expect(out).toBe(body);
        // no leading/trailing whitespace introduced by the formatter
        expect(out).not.toMatch(/^\s|\s$/);
      }
    });

    it("preserves internal whitespace verbatim under framing:'plain' (multi-line body, no wrapper added)", () => {
      const body = 'line one\n  indented line two\n\nline four';
      const out = formatter.format(
        msg({ kind: 'mcp.direct', senderName: 'X', senderType: 'user', body, framing: 'plain' }),
      );
      expect(out).toBe(body);
    });

    it("returns the agent-banner when framing:'agent-banner' is explicit", () => {
      const out = formatter.format(
        msg({
          kind: 'mcp.direct',
          senderName: 'Beta',
          senderType: 'agent',
          body: 'do it',
          framing: 'agent-banner',
        }),
      );
      expect(out).toBe(
        '\n[This message is sent from "Beta" agent use devchain_send_message tool for communication]\ndo it\n',
      );
    });

    it("falls back to 'agent' senderType in the banner when senderType is unset", () => {
      const out = formatter.format(
        msg({ kind: 'mcp.direct', senderName: 'Anon', senderType: undefined, body: 'ping' }),
      );
      expect(out).toBe(
        '\n[This message is sent from "Anon" agent use devchain_send_message tool for communication]\nping\n',
      );
    });
  });

  describe('mcp.project framing', () => {
    it('renders a sanitized, replyable source-project banner without path metadata', () => {
      const sourceProjectId = '11111111-2222-4333-8444-555555555555';
      const out = formatter.format(
        msg({
          kind: 'mcp.project',
          senderName: '  Alice\n\u0000 "Owner"  ',
          senderType: 'agent',
          sourceProjectId,
          sourceProjectName: '  Source\t Project\u007f "One"  ',
          body: 'Cross-project body',
          sourceProjectRootPath: '/private/source/project',
        } as Partial<DeliveryMessage> & { sourceProjectRootPath: string }),
      );

      expect(out).toBe(
        '\n[This project message is sent from Project Owner "Alice \\"Owner\\"" in project "Source Project \\"One\\"". To reply, use devchain_send_message with recipientProjectId: "11111111-2222-4333-8444-555555555555".]\nCross-project body\n',
      );
      expect(out).not.toContain('\u0000');
      expect(out).not.toContain('\u007f');
      expect(out).not.toContain('\t');
      expect(out).not.toContain('/private/source/project');
    });
  });

  describe('other kinds ignore framing', () => {
    it("formats 'mcp.thread' as the thread turn with the [ACK] tool call (framing ignored)", () => {
      const out = formatter.format(
        msg({
          kind: 'mcp.thread',
          senderName: 'Carol',
          body: 'threaded hello',
          threadId: 'thr-9',
          messageId: 'msg-1',
          framing: 'plain', // must be ignored outside mcp.direct
        }),
      );
      expect(out).toBe(
        '\n[CHAT] From: Carol • Thread: thr-9\nthreaded hello\n[ACK] tools/call { name: "devchain_chat_ack", arguments: { thread_id: "thr-9", message_id: "msg-1" } }\n',
      );
    });

    it("formats 'chat.user' as the thread turn with the [ACK] tool call (framing ignored)", () => {
      const out = formatter.format(
        msg({
          kind: 'chat.user',
          senderName: 'Dan',
          body: 'chat hello',
          threadId: 'thr-1',
          messageId: 'msg-2',
          framing: 'plain', // must be ignored outside mcp.direct
        }),
      );
      expect(out).toBe(
        '\n[CHAT] From: Dan • Thread: thr-1\nchat hello\n[ACK] tools/call { name: "devchain_chat_ack", arguments: { thread_id: "thr-1", message_id: "msg-2" } }\n',
      );
    });

    it("passes 'pooled' body through raw (framing ignored)", () => {
      const out = formatter.format(
        msg({ kind: 'pooled', senderName: 'Pool', body: 'pooled body', framing: 'plain' }),
      );
      expect(out).toBe('pooled body');
    });
  });
});
