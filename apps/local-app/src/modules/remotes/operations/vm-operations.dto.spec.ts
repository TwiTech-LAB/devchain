import { ZodError } from 'zod';
import { CreateVmSchema, createVmSchemaForNamePrefix } from './vm-operations.dto';

const validRequest = {
  cores: 2,
  memory: 4096,
  disk: 30,
};

describe('createVmSchemaForNamePrefix', () => {
  it.each(['dev_box', 'box-', 'box.'])('rejects invalid composed name %s', (name) => {
    expect(() => createVmSchemaForNamePrefix('devchain-').parse({ ...validRequest, name })).toThrow(
      ZodError,
    );
  });

  it.each(['dev-box', 'box1'])('accepts valid composed name %s', (name) => {
    expect(createVmSchemaForNamePrefix('devchain-').parse({ ...validRequest, name }).name).toBe(
      name,
    );
  });
});

describe('CreateVmSchema memory minimum', () => {
  it('rejects 4095 MiB with the claim/update install message', () => {
    const result = CreateVmSchema.safeParse({
      ...validRequest,
      name: 'alpha',
      memory: 4095,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['memory'],
          message: 'Memory must be at least 4096 MiB for the claim/update install.',
        }),
      );
    }
  });
});
