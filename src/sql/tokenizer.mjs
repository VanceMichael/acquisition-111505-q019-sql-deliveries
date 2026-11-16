// 结构化记号化：在单条语句的字节范围内产生带字节偏移的记号。
// 注释在记号层处理；条件可执行注释保留为独立记号，绝不当作普通空白吞掉。
const SINGLE_QUOTE = 0x27;
const DOUBLE_QUOTE = 0x22;
const BACKTICK = 0x60;
const BACKSLASH = 0x5c;
const WHITESPACE = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);
// 0x80 及以上是 UTF-8 续字节/首字节，允许出现在裸标识符中（中文库名/表名），文本按 UTF-8 解码。
const WORD_START = code => (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
  || code === 0x5f || code === 0x24 || code >= 0x80;
const WORD_PART = code => WORD_START(code) || (code >= 0x30 && code <= 0x39);
const DIGIT = code => code >= 0x30 && code <= 0x39;

function unescapeIdentifier(bytes) {
  let out = Buffer.allocUnsafe(bytes.length);
  let write = 0;
  for (let read = 0; read < bytes.length; read += 1) {
    if (bytes[read] === BACKTICK && bytes[read + 1] === BACKTICK) { out[write++] = BACKTICK; read += 1; }
    else out[write++] = bytes[read];
  }
  return out.subarray(0, write).toString('utf8');
}

export function tokenize(buffer, flags = {}) {
  const tokens = [];
  let position = 0;
  const length = buffer.length;
  // 与扫描层一致：ANSI_QUOTES 下双引号是标识符引号，唯独 SET 的模式值按字符串处理。
  const leading = buffer.toString('utf8').trimStart().match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
  const doubleAsIdent = Boolean(flags.ansiQuotes) && (!leading || leading[0].toUpperCase() !== 'SET');

  const skipWhitespaceAndComments = () => {
    while (position < length) {
      const code = buffer[position];
      if (WHITESPACE.has(code)) { position += 1; continue; }
      if (code === 0x2d && buffer[position + 1] === 0x2d
        && (buffer[position + 2] === undefined || WHITESPACE.has(buffer[position + 2]))) {
        while (position < length && buffer[position] !== 0x0a) position += 1;
        continue;
      }
      if (code === 0x23) { while (position < length && buffer[position] !== 0x0a) position += 1; continue; }
      if (code === 0x2f && buffer[position + 1] === 0x2a) {
        const start = position;
        const executable = buffer[position + 2] === 0x21 || buffer[position + 2] === 0x2b;
        position += 2;
        while (position < length && !(buffer[position] === 0x2a && buffer[position + 1] === 0x2f)) position += 1;
        const end = position >= length ? length : position + 2;
        tokens.push({ kind: 'conditional', value: executable, start, end });
        position = end;
        continue;
      }
      break;
    }
  };

  while (position < length) {
    skipWhitespaceAndComments();
    if (position >= length) break;
    const start = position;
    const code = buffer[position];

    if (code === BACKTICK) {
      position += 1;
      while (position < length) {
        if (buffer[position] === BACKTICK) {
          if (buffer[position + 1] === BACKTICK) { position += 2; continue; }
          position += 1; break;
        }
        position += 1;
      }
      if (position > length || buffer[position - 1] !== BACKTICK) {
        tokens.push({ kind: 'malformed', reason: '反引号标识符未闭合', start, end: length });
        break;
      }
      tokens.push({ kind: 'ident', value: unescapeIdentifier(buffer.subarray(start + 1, position - 1)), start, end: position });
      continue;
    }

    if (code === SINGLE_QUOTE || code === DOUBLE_QUOTE && !doubleAsIdent) {
      const quote = code;
      position += 1;
      const innerStart = position;
      while (position < length) {
        const current = buffer[position];
        if (current === BACKSLASH && !flags.noBackslash) { position += 2; continue; }
        if (current === quote) {
          if (buffer[position + 1] === quote) { position += 2; continue; }
          break;
        }
        position += 1;
      }
      if (position >= length) {
        tokens.push({ kind: 'malformed', reason: '字符串字面量未闭合', start, end: length });
        break;
      }
      tokens.push({ kind: 'string', quote: String.fromCharCode(quote), inner: buffer.subarray(innerStart, position), start, end: position + 1 });
      position += 1;
      continue;
    }

    if (code === DOUBLE_QUOTE && doubleAsIdent) {
      position += 1;
      const nameStart = position;
      while (position < length) {
        if (buffer[position] === DOUBLE_QUOTE) {
          if (buffer[position + 1] === DOUBLE_QUOTE) { position += 2; continue; }
          break;
        }
        position += 1;
      }
      if (position >= length) { tokens.push({ kind: 'malformed', reason: 'ANSI 双引号标识符未闭合', start, end: length }); break; }
      tokens.push({ kind: 'ident', value: buffer.subarray(nameStart, position).toString('utf8'), start, end: position + 1 });
      position += 1;
      continue;
    }

    // X'hex' / x'hex' 十六进制字面量
    if ((code === 0x58 || code === 0x78) && buffer[position + 1] === SINGLE_QUOTE) {
      position += 2;
      const contentStart = position;
      while (position < length && buffer[position] !== SINGLE_QUOTE) position += 1;
      if (position >= length) { tokens.push({ kind: 'malformed', reason: '十六进制字面量未闭合', start, end: length }); break; }
      tokens.push({ kind: 'hex', value: buffer.subarray(contentStart, position).toString('ascii'), start, end: position + 1 });
      position += 1;
      continue;
    }

    if (WORD_START(code)) {
      position += 1;
      while (position < length && WORD_PART(buffer[position])) position += 1;
      const raw = buffer.subarray(start, position).toString('utf8');
      tokens.push({ kind: 'word', raw, upper: raw.toUpperCase(), start, end: position });
      continue;
    }

    if (DIGIT(code) || code === 0x2e && DIGIT(buffer[position + 1])) {
      position += 1;
      while (position < length && (DIGIT(buffer[position]) || buffer[position] === 0x2e)) position += 1;
      tokens.push({ kind: 'number', raw: buffer.subarray(start, position).toString('ascii'), start, end: position });
      continue;
    }

    tokens.push({ kind: 'punct', raw: String.fromCharCode(code), start, end: position + 1 });
    position += 1;
  }
  return tokens;
}

export class Cursor {
  constructor(tokens) { this.tokens = tokens; this.index = 0; }
  get atEnd() { return this.index >= this.tokens.length; }
  peek(offset = 0) { return this.tokens[this.index + offset] || null; }
  take() { return this.tokens[this.index++] || null; }
  isWord(word) { const token = this.peek(); return Boolean(token) && token.kind === 'word' && token.upper === word; }
  takeWord(word) { if (this.isWord(word)) { this.index += 1; return true; } return false; }
  isPunct(mark) { const token = this.peek(); return Boolean(token) && token.kind === 'punct' && token.raw === mark; }
  takePunct(mark) { if (this.isPunct(mark)) { this.index += 1; return true; } return false; }
  nameOf(token) {
    if (!token || token.kind !== 'ident' && token.kind !== 'word') return null;
    return token.kind === 'ident' ? token.value : token.raw;
  }
  takeName() {
    const token = this.peek();
    const name = this.nameOf(token);
    if (name === null) return null;
    this.index += 1;
    return name;
  }
}
