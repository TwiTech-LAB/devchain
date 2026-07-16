'use strict';

const { Terminal } = require('@xterm/headless');

function writeTerminal(terminal, data) {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function cellSnapshot(cell) {
  return [
    cell.getChars(),
    cell.getFgColorMode(),
    cell.getFgColor(),
    cell.getBgColorMode(),
    cell.getBgColor(),
    cell.isBold(),
    cell.isDim(),
    cell.isItalic(),
    cell.getUnderlineStyle(),
    cell.isInverse(),
    cell.isInvisible(),
    cell.isStrikethrough(),
    cell.isOverline(),
  ];
}

class HeadlessTerminalConsumer {
  constructor({ cols, rows }) {
    this.terminal = new Terminal({
      allowProposedApi: true,
      cols,
      rows,
      scrollback: 0,
      convertEol: true,
    });
    this.seedResets = 0;
  }

  async replay(envelopes) {
    let seedBatch = null;
    for (const envelope of envelopes) {
      if (envelope?.type === 'seed_ansi' && typeof envelope.payload?.data === 'string') {
        const { chunk, totalChunks, data } = envelope.payload;
        if (chunk === 0) seedBatch = new Array(totalChunks);
        if (!seedBatch || seedBatch.length !== totalChunks || !Number.isSafeInteger(chunk)) {
          throw new Error('Headless terminal received an invalid seed chunk sequence');
        }
        seedBatch[chunk] = data;
        if (chunk === totalChunks - 1) {
          if (seedBatch.some((part) => typeof part !== 'string')) {
            throw new Error('Headless terminal received an incomplete seed batch');
          }
          this.terminal.reset();
          await writeTerminal(this.terminal, seedBatch.join(''));
          this.seedResets += 1;
          seedBatch = null;
        }
      } else if (envelope?.type === 'data' && typeof envelope.payload?.data === 'string') {
        await writeTerminal(this.terminal, envelope.payload.data);
      }
    }
    if (seedBatch) throw new Error('Headless terminal ended with an incomplete seed batch');
    return this.snapshot();
  }

  async write(data) {
    await writeTerminal(this.terminal, data);
    return this.snapshot();
  }

  snapshot() {
    const buffer = this.terminal.buffer.active;
    const lines = [];
    const styledCells = [];
    for (let row = 0; row < this.terminal.rows; row += 1) {
      const line = buffer.getLine(buffer.viewportY + row);
      let text = '';
      for (let column = 0; column < this.terminal.cols; column += 1) {
        const cell = line?.getCell(column);
        if (!cell || cell.getWidth() === 0) continue;
        const chars = cell.getChars();
        text += chars || ' ';
        if (
          chars &&
          (!cell.isAttributeDefault() ||
            [...chars].some((codePoint) => codePoint.codePointAt(0) > 0x7f))
        ) {
          styledCells.push(cellSnapshot(cell));
        }
      }
      lines.push(text.trimEnd());
    }
    return {
      text: lines.join('\n').trim(),
      styledCells,
      seedResets: this.seedResets,
    };
  }

  dispose() {
    this.terminal.dispose();
  }
}

module.exports = { HeadlessTerminalConsumer };
