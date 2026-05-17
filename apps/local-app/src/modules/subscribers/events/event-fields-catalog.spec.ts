import {
  EVENT_FIELDS_CATALOG,
  getSubscribableEvents,
  getEventDefinition,
  getEventFields,
  isSubscribableEvent,
  getEventsByCategory,
} from './event-fields-catalog';

describe('EVENT_FIELDS_CATALOG', () => {
  describe('scheduled_epic.executed', () => {
    const entry = EVENT_FIELDS_CATALOG['scheduled_epic.executed'];

    it('is present in the catalog', () => {
      expect(entry).toBeDefined();
    });

    it('uses the epic category', () => {
      expect(entry.category).toBe('epic');
    });

    it('has the correct name and label', () => {
      expect(entry.name).toBe('scheduled_epic.executed');
      expect(entry.label).toBe('Scheduled Epic Executed');
    });

    it('exposes all required payload fields', () => {
      const fieldNames = entry.fields.map((f) => f.field);
      expect(fieldNames).toEqual(
        expect.arrayContaining([
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
        ]),
      );
    });

    it('marks nullable fields correctly', () => {
      const nullable = entry.fields.filter((f) => f.nullable).map((f) => f.field);
      expect(nullable).toEqual(
        expect.arrayContaining([
          'lagMs',
          'createdEpicId',
          'createdEpicTitle',
          'errorCode',
          'errorMessage',
        ]),
      );
    });

    it('does not mark required fields as nullable', () => {
      const required = [
        'scheduleId',
        'runId',
        'projectId',
        'scheduleName',
        'triggerSource',
        'status',
        'plannedFor',
        'finishedAt',
      ];
      for (const name of required) {
        const field = entry.fields.find((f) => f.field === name);
        expect(field?.nullable).toBeFalsy();
      }
    });

    it('has correct types for numeric fields', () => {
      const lagMs = entry.fields.find((f) => f.field === 'lagMs');
      expect(lagMs?.type).toBe('number');
    });
  });

  describe('getSubscribableEvents', () => {
    it('includes scheduled_epic.executed', () => {
      expect(getSubscribableEvents()).toContain('scheduled_epic.executed');
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

    it('does not introduce a schedule category', () => {
      const byCategory = getEventsByCategory();
      expect(byCategory.has('schedule')).toBe(false);
    });

    it('preserves epic.created alongside scheduled_epic.executed', () => {
      const byCategory = getEventsByCategory();
      const epicEvents = byCategory.get('epic') ?? [];
      const names = epicEvents.map((e) => e.name);
      expect(names).toContain('epic.created');
      expect(names).toContain('scheduled_epic.executed');
    });
  });
});
