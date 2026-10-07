import {
  ACTIONS_REGISTRY,
  getAction,
  getAllActions,
  getActionMetadata,
  hasAction,
} from './actions.registry';
import { sendMessageAction } from './send-message.action';
import { deleteAgentAction } from './delete-agent.action';
import { terminateSessionAction } from './terminate-session.action';

describe('ActionsRegistry', () => {
  describe('ACTIONS_REGISTRY', () => {
    it('should contain sendMessageAction', () => {
      expect(ACTIONS_REGISTRY).toContain(sendMessageAction);
    });

    it('should contain deleteAgentAction', () => {
      expect(ACTIONS_REGISTRY).toContain(deleteAgentAction);
    });

    it('should contain terminateSessionAction', () => {
      expect(ACTIONS_REGISTRY).toContain(terminateSessionAction);
    });
  });

  describe('getAction', () => {
    it('should return action by type', () => {
      const action = getAction('send_agent_message');

      expect(action).toBeDefined();
      expect(action?.type).toBe('send_agent_message');
      expect(action?.name).toBe('Send Message to Agent');
    });

    it('should return undefined for non-existent type', () => {
      const action = getAction('non_existent_action');

      expect(action).toBeUndefined();
    });
  });

  describe('getAllActions', () => {
    it('should strip execute function from actions', () => {
      const actions = getAllActions();

      for (const action of actions) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((action as any).execute).toBeUndefined();
      }
    });

    it('should preserve other action properties', () => {
      const actions = getAllActions();
      const sendMessage = actions.find((a) => a.type === 'send_agent_message');

      expect(sendMessage).toBeDefined();
      expect(sendMessage?.name).toBe('Send Message to Agent');
      expect(sendMessage?.description).toBeDefined();
      expect(sendMessage?.category).toBe('terminal');
      expect(sendMessage?.inputs).toBeDefined();
    });
  });

  describe('getActionMetadata', () => {
    it('should return action metadata by type', () => {
      const metadata = getActionMetadata('send_agent_message');

      expect(metadata).toBeDefined();
      expect(metadata?.type).toBe('send_agent_message');
      expect(metadata?.name).toBe('Send Message to Agent');
    });

    it('should return undefined for non-existent type', () => {
      const metadata = getActionMetadata('non_existent_action');

      expect(metadata).toBeUndefined();
    });

    it('should strip execute function', () => {
      const metadata = getActionMetadata('send_agent_message');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((metadata as any).execute).toBeUndefined();
    });
  });

  describe('hasAction', () => {
    it('should return true for existing action', () => {
      expect(hasAction('send_agent_message')).toBe(true);
    });

    it('should return false for non-existent action', () => {
      expect(hasAction('non_existent_action')).toBe(false);
    });
  });
});
