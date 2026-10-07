import { NotFoundException } from '@nestjs/common';
import { ActionsController } from './actions.controller';
import * as actionsRegistry from '../actions/actions.registry';

describe('ActionsController', () => {
  let controller: ActionsController;

  beforeEach(() => {
    controller = new ActionsController();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('listActions', () => {
    it('should expose Delete Agent metadata through the actions API', () => {
      const result = controller.listActions();
      const deleteAgent = result.find((action) => action.type === 'delete_agent');

      expect(deleteAgent).toMatchObject({
        name: 'Delete Agent',
        category: 'session',
        supportsRetry: false,
      });
      expect(deleteAgent?.inputs.map((input) => input.name)).toEqual([
        'agentName',
        'familySlug',
        'skipWhileEpicsInStatuses',
      ]);
      expect(deleteAgent).not.toHaveProperty('execute');
    });
  });

  describe('getAction', () => {
    it('should throw NotFoundException when action not found', () => {
      jest.spyOn(actionsRegistry, 'getActionMetadata').mockReturnValue(undefined);

      expect(() => controller.getAction('non_existent')).toThrow(NotFoundException);
      expect(() => controller.getAction('non_existent')).toThrow(
        "Action type 'non_existent' not found",
      );
    });
  });
});
