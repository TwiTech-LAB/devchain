import {
  ACTIONS_REGISTRY,
  getAction,
  getAllActions,
  getActionMetadata,
  hasAction,
  getActionTypes,
} from './actions.registry';
import { sendMessageAction } from './send-message.action';

describe('ActionsRegistry', () => {
  describe('ACTIONS_REGISTRY', () => {
    it('should be an array', () => {
      expect(Array.isArray(ACTIONS_REGISTRY)).toBe(true);
    });

    it('should contain sendMessageAction', () => {
      expect(ACTIONS_REGISTRY).toContain(sendMessageAction);
    });

    it('should have at least one action', () => {
      expect(ACTIONS_REGISTRY.length).toBeGreaterThanOrEqual(1);
    });

    it('should have actions with required properties', () => {
      for (const action of ACTIONS_REGISTRY) {
        expect(action.type).toBeDefined();
        expect(typeof action.type).toBe('string');
        expect(action.name).toBeDefined();
        expect(typeof action.name).toBe('string');
        expect(action.description).toBeDefined();
        expect(action.category).toBeDefined();
        expect(['terminal', 'session', 'notification', 'external']).toContain(action.category);
        expect(action.inputs).toBeDefined();
        expect(Array.isArray(action.inputs)).toBe(true);
        expect(action.execute).toBeDefined();
        expect(typeof action.execute).toBe('function');
      }
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

    it('should return action with execute function', () => {
      const action = getAction('send_agent_message');

      expect(action?.execute).toBeDefined();
      expect(typeof action?.execute).toBe('function');
    });
  });

  describe('getAllActions', () => {
    it('should return array of actions', () => {
      const actions = getAllActions();

      expect(Array.isArray(actions)).toBe(true);
      expect(actions.length).toBe(ACTIONS_REGISTRY.length);
    });

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

    it('should include allowedSources in input metadata', () => {
      const actions = getAllActions();
      const sendMessage = actions.find((a) => a.type === 'send_agent_message');

      expect(sendMessage).toBeDefined();
      const submitKeyInput = sendMessage?.inputs.find((i) => i.name === 'submitKey');
      expect(submitKeyInput).toBeDefined();
      expect(submitKeyInput?.allowedSources).toEqual(['custom']);
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

  describe('getActionTypes', () => {
    it('should return array of action types', () => {
      const types = getActionTypes();

      expect(Array.isArray(types)).toBe(true);
      expect(types.length).toBe(ACTIONS_REGISTRY.length);
    });

    it('should include send_agent_message type', () => {
      const types = getActionTypes();

      expect(types).toContain('send_agent_message');
    });

    it('should return strings only', () => {
      const types = getActionTypes();

      for (const type of types) {
        expect(typeof type).toBe('string');
      }
    });
  });
});
