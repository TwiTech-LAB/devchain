/**
 * InteractiveCLI - User-friendly CLI output with colors and spinners
 *
 * Provides a clean, interactive interface for CLI operations with:
 * - Colored output (success=green, error=red, info=cyan)
 * - Animated spinners for long operations
 * - Progress indication
 * - Automatic fallback for non-TTY environments
 *
 * @module interactive-cli
 */

// ANSI color codes
const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

// Spinner frames (braille patterns for smooth animation)
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Animated spinner for long-running operations
 */
class Spinner {
  constructor(message, options = {}) {
    this.message = message;
    this.frames = options.frames || SPINNER_FRAMES;
    this.interval = options.interval || 80;
    this.index = 0;
    this.timer = null;
    this.startTime = null;
    this.colors = options.colors;
  }

  start() {
    this.startTime = Date.now();
    this.timer = setInterval(() => {
      const frame = this.frames[this.index];
      const text = this.colors
        ? `${COLORS.cyan}${frame}${COLORS.reset} ${this.message}...`
        : `${frame} ${this.message}...`;
      process.stdout.write(`\r  ${text}`);
      this.index = (this.index + 1) % this.frames.length;
    }, this.interval);
  }

  stop(result = '✓', showTime = false) {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    let output = result;
    if (showTime && this.startTime) {
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
      output = `${result} (${elapsed}s)`;
    }

    if (this.colors && result === '✓') {
      output = `${COLORS.green}${output}${COLORS.reset}`;
    } else if (this.colors && result === '✗') {
      output = `${COLORS.red}${output}${COLORS.reset}`;
    }

    process.stdout.write(`\r  ${this.message}... ${output}\n`);
  }
}

/**
 * Interactive CLI logger with color support and spinners
 */
class InteractiveCLI {
  constructor(options = {}) {
    this.interactive = options.interactive !== false;
    this.colors = options.colors !== false && this.shouldUseColors();
    this.spinners = options.spinners !== false;
    this.activeSpinner = null;
  }

  /**
   * Detect if colors should be used
   * Respects NO_COLOR env var and TTY detection
   */
  shouldUseColors() {
    // Respect NO_COLOR standard
    if (process.env.NO_COLOR) return false;

    // Disable colors in CI environments (unless explicitly enabled)
    if (process.env.CI && !process.env.FORCE_COLOR) return false;

    // Check if stdout is a TTY
    if (!process.stdout.isTTY) return false;

    return true;
  }

  /**
   * Apply ANSI color to text
   */
  colorize(text, color) {
    if (!this.colors) return text;
    return `${color}${text}${COLORS.reset}`;
  }

  /**
   * Start a step (in-progress indicator)
   * @param {string} message - Step description
   */
  step(message) {
    if (!this.interactive) return;
    process.stdout.write(`  ${message}...`);
  }

  /**
   * Complete a step
   * @param {string} result - Result indicator (default: ✓)
   */
  stepDone(result = '✓') {
    if (!this.interactive) return;

    let output = result;
    if (this.colors) {
      if (result.includes('✓')) {
        output = this.colorize(result, COLORS.green);
      } else if (result.includes('✗')) {
        output = this.colorize(result, COLORS.red);
      }
    }

    console.log(` ${output}`);
  }

  /**
   * Show success message
   * @param {string} message
   */
  success(message) {
    if (!this.interactive) return;
    const icon = this.colorize('✓', COLORS.green);
    console.log(`${icon} ${message}`);
  }

  /**
   * Show error message
   * @param {string} message
   */
  error(message) {
    if (!this.interactive) return;
    const icon = this.colorize('✗', COLORS.red);
    console.log(`${icon} ${message}`);
  }

  /**
   * Show info message
   * @param {string} message
   */
  info(message) {
    if (!this.interactive) return;
    const icon = this.colorize('→', COLORS.cyan);
    console.log(`${icon} ${message}`);
  }

  /**
   * Show warning message
   * @param {string} message
   */
  warn(message) {
    if (!this.interactive) return;
    const icon = this.colorize('⚠', COLORS.yellow);
    console.log(`${icon} ${message}`);
  }

  /**
   * Print a blank line
   */
  blank() {
    if (!this.interactive) return;
    console.log('');
  }

  /**
   * Create and return a spinner instance
   * @param {string} message - Spinner message
   * @returns {Spinner}
   */
  spinner(message) {
    if (!this.interactive || !this.spinners) {
      // Return a no-op spinner if not interactive
      return {
        start: () => {},
        stop: (result) => {
          if (this.interactive) {
            this.step(message);
            this.stepDone(result);
          }
        }
      };
    }

    // Clean up any existing spinner
    if (this.activeSpinner) {
      this.activeSpinner.stop();
    }

    this.activeSpinner = new Spinner(message, {
      colors: this.colors,
      frames: SPINNER_FRAMES,
      interval: 80
    });

    return this.activeSpinner;
  }

  /**
   * Show a progress bar
   * @param {number} current - Current progress
   * @param {number} total - Total steps
   * @param {string} label - Progress label
   */
  progress(current, total, label = '') {
    if (!this.interactive) return;

    const percentage = Math.floor((current / total) * 100);
    const filled = Math.floor((current / total) * 20);
    const empty = 20 - filled;

    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    const text = label ? ` ${label}` : '';

    const output = this.colors
      ? `[${this.colorize(bar, COLORS.cyan)}] ${percentage}%${text}`
      : `[${bar}] ${percentage}%${text}`;

    process.stdout.write(`\r  ${output}`);

    if (current === total) {
      console.log(''); // New line when complete
    }
  }

  /**
   * Start timing an operation
   * @param {string} label - Timer label
   */
  time(label) {
    if (!this.interactive) return;
    this._timers = this._timers || {};
    this._timers[label] = Date.now();
  }

  /**
   * End timing and display elapsed time
   * @param {string} label - Timer label
   */
  timeEnd(label) {
    if (!this.interactive) return;
    if (!this._timers || !this._timers[label]) return;

    const elapsed = ((Date.now() - this._timers[label]) / 1000).toFixed(1);
    const message = `${label} completed in ${elapsed}s`;

    this.info(this.colors ? this.colorize(message, COLORS.gray) : message);

    delete this._timers[label];
  }
}

module.exports = {
  InteractiveCLI,
  Spinner,
  COLORS,
};
