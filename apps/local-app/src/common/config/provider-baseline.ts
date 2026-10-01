export const CLAUDE_JSON_BASELINE: Readonly<{ hasCompletedOnboarding: true }> = {
  hasCompletedOnboarding: true,
};

export const CLAUDE_SETTINGS_BASELINE = {
  skipDangerousModePermissionPrompt: true,
  attribution: { commit: '', pr: '' },
  preferredNotifChannel: 'notifications_disabled',
  autoMemoryEnabled: false,
  promptSuggestionEnabled: false,
  env: { DISABLE_AUTOUPDATER: '1' },
} as const;
