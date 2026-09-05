import { RelationConfirmationSchema } from './epic-relations.models';

describe('epic-relations confirmation contract', () => {
  it('accepts well-formed accepted route facts', () => {
    expect(
      RelationConfirmationSchema.safeParse({
        acceptedRouteEffect: {
          sourceEpicId: '11111111-1111-4111-8111-111111111111',
          targetEpicId: '22222222-2222-4222-8222-222222222222',
        },
      }).success,
    ).toBe(true);
  });

  it('rejects malformed confirmation facts and unknown keys', () => {
    expect(
      RelationConfirmationSchema.safeParse({
        acceptedRouteEffect: {
          sourceEpicId: 'not-a-uuid',
          targetEpicId: '22222222-2222-4222-8222-222222222222',
        },
      }).success,
    ).toBe(false);
    expect(
      RelationConfirmationSchema.safeParse({
        acceptedRouteEffect: {
          sourceEpicId: '11111111-1111-4111-8111-111111111111',
          targetEpicId: '22222222-2222-4222-8222-222222222222',
        },
        extra: true,
      }).success,
    ).toBe(false);
  });
});
