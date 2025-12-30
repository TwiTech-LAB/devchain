import { z } from 'zod';

export const settingsTerminalChangedEvent = {
  name: 'settings.terminal.changed',
  schema: z.object({
    scrollbackLines: z.number().int().positive(),
  }),
} as const;

export type SettingsTerminalChangedEventPayload = z.infer<
  typeof settingsTerminalChangedEvent.schema
>;
