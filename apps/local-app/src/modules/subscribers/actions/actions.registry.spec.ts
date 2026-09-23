import {
  ACTIONS_REGISTRY,
  getAction,
  getAllActions,
  getActionMetadata,
  hasAction,
  getActionTypes,
} from './actions.registry';
import { sendMessageAction } from './send-message.action';
import { deleteAgentAction } from './delete-agent.action';
import { terminateSessionAction } from './terminate-session.action';

describe('ActionsRegistry', () => {
  describe('ACTIONS_REGISTRY', () => {
    it('should be an array', () => {
      expect(Array.isArray(ACTIONS_REGISTRY)).toBe(true);
    });

    it('should contain sendMessageAction', () => {
      expect(ACTIONS_REGISTRY).toContain(sendMessageAction);
    });

    it('should contain deleteAgentAction', () => {
      expect(ACTIONS_REGISTRY).toContain(deleteAgentAction);
    });

    it('should contain terminateSessionAction', () => {
      expect(ACTIONS_REGISTRY).toContain(terminateSessionAction);
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

    it('should expose Delete Agent metadata with both optional selectors', () => {
      const deleteAgent = getAllActions().find((action) => action.type === 'delete_agent');

      expect(deleteAgent).toMatchObject({
        name: 'Delete Agent',
        category: 'session',
        supportsRetry: false,
      });
      expect(deleteAgent?.description).toMatch(/permanently delete/i);
      expect(deleteAgent?.description).toMatch(/Project Owners and Team Leads are protected/i);
      expect(deleteAgent?.inputs).toEqual([
        expect.objectContaining({ name: 'agentName', required: false }),
        expect.objectContaining({ name: 'familySlug', required: false }),
        expect.objectContaining({
          name: 'skipWhileEpicsInStatuses',
          type: 'select',
          multiple: true,
          optionsSource: 'project_statuses',
          required: false,
        }),
      ]);
    });

    it('should expose Terminate Session metadata with ordered optional selectors', () => {
      const terminateSession = getAllActions().find(
        (action) => action.type === 'terminate_session',
      );

      expect(terminateSession).toMatchObject({
        name: 'Terminate Session',
        category: 'session',
      });
      expect(terminateSession?.supportsRetry).toBeUndefined();
      expect(terminateSession?.inputs).toEqual([
        expect.objectContaining({
          name: 'agentName',
          label: 'Agent Name (Override)',
          type: 'string',
          required: false,
        }),
        expect.objectContaining({
          name: 'familySlug',
          label: 'Profile Family Slug',
          type: 'string',
          required: false,
        }),
        expect.objectContaining({
          name: 'skipWhileEpicsInStatuses',
          label: 'Skip while epics are in statuses',
          type: 'select',
          multiple: true,
          optionsSource: 'project_statuses',
          required: false,
        }),
      ]);
      expect(terminateSession?.inputs[1].description).toContain(
        'Family failures are not automatically retried, even when Retry on error is enabled.',
      );
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

    it('should include delete_agent type', () => {
      expect(getActionTypes()).toContain('delete_agent');
    });

    it('should include terminate_session type', () => {
      expect(getActionTypes()).toContain('terminate_session');
    });

    it('should return strings only', () => {
      const types = getActionTypes();

      for (const type of types) {
        expect(typeof type).toBe('string');
      }
    });
  });
});
