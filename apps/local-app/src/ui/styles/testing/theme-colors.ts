/**
 * Color math for the theme specs (global.css and the terminal themes). Channels are
 * 0-1 sRGB. The helpers throw on malformed input so the calling test fails with a reason.
 */
export type Rgb = [number, number, number];

export const WHITE: Rgb = [1, 1, 1];

/** The text of the first `selector { … }` block in a stylesheet, up to its closing brace. */
export function cssBlock(css: string, selector: string): string {
  const start = css.indexOf(selector);
  const end = start === -1 ? -1 : css.indexOf('}\n', start);
  if (end === -1) throw new Error(`No "${selector}" block in the stylesheet`);
  return css.slice(start, end);
}

/** The value of `--name: value;` inside a block. */
export function cssVariable(block: string, name: string): string {
  const match = block.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`No --${name} in the block`);
  return match[1].trim();
}

/** Converts shadcn HSL channels (`210 40% 98%`) to RGB. */
export function hslToRgb(channels: string): Rgb {
  const match = channels.match(/^(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%$/);
  if (!match) throw new Error(`"${channels}" is not "H S% L%"`);
  const [h, s, l] = [Number(match[1]), Number(match[2]) / 100, Number(match[3]) / 100];
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

export function hexToRgb(hex: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
}

export function rgbToHex(color: Rgb): string {
  return `#${color
    .map((c) =>
      Math.round(c * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** `color` at `alpha` over `surface`. */
export function tint(color: Rgb, alpha: number, surface: Rgb = WHITE): Rgb {
  return color.map((c, i) => c * alpha + surface[i] * (1 - alpha)) as Rgb;
}

function luminance(color: Rgb): number {
  const [r, g, b] = color.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio of two colors. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
