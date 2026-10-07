import {
  EVENT_FIELDS_CATALOG,
  getSubscribableEvents,
  getEventDefinition,
  getEventFields,
  isSubscribableEvent,
  getEventsByCategory,
} from './event-fields-catalog';

// Layer: pure unit (static catalog contract). Direct catalog/function assertions
// are the cheapest reliable proof of subscriber field metadata because no
// runtime service or UI behavior participates in this mapping.
describe('EVENT_FIELDS_CATALOG', () => {
  describe('session.started', () => {
    const entry = EVENT_FIELDS_CATALOG['session.started'];

    it('exposes required project scope to subscribers', () => {
      const projectId = entry.fields.find((field) => field.field === 'projectId');

      expect(projectId).toEqual({ field: 'projectId', label: 'Project ID', type: 'string' });
    });
  });

  describe('session.stopped', () => {
    const entry = EVENT_FIELDS_CATALOG['session.stopped'];

    it('exposes termination source and reason to subscribers', () => {
      expect(entry.fields.map((field) => field.field)).toEqual(['sessionId', 'source', 'reason']);
    });
  });

  describe('agent.message.sent', () => {
    const entry = EVENT_FIELDS_CATALOG['agent.message.sent'];

    it('is discoverable in the chat category', () => {
      expect(entry).toBeDefined();
      expect(entry.name).toBe('agent.message.sent');
      expect(entry.category).toBe('chat');
      expect(getSubscribableEvents()).toContain('agent.message.sent');

      const chatEvents = getEventsByCategory().get('chat') ?? [];
      expect(chatEvents.map((event) => event.name)).toContain('agent.message.sent');
    });

    it('exposes only the supported scalar payload fields', () => {
      expect(entry.fields.map((field) => field.field)).toEqual([
        'projectId',
        'senderAgentId',
        'senderAgentName',
        'routingKind',
        'groupKind',
        'teamId',
        'teamName',
        'teamDeliveryMode',
        'recipientCount',
        'deliveryStatus',
      ]);
      expect(entry.fields.find((field) => field.field === 'recipientCount')?.type).toBe('number');
      expect(entry.fields.some((field) => field.field.startsWith('recipients'))).toBe(false);
    });

    it('marks group and team fields as nullable', () => {
      const nullableFields = entry.fields
        .filter((field) => field.nullable)
        .map((field) => field.field);

      expect(nullableFields).toEqual(['groupKind', 'teamId', 'teamName', 'teamDeliveryMode']);
    });
  });

  describe('epic.updated', () => {
    const entry = EVENT_FIELDS_CATALOG['epic.updated'];

    it('exposes the current root parent ID when the parent is unchanged', () => {
      const parentId = entry.fields.find((field) => field.field === 'parentId');

      expect(parentId).toEqual({
        field: 'parentId',
        label: 'Parent Epic ID',
        type: 'string',
        nullable: true,
      });
    });

    it('advertises stored tag changes without adding tag fields', () => {
      expect(entry.description).toContain('stored tags changed');
      expect(entry.fields.some((field) => field.field.includes('tags'))).toBe(false);
    });
  });

  describe('scheduled_epic.executed', () => {
    const entry = EVENT_FIELDS_CATALOG['scheduled_epic.executed'];

    it.each([
      {
        name: 'all fields',
        names: [
          'scheduleId',
          'runId',
          'projectId',
          'scheduleName',
          'triggerSource',
          'status',
          'plannedFor',
          'finishedAt',
          'lagMs',
          'createdEpicId',
          'createdEpicTitle',
          'errorCode',
          'errorMessage',
        ],
        nullable: undefined,
        type: undefined,
      },
      {
        name: 'nullable fields',
        names: ['lagMs', 'createdEpicId', 'createdEpicTitle', 'errorCode', 'errorMessage'],
        nullable: true,
        type: undefined,
      },
      {
        name: 'required fields',
        names: [
          'scheduleId',
          'runId',
          'projectId',
          'scheduleName',
          'triggerSource',
          'status',
          'plannedFor',
          'finishedAt',
        ],
        nullable: false,
        type: undefined,
      },
      { name: 'numeric fields', names: ['lagMs'], nullable: undefined, type: 'number' },
    ])('exposes $name', ({ names, nullable, type }) => {
      for (const name of names) {
        const field = entry.fields.find((f) => f.field === name);
        expect(field).toBeDefined();
        if (nullable === true) expect(field?.nullable).toBe(true);
        if (nullable === false) expect(field?.nullable).toBeFalsy();
        if (type !== undefined) expect(field?.type).toBe(type);
      }
    });
  });

  describe('getEventDefinition', () => {
    it('returns the scheduled_epic.executed definition', () => {
      const def = getEventDefinition('scheduled_epic.executed');
      expect(def).toBeDefined();
      expect(def?.category).toBe('epic');
    });

    it('returns undefined for unknown events', () => {
      expect(getEventDefinition('not.real')).toBeUndefined();
    });
  });

  describe('getEventFields', () => {
    it('returns fields for scheduled_epic.executed', () => {
      const fields = getEventFields('scheduled_epic.executed');
      expect(fields.length).toBeGreaterThan(0);
    });

    it('returns empty array for unknown events', () => {
      expect(getEventFields('not.real')).toEqual([]);
    });
  });

  describe('isSubscribableEvent', () => {
    it('returns true for scheduled_epic.executed', () => {
      expect(isSubscribableEvent('scheduled_epic.executed')).toBe(true);
    });

    it('returns false for unknown events', () => {
      expect(isSubscribableEvent('not.real')).toBe(false);
    });
  });

  describe('getEventsByCategory', () => {
    it('includes scheduled_epic.executed in the epic category', () => {
      const byCategory = getEventsByCategory();
      const epicEvents = byCategory.get('epic') ?? [];
      const names = epicEvents.map((e) => e.name);
      expect(names).toContain('scheduled_epic.executed');
    });
  });
});
