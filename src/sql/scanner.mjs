// 只读词法扫描：把合作方 SQL 备份的原始字节切成语句。
// 不解释、不执行任何业务语义，只负责在尊重引号、注释、分隔符指令的前提下保留字节位置。
const SINGLE_QUOTE = 0x27; // '
const DOUBLE_QUOTE = 0x22; // "
const BACKTICK = 0x60; // `
const BACKSLASH = 0x5c; // \
const HYPHEN = 0x2d; // -
const HASH = 0x23; // #
const SLASH = 0x2f; // /
const STAR = 0x2a; // *
const DOUBLE_QUOTE_IDENT = 0x100; // ANSI_QUOTES 下双引号标识符的独立词法状态
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const WHITESPACE = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);

function isAsciiWordByte(code) {
  return (code >= 0x41 && code <= 0x5a) // A-Z
    || (code >= 0x61 && code <= 0x7a) // a-z
    || (code >= 0x30 && code <= 0x39) // 0-9
    || code === 0x5f || code === 0x24; // _ $
}

function wordAt(raw, position, word) {
  for (let offset = 0; offset < word.length; offset += 1) {
    const code = raw[position + offset];
    if (code === undefined || (code | 0x20) !== (word.charCodeAt(offset) | 0x20)) return false;
  }
  const following = raw[position + word.length];
  return following === undefined || !isAsciiWordByte(following);
}

// 轻量识别 SET ... SQL_MODE，仅供扫描期决定引号终止规则；语义解释仍由 parser 负责。
function detectSqlModeFlags(statementBuffer) {
  const text = statementBuffer.toString('utf8');
  if (!/^\s*SET\b/i.test(text) || !/\bSQL_MODE\b/i.test(text)) return null;
  const equalAt = text.search(/\bSQL_MODE\b[^=]*=/i);
  if (equalAt < 0) return null;
  const valueText = text.slice(text.indexOf('=', equalAt) + 1);
  if (/\bDEFAULT\b/i.test(valueText)) return { noBackslash: false, ansiQuotes: false };
  const modes = [];
  const quoted = /'([^']*)'/g;
  let match;
  while ((match = quoted.exec(valueText)) !== null) modes.push(...match[1].split(','));
  const stripped = valueText.replace(/'[^']*'/g, ' ').replace(/[(),]/g, ' ');
  for (const token of stripped.split(/\s+/)) if (/^[A-Z_]+$/i.test(token)) modes.push(token);
  const upper = modes.map(mode => mode.trim().toUpperCase()).filter(Boolean);
  return {
    noBackslash: upper.includes('NO_BACKSLASH_ESCAPES'),
    ansiQuotes: upper.includes('ANSI_QUOTES'),
  };
}

// 语句首词（动词或带引号的标识符）：用于判断双引号在 ANSI_QUOTES 下的词法角色。
function leadingWord(buffer) {
  let cursor = 0;
  while (cursor < buffer.length && WHITESPACE.has(buffer[cursor])) cursor += 1;
  let end = cursor;
  while (end < buffer.length && isAsciiWordByte(buffer[end])) end += 1;
  if (end === cursor) return null;
  return buffer.subarray(cursor, end).toString('ascii').toUpperCase();
}

// 输出：
// statements: 每条语句的字节范围、起止行、原文切片、是否以分隔符正常结束
// events: 条件注释、DELIMITER 指令、未闭合结构等不能当作普通空白吞掉的扫描事件
export function scanStatements(raw) {
  const statements = [];
  const events = [];
  const length = raw.length;
  let position = 0;
  let line = 1;
  let atLineStart = true;
  let delimiter = ';';
  let noBackslash = false;
  let ansiQuotes = false;

  const skipToLineEnd = () => {
    while (position < length && raw[position] !== NEWLINE) position += 1;
  };

  while (position < length) {
    const code = raw[position];
    if (code === NEWLINE) { line += 1; atLineStart = true; position += 1; continue; }
    if (WHITESPACE.has(code)) { position += 1; continue; }
    // 行注释：-- 后必须跟空白（MySQL 规则），以及 #
    if (code === HYPHEN && raw[position + 1] === HYPHEN
      && (raw[position + 2] === undefined || WHITESPACE.has(raw[position + 2]))) {
      skipToLineEnd(); continue;
    }
    if (code === HASH) { skipToLineEnd(); continue; }

    // 块注释；/*! ... */ 是 MySQL 可执行条件注释，/*+ ... */ 是优化器提示，都必须留痕。
    if (code === SLASH && raw[position + 1] === STAR) {
      const start = position; const startLine = line;
      const executable = raw[position + 2] === 0x21 || raw[position + 2] === 0x2b; // ! or +
      position += 2;
      while (position < length && !(raw[position] === STAR && raw[position + 1] === SLASH)) {
        if (raw[position] === NEWLINE) line += 1;
        position += 1;
      }
      if (position >= length) {
        events.push({ kind: 'unclosed-comment', start, end: length, line: startLine, executable });
        position = length; break;
      }
      position += 2;
      if (executable) events.push({ kind: 'conditional-comment', start, end: position, line: startLine });
      atLineStart = false; continue;
    }

    // DELIMITER 是客户端指令而非服务器 SQL；识别它才能正确切分存储程序主体，同时留下记录。
    if (atLineStart && wordAt(raw, position, 'DELIMITER')) {
      const start = position; const startLine = line;
      const lineEnd = (() => { let cursor = position + 9; while (cursor < length && raw[cursor] !== NEWLINE) cursor += 1; return cursor; })();
      const nextDelimiter = raw.subarray(position + 9, lineEnd).toString('utf8').trim();
      events.push({ kind: 'delimiter-directive', start, end: lineEnd, line: startLine, from: delimiter, to: nextDelimiter });
      if (!/^[^\s'`"]{1,16}$/.test(nextDelimiter)) {
        events.push({ kind: 'malformed-delimiter', start, end: lineEnd, line: startLine, value: nextDelimiter });
      } else { delimiter = nextDelimiter; }
      position = lineEnd; atLineStart = true; continue;
    }

    // 行首以外的字节出现后，后续词不再是行首指令。
    atLineStart = false;
    // 进入一条语句
    const statementStart = position;
    const statementStartLine = line;
    let terminated = false;
    let endPosition = length;
    let stringOpen = null;
    // ANSI_QUOTES 下双引号是标识符引号；但 SET 语句自身的模式值仍按字符串处理，
    // 否则 “SET SQL_MODE='ANSI_QUOTES'” 无法被完整切出。
    const doubleAsIdentifier = ansiQuotes === true
      && leadingWord(raw.subarray(statementStart, length)) !== 'SET';

    while (position < length) {
      const current = raw[position];
      if (current === NEWLINE) { line += 1; atLineStart = true; }
      else if (current !== WHITESPACE) atLineStart = false;

      if (stringOpen !== null) {
        if (stringOpen === BACKTICK) {
          if (current === BACKTICK) {
            if (raw[position + 1] === BACKTICK) { position += 2; continue; }
            stringOpen = null;
          }
          position += 1; continue;
        }
        if (stringOpen === DOUBLE_QUOTE_IDENT) {
          // ANSI_QUOTES 下双引号标识符：双写转义，不处理反斜杠。
          if (current === DOUBLE_QUOTE) {
            if (raw[position + 1] === DOUBLE_QUOTE) { position += 2; continue; }
            stringOpen = null;
          }
          position += 1; continue;
        }
        if (current === BACKSLASH && !noBackslash) { position += 2; continue; }
        if (current === stringOpen) {
          if (raw[position + 1] === stringOpen) { position += 2; continue; }
          stringOpen = null;
        }
        position += 1; continue;
      }

      if (current === SINGLE_QUOTE) { stringOpen = SINGLE_QUOTE; position += 1; continue; }
      if (current === DOUBLE_QUOTE) {
        stringOpen = doubleAsIdentifier ? DOUBLE_QUOTE_IDENT : DOUBLE_QUOTE;
        position += 1; continue;
      }
      if (current === BACKTICK) { stringOpen = BACKTICK; position += 1; continue; }
      if (current === HYPHEN && raw[position + 1] === HYPHEN
        && (raw[position + 2] === undefined || WHITESPACE.has(raw[position + 2]))) { skipToLineEnd(); continue; }
      if (current === HASH) { skipToLineEnd(); continue; }
      if (current === SLASH && raw[position + 1] === STAR) {
        const executable = raw[position + 2] === 0x21 || raw[position + 2] === 0x2b;
        const commentStart = position;
        position += 2;
        while (position < length && !(raw[position] === STAR && raw[position + 1] === SLASH)) {
          if (raw[position] === NEWLINE) line += 1;
          position += 1;
        }
        if (position >= length) {
          events.push({ kind: 'unclosed-comment', start: commentStart, end: length, line, executable });
          break;
        }
        position += 2; continue;
      }
      if (delimiter.length === 1 ? current === delimiter.charCodeAt(0)
        : raw.subarray(position, position + delimiter.length).toString('latin1') === delimiter) {
        endPosition = position + delimiter.length;
        terminated = true;
        position = endPosition;
        break;
      }
      position += 1;
    }

    if (stringOpen !== null) {
      events.push({ kind: 'unterminated-string', start: statementStart, end: position, line: statementStartLine });
    }
    const buffer = raw.subarray(statementStart, terminated ? endPosition - delimiter.length : endPosition);
    const index = statements.length;
    statements.push({
      index,
      start: statementStart,
      end: endPosition,
      startLine: statementStartLine,
      endLine: line,
      delimiter: terminated ? delimiter : null,
      terminated,
      raw: buffer,
      text: buffer.toString('utf8'),
    });
    if (!terminated) {
      // 未闭合引号/注释已推送更具体的事件时，不再重复推送笼统的截断事件。
      if (stringOpen === null) {
        events.push({ kind: 'truncated-statement', start: statementStart, end: endPosition, line: statementStartLine });
      }
      break;
    }
    const modeFlags = detectSqlModeFlags(buffer);
    if (modeFlags) { noBackslash = modeFlags.noBackslash; ansiQuotes = modeFlags.ansiQuotes; }
  }

  return { statements, events };
}
