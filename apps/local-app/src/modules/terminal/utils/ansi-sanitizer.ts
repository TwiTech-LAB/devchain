// Minimal ANSI sanitizer focused on preserving scrollback for TUIs by
// stripping alternate screen buffer toggles while leaving most CSI intact.
// This helps xterm.js accumulate history similarly to terminals that enable
// scrollback in alt-screen mode (e.g., GNOME Terminal configured accordingly).

// Matches DEC Private Mode set/reset sequences like:
//  - ESC[?1049h / ESC[?1049l (use/leave alt screen)
//  - ESC[?1047h / ESC[?1047l
//  - ESC[?47h   / ESC[?47l
// Any sequence that includes 47/1047/1049 among the numbers will be stripped.
const ALT_SCREEN_DPM_RE = /\x1b\[\?([0-9;]+)([hl])/g;
// DECSTBM (Set top/bottom margins) — e.g., ESC[3;24r. Parameterless ESC[r resets margins.
const DECSTBM_RE = /\x1b\[(\d*);(\d*)r/g;

function containsAltScreenCode(nums: string): boolean {
  const parts = nums.split(';');
  for (const p of parts) {
    if (p === '47' || p === '1047' || p === '1049') return true;
  }
  return false;
}

export function stripAlternateScreenSequences(data: string): string {
  return data.replace(ALT_SCREEN_DPM_RE, (match, nums) => {
    return containsAltScreenCode(nums) ? '' : match;
  });
}

// Extendable hook for future policy (OSC/DSR/APC/DCS/PM filtering) if needed.
export function sanitizeAnsiForClient(data: string): string {
  // Strip alt-screen toggles so output stays on the normal buffer.
  return stripAlternateScreenSequences(data);
}

// Stateful sanitizer that tracks alt-screen mode and, when active,
// normalizes scroll regions to full-screen so TUI scrolling contributes
// to global scrollback. Outside alt mode, data is left intact.
export class AltAwareAnsiSanitizer {
  private altActive = false;
  constructor(private readonly mode: 'normalize' | 'strip_alt' = 'normalize') {}

  process(chunk: string): string {
    // Track and strip alt-screen toggles
    chunk = chunk.replace(ALT_SCREEN_DPM_RE, (_m: string, nums: string, hl: string) => {
      if (containsAltScreenCode(nums)) {
        this.altActive = hl === 'h';
        return '';
      }
      return _m;
    });

    if (this.mode === 'normalize') {
      // Normalize region to full screen when alt is active OR when the app
      // explicitly sets a non-zero top margin (>1). This causes region scrolls
      // to push into global scrollback. Resets (CSI r) are preserved.
      chunk = chunk.replace(DECSTBM_RE, (_m: string, top: string, _bot: string) => {
        const topNum = top ? parseInt(top, 10) : NaN;
        const needsNormalize = this.altActive || (Number.isFinite(topNum) && topNum > 1);
        return needsNormalize ? '\x1b[r' : _m;
      });
    }

    return chunk;
  }
}
