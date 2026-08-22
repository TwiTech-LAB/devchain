import type { z } from 'zod';
import { ValidationError } from '../../common/errors/error-types';

export function parseOrThrow<T, I>(
  schema: z.ZodType<T, z.ZodTypeDef, I>,
  value: unknown,
  fallbackMessage: string,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  const issue = parsed.error.issues[0];
  const field = typeof issue?.path[0] === 'string' ? issue.path[0] : 'provider';
  throw new ValidationError(issue?.message ?? fallbackMessage, { field });
}
