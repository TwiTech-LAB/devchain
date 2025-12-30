import { z } from 'zod';
import {
  MIN_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_SCROLLBACK,
} from '../../../common/constants/terminal';

const EventTemplateSchema = z.object({
  template: z.string().nullable().optional(),
});

// Terminal input modes (exposed in Settings API)
export const TERMINAL_INPUT_MODES = ['form', 'tty'] as const;

const EventsSettingsSchema = z.object({
  epicAssigned: EventTemplateSchema.optional(),
});

// Terminal settings exposed via API
// Note: engine selector removed (Chat Mode only); seedingMode hidden (defaults to tmux)
const TerminalSettingsSchema = z.object({
  scrollbackLines: z
    .number()
    .int()
    .positive()
    .min(MIN_TERMINAL_SCROLLBACK)
    .max(MAX_TERMINAL_SCROLLBACK)
    .optional(),
  seedingMaxBytes: z
    .number()
    .int()
    .positive()
    .min(64 * 1024)
    .max(4 * 1024 * 1024)
    .optional(),
  inputMode: z.enum(TERMINAL_INPUT_MODES).optional(),
});

// Auto-clean settings for automatic agent unassignment
const AutoCleanSettingsSchema = z.object({
  // Mapping of projectId -> array of statusIds that trigger auto-clean
  statusIds: z.record(z.string(), z.array(z.string().uuid())).optional(),
});

// Registry template metadata for tracking installed templates per project
const RegistryTemplateMetadataSchema = z.object({
  templateSlug: z.string(),
  /** Template source: 'bundled' (shipped with app) or 'registry' (downloaded) */
  source: z.enum(['bundled', 'registry']).optional(), // Optional for backward compat, defaults to 'registry'
  /** Installed version - null for bundled templates */
  installedVersion: z.string().nullable(),
  /** Registry URL - null for bundled templates */
  registryUrl: z.string().nullable(),
  installedAt: z.string(), // ISO timestamp
  lastUpdateCheckAt: z.string().optional(), // ISO timestamp
});

// Registry configuration settings
const RegistryConfigSchema = z.object({
  url: z.string().url().optional(),
  cacheDir: z.string().optional(),
  checkUpdatesOnStartup: z.boolean().optional(),
});

// Message pool settings for batching messages to agent sessions
const MessagePoolSettingsSchema = z.object({
  // Whether message pooling is enabled (default: true)
  enabled: z.boolean().optional(),
  // Debounce delay before flushing in milliseconds (default: 10000)
  delayMs: z.number().int().positive().min(1000).max(60000).optional(),
  // Maximum wait time from first enqueue in milliseconds (default: 30000)
  maxWaitMs: z.number().int().positive().min(5000).max(120000).optional(),
  // Maximum messages before forced flush (default: 10)
  maxMessages: z.number().int().positive().min(1).max(100).optional(),
  // Separator between concatenated messages (default: '\n---\n')
  separator: z.string().max(100).optional(),
  // Per-project overrides: projectId -> pool settings
  projects: z
    .record(
      z.string(),
      z.object({
        enabled: z.boolean().optional(),
        delayMs: z.number().int().positive().min(1000).max(60000).optional(),
        maxWaitMs: z.number().int().positive().min(5000).max(120000).optional(),
        maxMessages: z.number().int().positive().min(1).max(100).optional(),
        separator: z.string().max(100).optional(),
      }),
    )
    .optional(),
});

export const SettingsSchema = z.object({
  claudeBinaryPath: z.string().optional(),
  codexBinaryPath: z.string().optional(),
  dbPath: z.string().optional(),
  // Deprecated global default; prefer per-project mapping below
  initialSessionPromptId: z.string().uuid().nullable().optional(),
  // Preferred: mapping of projectId -> promptId (string or null)
  initialSessionPromptIds: z.record(z.string(), z.string().uuid().nullable()).optional(),
  // For updates: pair of { projectId, initialSessionPromptId }
  projectId: z.string().optional(),
  events: EventsSettingsSchema.optional(),
  activity: z
    .object({
      idleTimeoutMs: z
        .number()
        .int()
        .positive()
        .min(1000)
        .max(24 * 60 * 60 * 1000)
        .optional(),
    })
    .optional(),
  terminal: TerminalSettingsSchema.optional(),
  autoClean: AutoCleanSettingsSchema.optional(),
  messagePool: MessagePoolSettingsSchema.optional(),
  // Registry configuration
  registry: RegistryConfigSchema.optional(),
  // Per-project template tracking: projectId -> metadata
  registryTemplates: z.record(z.string(), RegistryTemplateMetadataSchema).optional(),
});

export type SettingsDto = z.infer<typeof SettingsSchema>;
export type MessagePoolSettingsDto = z.infer<typeof MessagePoolSettingsSchema>;
export type TerminalSettingsDto = z.infer<typeof TerminalSettingsSchema>;
export type TerminalInputMode = (typeof TERMINAL_INPUT_MODES)[number];
export type RegistryTemplateMetadataDto = z.infer<typeof RegistryTemplateMetadataSchema>;
export type RegistryConfigDto = z.infer<typeof RegistryConfigSchema>;
