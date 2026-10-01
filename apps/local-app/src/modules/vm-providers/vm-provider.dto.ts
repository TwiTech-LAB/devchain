import { z } from 'zod';

function invalidHttpsOrigin(ctx: z.RefinementCtx): typeof z.NEVER {
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'apiUrl must be an HTTPS origin' });
  return z.NEVER;
}

const HttpsOriginSchema = z.string().transform((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return invalidHttpsOrigin(ctx);
  }
  if (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash
  ) {
    return url.origin;
  }
  return invalidHttpsOrigin(ctx);
});

export const CreateVmProviderConnectionSchema = z
  .object({
    kind: z.literal('proxmox'),
    name: z.string().trim().min(1).max(128),
    apiUrl: HttpsOriginSchema,
    node: z.string().trim().min(1),
    pool: z.string().trim().min(1),
    storage: z.string().trim().min(1),
    imageStorage: z.string().trim().min(1),
    bridge: z.string().trim().min(1),
    vmidMin: z.number().int().positive(),
    vmidMax: z.number().int().positive(),
    namePrefix: z.string().min(1),
    tag: z.string().min(1),
    sslFingerprint: z.string().regex(/^([0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2}$|^[0-9a-fA-F]{64}$/),
    caPem: z.string().min(1).optional(),
    tokenId: z.string().min(1),
    tokenSecret: z.string().min(1),
  })
  .strict()
  .refine((value) => value.vmidMax >= value.vmidMin, {
    path: ['vmidMax'],
    message: 'vmidMax must be at least vmidMin',
  });
