import { NotFoundException } from '@nestjs/common';
import { ActionsController } from './actions.controller';
import * as actionsRegistry from '../actions/actions.registry';
import type { ActionCategory } from '../actions/action.interface';

describe('ActionsController', () => {
  let controller: ActionsController;

  beforeEach(() => {
    controller = new ActionsController();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('listActions', () => {
    it('should return all actions without execute function', () => {
      const mockActions = [
        {
          type: 'send_agent_message',
          name: 'Send Message',
          description: 'Send a message to the terminal',
          category: 'terminal' as ActionCategory,
          inputs: [],
        },
      ];
      jest.spyOn(actionsRegistry, 'getAllActions').mockReturnValue(mockActions);

      const result = controller.listActions();

      expect(result).toEqual(mockActions);
      expect(actionsRegistry.getAllActions).toHaveBeenCalled();
    });

    it('should return empty array when no actions registered', () => {
      jest.spyOn(actionsRegistry, 'getAllActions').mockReturnValue([]);

      const result = controller.listActions();

      expect(result).toEqual([]);
    });

    it('should not include execute function in response', () => {
      const mockActions = [
        {
          type: 'send_agent_message',
          name: 'Send Message',
          description: 'Send a message',
          category: 'terminal' as ActionCategory,
          inputs: [],
        },
      ];
      jest.spyOn(actionsRegistry, 'getAllActions').mockReturnValue(mockActions);

      const result = controller.listActions();

      for (const action of result) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((action as any).execute).toBeUndefined();
      }
    });
  });

  describe('getAction', () => {
    it('should return action metadata when found', () => {
      const mockAction = {
        type: 'send_agent_message',
        name: 'Send Message',
        description: 'Send a message to the terminal',
        category: 'terminal' as const,
        inputs: [],
      };
      jest.spyOn(actionsRegistry, 'getActionMetadata').mockReturnValue(mockAction);

      const result = controller.getAction('send_agent_message');

      expect(result).toEqual(mockAction);
      expect(actionsRegistry.getActionMetadata).toHaveBeenCalledWith('send_agent_message');
    });

    it('should throw NotFoundException when action not found', () => {
      jest.spyOn(actionsRegistry, 'getActionMetadata').mockReturnValue(undefined);

      expect(() => controller.getAction('non_existent')).toThrow(NotFoundException);
      expect(() => controller.getAction('non_existent')).toThrow(
        "Action type 'non_existent' not found",
      );
    });

    it('should not include execute function in response', () => {
      const mockAction = {
        type: 'send_agent_message',
        name: 'Send Message',
        description: 'Send a message',
        category: 'terminal' as const,
        inputs: [],
      };
      jest.spyOn(actionsRegistry, 'getActionMetadata').mockReturnValue(mockAction);

      const result = controller.getAction('send_agent_message');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).execute).toBeUndefined();
    });
  });
});
