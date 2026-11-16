// 字面量解释：严格按语句生效时的 SQL_MODE 转义规则与会话字符集还原值。
// 只处理约定子集（字符串、X'hex'、十进制文本、NULL），其余形态交回调用方隔离。

// MySQL 默认（允许反斜杠转义）的字节级反转义。
function unescapeBackslash(bytes) {
  const out = Buffer.allocUnsafe(bytes.length);
  let write = 0;
  for (let read = 0; read < bytes.length; read += 1) {
    const code = bytes[read];
    if (code === 0x5c && read + 1 < bytes.length) { // backslash
      const next = bytes[read + 1];
      switch (next) {
        case 0x30: out[write++] = 0x00; read += 1; continue; // \0
        case 0x27: out[write++] = 0x27; read += 1; continue; // \'
        case 0x22: out[write++] = 0x22; read += 1; continue; // \"
        case 0x62: out[write++] = 0x08; read += 1; continue; // \b
        case 0x6e: out[write++] = 0x0a; read += 1; continue; // \n
        case 0x72: out[write++] = 0x0d; read += 1; continue; // \r
        case 0x74: out[write++] = 0x09; read += 1; continue; // \t
        case 0x5a: out[write++] = 0x1a; read += 1; continue; // \Z
        case 0x5c: out[write++] = 0x5c; read += 1; continue; // \\
        case 0x25: out[write++] = 0x25; read += 1; continue; // \%（LIKE 语义下仍保留，字节层面即原样）
        case 0x5f: out[write++] = 0x5f; read += 1; continue; // \_
        default: out[write++] = next; read += 1; continue; // 未知转义：MySQL 去掉反斜杠保留字符
      }
    }
    out[write++] = code;
  }
  return out.subarray(0, write);
}

// NO_BACKSLASH_ESCAPES：反斜杠是普通字符，引号只能靠双写转义。
function unescapePlain(bytes, quoteCode) {
  const out = Buffer.allocUnsafe(bytes.length);
  let write = 0;
  for (let read = 0; read < bytes.length; read += 1) {
    const code = bytes[read];
    if (code === quoteCode && bytes[read + 1] === quoteCode) {
      out[write++] = quoteCode; read += 1; continue;
    }
    out[write++] = code;
  }
  return out.subarray(0, write);
}

// 合作方备份常见声明到 Node.js 编码标签的映射；未列出的字符集不予猜测。
const CHARSET_LABELS = new Map([
  ['utf8', 'utf8'],
  ['utf8mb3', 'utf8'],
  ['utf8mb4', 'utf8'],
  ['latin1', 'latin1'],
  ['latin2', 'iso-8859-2'],
  ['latin5', 'iso-8859-9'],
  ['ascii', 'ascii'],
  ['cp1250', 'windows-1250'],
  ['cp1251', 'windows-1251'],
  ['cp1256', 'windows-1256'],
  ['cp1257', 'windows-1257'],
  ['gbk', 'gbk'],
  ['gb2312', 'gb2312'],
  ['gb18030', 'gb18030'],
  ['big5', 'big5'],
  ['sjis', 'shift_jis'],
  ['ujis', 'euc-jp'],
  ['euckr', 'euc-kr'],
]);

export function resolveCharset(declared) {
  if (declared === null) return { encoding: 'utf8', known: true, implicit: true };
  const key = declared.toLowerCase().replace(/[^a-z0-9]/g, '');
  const encoding = CHARSET_LABELS.get(key);
  // 映射存在但当前 Node 运行时不具备该编码（精简构建）时，同样按不支持处理，绝不静默乱猜。
  if (!encoding || !Buffer.isEncoding(encoding)) return { encoding: null, known: false, implicit: false };
  return { encoding, known: true, implicit: false };
}

// 还原一个已切出引号边界的字符串字面量内容。
export function decodeStringLiteral(innerBytes, quote, flags, charset) {
  const unescaped = flags.noBackslash
    ? unescapePlain(innerBytes, quote.charCodeAt(0))
    : unescapeBackslash(innerBytes);
  const { encoding, known, implicit } = resolveCharset(charset);
  if (!known) return { value: unescaped.toString('latin1'), encoding: null, unsupportedCharset: true };
  return { value: unescaped.toString(encoding), encoding, implicit };
}

export function decodeHexLiteral(content) {
  if (content.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(content)) return null;
  return Buffer.from(content, 'hex');
}

// 解析后的二进制值统一用信封对象表示，避免 JSON 中混入 Buffer。
export function binaryEnvelope(buffer) {
  return { $type: 'binary', encoding: 'hex', data: buffer.toString('hex') };
}

export function isDecimalText(text) {
  return /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text);
}
