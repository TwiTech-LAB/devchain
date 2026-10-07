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
    it.each([
      {
        senderName: 'Alpha',
        senderType: 'agent' as const,
        body: 'do the thing',
        framing: undefined,
        expected:
          '\n[This message is sent from "Alpha" agent use devchain_send_message tool for communication]\ndo the thing\n',
      },
      {
        senderName: 'Mobile User',
        senderType: 'user' as const,
        body: 'hi there',
        framing: undefined,
        expected:
          '\n[This message is sent from "Mobile User" user use devchain_send_message tool for communication]\nhi there\n',
      },
      {
        senderName: 'Beta',
        senderType: 'agent' as const,
        body: 'do it',
        framing: 'agent-banner' as const,
        expected:
          '\n[This message is sent from "Beta" agent use devchain_send_message tool for communication]\ndo it\n',
      },
      {
        senderName: 'Anon',
        senderType: undefined,
        body: 'ping',
        framing: undefined,
        expected:
          '\n[This message is sent from "Anon" agent use devchain_send_message tool for communication]\nping\n',
      },
    ])('formats the banner for $senderName with framing $framing', ({ expected, ...input }) => {
      expect(formatter.format(msg({ kind: 'mcp.direct', ...input }))).toBe(expected);
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

    describe("framing:'sender-footer'", () => {
      it('appends a JSON-quoted sanitized sender on one line with no trailing newline', () => {
        const out = formatter.format(
          msg({
            kind: 'mcp.direct',
            senderName: '  Desk\n\u0000 "Phone"  ',
            senderType: 'user',
            body: 'line one\nline two',
            framing: 'sender-footer',
          }),
        );

        expect(out).toBe('line one\nline two\n[SentBy:"Desk \\"Phone\\""]');
        expect(out).not.toMatch(/\n$/u);
        expect(out).not.toContain('\u0000');
      });

      it('returns the raw body when the sender name is empty after one-line sanitization', () => {
        const body = 'unchanged body';
        const out = formatter.format(
          msg({ senderName: '\n\t\u0000', body, framing: 'sender-footer' }),
        );

        expect(out).toBe(body);
      });
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

  describe('pooled framing', () => {
    it("passes 'pooled' body through raw (framing ignored)", () => {
      const out = formatter.format(
        msg({ kind: 'pooled', senderName: 'Pool', body: 'pooled body', framing: 'plain' }),
      );
      expect(out).toBe('pooled body');
    });
  });
});
