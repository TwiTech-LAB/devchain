import { HookEventSchema } from './hook-event.dto';

const PROJECT_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';
const SESSION_ID = '33333333-3333-3333-3333-333333333333';

const sessionStart = {
  hookEventName: 'SessionStart',
  claudeSessionId: 'claude-session-1',
  source: 'startup',
  tmuxSessionName: 'devchain-test',
  projectId: PROJECT_ID,
  agentId: AGENT_ID,
  sessionId: SESSION_ID,
};

const preToolUse = {
  hookEventName: 'PreToolUse',
  claudeSessionId: 'claude-session-1',
  toolName: 'AskUserQuestion',
  toolUseId: 'toolu_abc',
  toolInput: {
    questions: [
      {
        question: 'Which color?',
        header: 'Color',
        multiSelect: false,
        options: [{ label: 'Red', description: 'r' }],
      },
    ],
  },
  tmuxSessionName: 'devchain-test',
  projectId: PROJECT_ID,
  agentId: AGENT_ID,
  sessionId: SESSION_ID,
};

const postToolUse = {
  hookEventName: 'PostToolUse',
  claudeSessionId: 'claude-session-1',
  toolName: 'AskUserQuestion',
  toolUseId: 'toolu_abc',
  toolInput: { questions: [] },
  toolResponse: 'Color → Red',
  tmuxSessionName: 'devchain-test',
  projectId: PROJECT_ID,
  agentId: AGENT_ID,
  sessionId: SESSION_ID,
};

describe('HookEventSchema (discriminated union)', () => {
  describe('SessionStart (backward compatible)', () => {
    it('accepts a minimal SessionStart payload', () => {
      expect(HookEventSchema.safeParse(sessionStart).success).toBe(true);
    });

    it('accepts SessionStart with optional fields and null agent/session', () => {
      const result = HookEventSchema.safeParse({
        ...sessionStart,
        agentId: null,
        sessionId: null,
        model: 'claude-opus-4-8',
        permissionMode: 'default',
        transcriptPath: '/tmp/t.jsonl',
      });
      expect(result.success).toBe(true);
    });

    it('rejects SessionStart missing the required source', () => {
      const { source, ...withoutSource } = sessionStart;
      void source;
      expect(HookEventSchema.safeParse(withoutSource).success).toBe(false);
    });
  });

  describe('PreToolUse', () => {
    it('accepts a PreToolUse payload and preserves the questions object', () => {
      const result = HookEventSchema.safeParse(preToolUse);
      expect(result.success).toBe(true);
      if (result.success && result.data.hookEventName === 'PreToolUse') {
        expect(result.data.toolInput).toEqual(preToolUse.toolInput);
        expect(result.data.toolUseId).toBe('toolu_abc');
      }
    });

    it('does NOT require source for PreToolUse', () => {
      expect('source' in preToolUse).toBe(false);
      expect(HookEventSchema.safeParse(preToolUse).success).toBe(true);
    });

    it('rejects PreToolUse missing toolUseId', () => {
      const { toolUseId, ...incomplete } = preToolUse;
      void toolUseId;
      expect(HookEventSchema.safeParse(incomplete).success).toBe(false);
    });

    it('rejects PreToolUse with a non-object toolInput', () => {
      expect(HookEventSchema.safeParse({ ...preToolUse, toolInput: 'not-an-object' }).success).toBe(
        false,
      );
    });
  });

  describe('PostToolUse', () => {
    it('accepts a PostToolUse payload with a string toolResponse', () => {
      expect(HookEventSchema.safeParse(postToolUse).success).toBe(true);
    });

    it('accepts a PostToolUse payload with an object toolResponse', () => {
      const result = HookEventSchema.safeParse({
        ...postToolUse,
        toolResponse: { truncated: true, length: 50000 },
      });
      expect(result.success).toBe(true);
    });

    it('accepts a PostToolUse payload omitting toolResponse', () => {
      const { toolResponse, ...withoutResponse } = postToolUse;
      void toolResponse;
      expect(HookEventSchema.safeParse(withoutResponse).success).toBe(true);
    });
  });

  describe('Stop (agentStop) variant', () => {
    const stop = {
      hookEventName: 'Stop',
      stopReason: 'end_turn',
      transcriptPath: '/home/u/.copilot/session-state/abc/events.jsonl',
      providerName: 'copilot',
      providerSessionId: 'copilot-session-1',
      tmuxSessionName: 'devchain-test',
      projectId: PROJECT_ID,
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
    };

    it('accepts a Copilot Stop payload (providerSessionId, no claudeSessionId)', () => {
      const result = HookEventSchema.safeParse(stop);
      expect(result.success).toBe(true);
      if (result.success && result.data.hookEventName === 'Stop') {
        expect(result.data.stopReason).toBe('end_turn');
        expect(result.data.transcriptPath).toBe(stop.transcriptPath);
        expect(result.data.providerSessionId).toBe('copilot-session-1');
      }
    });

    it('accepts a Stop payload omitting the optional stopReason', () => {
      const { stopReason, ...withoutReason } = stop;
      void stopReason;
      expect(HookEventSchema.safeParse(withoutReason).success).toBe(true);
    });

    it('accepts a Stop payload carrying a legacy claudeSessionId', () => {
      expect(
        HookEventSchema.safeParse({ ...stop, claudeSessionId: 'claude-session-1' }).success,
      ).toBe(true);
    });

    it('rejects unknown keys on Stop (strict mode)', () => {
      expect(HookEventSchema.safeParse({ ...stop, rogueKey: 'x' }).success).toBe(false);
    });
  });

  describe('provider-aware SessionStart (Copilot)', () => {
    it('accepts a Copilot SessionStart with providerName/providerSessionId and no claudeSessionId', () => {
      const copilotSessionStart = {
        hookEventName: 'SessionStart',
        source: 'new',
        providerName: 'copilot',
        providerSessionId: 'copilot-session-1',
        tmuxSessionName: 'devchain-test',
        projectId: PROJECT_ID,
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
      };
      const result = HookEventSchema.safeParse(copilotSessionStart);
      expect(result.success).toBe(true);
      if (result.success && result.data.hookEventName === 'SessionStart') {
        expect(result.data.providerName).toBe('copilot');
        expect(result.data.claudeSessionId).toBeUndefined();
      }
    });

    it('keeps claudeSessionId required on the Claude-only tool variants', () => {
      // SessionStart no longer requires it (cross-provider), but PreToolUse/PostToolUse do.
      const { claudeSessionId: _pre, ...preWithout } = preToolUse;
      void _pre;
      const { claudeSessionId: _post, ...postWithout } = postToolUse;
      void _post;
      expect(HookEventSchema.safeParse(preWithout).success).toBe(false);
      expect(HookEventSchema.safeParse(postWithout).success).toBe(false);
    });
  });

  describe('rejection (malformed / strict)', () => {
    it('rejects an unknown hookEventName (no matching variant)', () => {
      expect(
        HookEventSchema.safeParse({ ...sessionStart, hookEventName: 'UnknownEvent' }).success,
      ).toBe(false);
    });

    it('rejects unknown keys (strict mode) on any variant', () => {
      expect(HookEventSchema.safeParse({ ...sessionStart, rogueKey: 'x' }).success).toBe(false);
      expect(HookEventSchema.safeParse({ ...preToolUse, rogueKey: 'x' }).success).toBe(false);
    });

    it('rejects a non-UUID projectId', () => {
      expect(HookEventSchema.safeParse({ ...sessionStart, projectId: 'not-a-uuid' }).success).toBe(
        false,
      );
    });
  });
});
