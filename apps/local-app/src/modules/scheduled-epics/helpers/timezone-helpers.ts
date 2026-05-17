export type TimezoneValidationResult = { valid: true } | { valid: false; reason: string };

export function validateTimezone(timezone: string): TimezoneValidationResult {
  if (!timezone || timezone.trim() === '') {
    return { valid: false, reason: 'Timezone must not be empty' };
  }

  // Intl.DateTimeFormat is the authoritative check; it accepts UTC, GMT, and all IANA names.
  // Intl.supportedValuesOf('timeZone') omits UTC/GMT so we do not use it as the primary gate.
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return { valid: true };
  } catch {
    return { valid: false, reason: `Unknown timezone: "${timezone}"` };
  }
}
