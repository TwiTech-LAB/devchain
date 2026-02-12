import { z } from 'zod';

const COMMUNITY_SOURCE_NAME_PATTERN = /^[a-z0-9-]+$/;
const GITHUB_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

export const CommunitySourceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((value) => value.toLowerCase())
  .refine((value) => COMMUNITY_SOURCE_NAME_PATTERN.test(value), {
    message: 'Source name must contain only lowercase letters, numbers, and hyphens.',
  });

export const GitHubOwnerSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => GITHUB_NAME_PATTERN.test(value), {
    message: 'GitHub owner contains invalid characters.',
  });

export const GitHubRepoSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => GITHUB_NAME_PATTERN.test(value), {
    message: 'GitHub repository contains invalid characters.',
  });

export const BranchSchema = z.string().trim().min(1).max(200).default('main');

export interface ParsedGitHubRepo {
  repoOwner: string;
  repoName: string;
}

interface ParsedGitHubRepoFailure {
  success: false;
  message: string;
}

interface ParsedGitHubRepoSuccess {
  success: true;
  data: ParsedGitHubRepo;
}

type ParsedGitHubRepoResult = ParsedGitHubRepoFailure | ParsedGitHubRepoSuccess;

const tryParseGitHubRepoUrl = (url: string): ParsedGitHubRepoResult => {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url.trim());
  } catch {
    return { success: false, message: 'Invalid GitHub URL format.' };
  }

  const host = parsedUrl.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') {
    return { success: false, message: 'Only github.com URLs are supported.' };
  }

  const segments = parsedUrl.pathname
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length < 2) {
    return { success: false, message: 'GitHub URL must include owner and repository.' };
  }

  const repoOwner = segments[0];
  const repoName = segments[1]?.replace(/\.git$/i, '') ?? '';

  if (!repoOwner || !repoName) {
    return { success: false, message: 'GitHub URL must include owner and repository.' };
  }

  if (!GITHUB_NAME_PATTERN.test(repoOwner) || !GITHUB_NAME_PATTERN.test(repoName)) {
    return {
      success: false,
      message: 'GitHub owner or repository contains invalid characters.',
    };
  }

  return {
    success: true,
    data: { repoOwner, repoName },
  };
};

export const parseGitHubRepoUrl = (url: string): ParsedGitHubRepo => {
  const parsed = tryParseGitHubRepoUrl(url);
  if (!parsed.success) {
    throw new Error(parsed.message);
  }
  return parsed.data;
};

const CreateCommunitySourceByRepoSchema = z.object({
  name: CommunitySourceNameSchema,
  repoOwner: GitHubOwnerSchema,
  repoName: GitHubRepoSchema,
  branch: BranchSchema.optional(),
});

const CreateCommunitySourceByUrlSchema = z
  .object({
    name: CommunitySourceNameSchema,
    url: z.string().trim().url(),
    branch: BranchSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const parsed = tryParseGitHubRepoUrl(value.url);
    if (parsed.success) {
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['url'],
      message: parsed.message,
    });
  })
  .transform((value, ctx) => {
    const parsed = tryParseGitHubRepoUrl(value.url);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: parsed.message,
      });
      return z.NEVER;
    }

    return {
      name: value.name,
      repoOwner: parsed.data.repoOwner,
      repoName: parsed.data.repoName,
      branch: value.branch ?? 'main',
    };
  });

const CreateCommunitySourceByRepoNormalizedSchema = CreateCommunitySourceByRepoSchema.transform(
  (value) => ({
    name: value.name,
    repoOwner: value.repoOwner,
    repoName: value.repoName,
    branch: value.branch ?? 'main',
  }),
);

export const CreateCommunitySourceSchema = z.union([
  CreateCommunitySourceByRepoNormalizedSchema,
  CreateCommunitySourceByUrlSchema,
]);

export const CommunitySourceResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  repoOwner: z.string(),
  repoName: z.string(),
  branch: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const CommunitySourceDeleteParamsSchema = z.object({
  id: z.string().uuid(),
});

export type CreateCommunitySourceDto = z.infer<typeof CreateCommunitySourceSchema>;
export type CommunitySourceResponseDto = z.infer<typeof CommunitySourceResponseSchema>;
export type CommunitySourceDeleteParamsDto = z.infer<typeof CommunitySourceDeleteParamsSchema>;
