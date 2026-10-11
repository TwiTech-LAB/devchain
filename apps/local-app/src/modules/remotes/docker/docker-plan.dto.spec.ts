// Pure schema tests cover both request contracts without starting an application.
import { AttachProjectSchema } from '../operations/remote-operation.dto';
import {
  DockerPlanRequestSchema,
  DockerSelectionItemSchema,
  DockerUserFixApplySchema,
} from './docker-plan.dto';

const selection = { id: 'container', mode: 'container-and-data' };

it.each([false, 'true', 1, null])('refuses a non-literal privileged acceptance (%s)', (value) => {
  const items = [{ ...selection, acceptPrivileged: value }];
  expect(DockerSelectionItemSchema.safeParse(items[0]).success).toBe(false);
  expect(
    DockerPlanRequestSchema.safeParse({
      remoteId: '22222222-2222-4222-8222-222222222222',
      items,
    }).success,
  ).toBe(false);
  expect(AttachProjectSchema.safeParse({ projectId: 'project', docker: { items } }).success).toBe(
    false,
  );
});

it.each([false, 'true', 1, null])(
  'requires a literal Move without the fix acknowledgment (%s)',
  (value) => {
    expect(
      DockerSelectionItemSchema.safeParse({ ...selection, moveWithoutUserFix: value }).success,
    ).toBe(false);
  },
);

it('accepts an explicit current selection acknowledgment in plan and attach requests', () => {
  const items = [{ ...selection, moveWithoutUserFix: true }];
  expect(
    DockerPlanRequestSchema.safeParse({ remoteId: '22222222-2222-4222-8222-222222222222', items })
      .success,
  ).toBe(true);
  expect(AttachProjectSchema.safeParse({ projectId: 'project', docker: { items } }).success).toBe(
    true,
  );
});

it('requires confirmation and accepts no path or replacement in an Apply request', () => {
  const request = {
    remoteId: '22222222-2222-4222-8222-222222222222',
    proposalId: '33333333-3333-4333-8333-333333333333',
    confirmed: true,
  };
  expect(DockerUserFixApplySchema.safeParse(request).success).toBe(true);
  expect(DockerUserFixApplySchema.safeParse({ ...request, confirmed: false }).success).toBe(false);
  expect(DockerUserFixApplySchema.safeParse({ ...request, file: '/arbitrary/path' }).success).toBe(
    false,
  );
  expect(DockerUserFixApplySchema.safeParse({ ...request, newUser: '0' }).success).toBe(false);
});
