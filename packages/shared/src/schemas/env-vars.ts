import { z } from 'zod';

const EnvKeyRegex = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ControlCharRegex = /[\x00-\x1f]/;

export const EnvVarsSchema = z
  .record(z.string())
  .refine((env) => Object.keys(env).every((key) => EnvKeyRegex.test(key)), {
    message:
      'Environment variable keys must contain only alphanumeric characters and underscores, starting with a letter or underscore',
  })
  .refine((env) => Object.values(env).every((value) => !ControlCharRegex.test(value)), {
    message: 'Environment variable values must not contain control characters or newlines',
  })
  .nullable()
  .optional();
