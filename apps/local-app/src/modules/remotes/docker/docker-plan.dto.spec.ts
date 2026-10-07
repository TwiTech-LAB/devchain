// Pure schema tests cover both request contracts without starting an application.
import { AttachProjectSchema } from '../operations/remote-operation.dto';
import { DockerPlanRequestSchema, DockerSelectionItemSchema } from './docker-plan.dto';

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
