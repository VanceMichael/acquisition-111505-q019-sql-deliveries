// 只读交付解析：按“语句生效当时”的会话设置与表布局解释登记数据。
// 全程不执行任何 SQL；不支持的语句/表达式进入隔离区，已确认的材料照常保留。
import { scanStatements } from './scanner.mjs';
import { tokenize, Cursor } from './tokenizer.mjs';
import { decodeStringLiteral, decodeHexLiteral, binaryEnvelope, isDecimalText, resolveCharset } from './literals.mjs';

const SUPPORTED_TOP_LEVEL = new Set(['SET', 'USE', 'CREATE', 'DROP', 'INSERT', 'BEGIN', 'COMMIT', 'ROLLBACK', 'START']);

function positionOf(statement) {
  return {
    statementIndex: statement.index,
    startByte: statement.start,
    endByte: statement.end,
    startLine: statement.startLine,
    endLine: statement.endLine,
  };
}

function previewOf(statement) {
  const text = statement.text.trim().replace(/\s+/g, ' ');
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function qualifiedName(database, table) {
  return database === null ? `(未选库).${table}` : `${database}.${table}`;
}

// 把记号位置翻译回语句内字节偏移，供证据定位。
function tokenByte(statement, token) {
  return token === null ? null : { offset: token.start, end: token.end, line: statement.startLine };
}

export function parseDelivery(raw, options = {}) {
  const sourceFile = options.sourceFile || 'delivery.sql';
  const { statements, events } = scanStatements(raw);

  const session = {
    charset: null, // 声明值；null 表示尚未声明
    flags: { noBackslash: false, ansiQuotes: false },
    database: null,
  };
  const tableOrder = [];
  const tableMap = new Map();
  const quarantine = [];
  const incomplete = [];
  const sessionTrace = [];
  let transaction = null;
  let batchSeq = 0;
  let dataStatementCount = 0;
  let definitionStatementCount = 0;

  const quarantineStatement = (statement, type, reason, extra = {}) => {
    quarantine.push({ type, reason, position: positionOf(statement), preview: previewOf(statement), ...extra });
  };

  const tableKeyFor = (statement, database, table) => {
    if (database === null && session.database === null) {
      quarantineStatement(statement, 'missing-database', '表名未限定且脚本尚未通过 USE 选择数据库，无法确定业务身份');
      return null;
    }
    return qualifiedName(database ?? session.database, table);
  };

  const obtainTable = (key, base) => {
    let record = tableMap.get(key);
    if (!record) {
      record = {
        ...base,
        generation: 0,
        generations: [],
      };
      tableMap.set(key, record);
      tableOrder.push(key);
    }
    return record;
  };

  const newGeneration = (record, table, database, columns, statement) => {
    record.generation += 1;
    const generation = {
      database,
      table,
      generation: record.generation,
      columns: columns.map(({ name, type }) => ({ name, type })),
      definition: positionOf(statement),
      droppedAt: null,
      acceptedRows: [],
      batches: [],
      pendingRows: [],
    };
    record.generations.push(generation);
    return generation;
  };

  const requireDatabaseName = cursor => {
    let name = cursor.takeName();
    if (name === null) return null;
    while (cursor.takePunct('.')) {
      const next = cursor.takeName();
      if (next === null) return null;
      name = next;
    }
    return name;
  };

  // ---------- 语句级解析器 ----------

  function parseSet(statement, cursor) {
    // SET NAMES 允许无等号写法：SET NAMES utf8mb4 [COLLATE ...]
    if (cursor.isWord('NAMES')) {
      cursor.take();
      const value = cursor.take();
      if (!value || value.kind !== 'string' && value.kind !== 'word') {
        throw new Error('SET NAMES 需要字符集名');
      }
      const declared = value.kind === 'string'
        ? decodeStringLiteral(value.inner, value.quote, session.flags, session.charset).value
        : value.raw;
      if (cursor.takeWord('COLLATE')) {
        const collation = cursor.take();
        if (!collation) throw new Error('SET NAMES COLLATE 缺少排序规则名');
      }
      if (!cursor.atEnd) throw new Error('SET NAMES 尾部存在无法解释的记号');
      const resolved = resolveCharset(declared);
      sessionTrace.push({ kind: 'charset', declared, known: resolved.known, encoding: resolved.encoding, position: positionOf(statement) });
      if (!resolved.known) {
        quarantineStatement(statement, 'unsupported-charset', `字符集声明 ${declared} 不在可解释清单内，字符串按 latin1 兜底且该语句后的字符串值需人工复核`, { declared });
        session.charset = null;
      } else {
        session.charset = declared;
      }
      return;
    }

    const assignments = [];
    for (;;) {
      const nameToken = cursor.peek();
      const name = cursor.nameOf(nameToken);
      if (name === null) throw new Error('SET 目标无法识别');
      cursor.take();
      const path = [name.toUpperCase()];
      while (cursor.takePunct('.')) {
        const part = cursor.takeName();
        if (part === null) throw new Error('SET 变量路径无法识别');
        path.push(part.toUpperCase());
      }
      if (!cursor.takePunct('=')) {
        if (cursor.takeWord('DEFAULT')) { assignments.push({ path, kind: 'default' }); }
        else throw new Error('SET 缺少赋值号');
      } else {
        const value = cursor.take();
        if (!value || value.kind !== 'string' && value.kind !== 'word' && value.kind !== 'number') {
          throw new Error('SET 赋值表达式不在支持子集内');
        }
        assignments.push({ path, kind: 'value', value, token: value });
      }
      if (!cursor.takePunct(',')) break;
    }
    if (!cursor.atEnd) throw new Error('SET 尾部存在无法解释的记号');

    for (const assignment of assignments) {
      const head = assignment.path[0];
      if (head === 'NAMES') {
        if (assignment.kind !== 'value') throw new Error('SET NAMES 需要字符集名');
        const declared = assignment.value.kind === 'string'
          ? decodeStringLiteral(assignment.value.inner, assignment.value.quote, session.flags, session.charset).value
          : assignment.value.raw;
        const resolved = resolveCharset(declared);
        sessionTrace.push({ kind: 'charset', declared, known: resolved.known, encoding: resolved.encoding, position: positionOf(statement) });
        if (!resolved.known) {
          quarantineStatement(statement, 'unsupported-charset', `字符集声明 ${declared} 不在可解释清单内，字符串按 latin1 兜底且该语句后的字符串值需人工复核`, { declared });
          session.charset = null;
        } else {
          session.charset = declared;
        }
      } else if (head === 'SQL_MODE') {
        const modes = [];
        if (assignment.kind === 'default') {
          session.flags = { noBackslash: false, ansiQuotes: false };
        } else if (assignment.value.kind === 'string') {
          const literal = decodeStringLiteral(assignment.value.inner, assignment.value.quote, session.flags, session.charset);
          modes.push(...literal.value.split(',').map(part => part.trim().toUpperCase()).filter(Boolean));
        } else if (assignment.value.kind === 'word') {
          modes.push(assignment.value.raw.toUpperCase());
        } else {
          throw new Error('SQL_MODE 赋值形态不支持');
        }
        session.flags = {
          noBackslash: modes.includes('NO_BACKSLASH_ESCAPES'),
          ansiQuotes: modes.includes('ANSI_QUOTES'),
        };
        sessionTrace.push({ kind: 'sql-mode', modes, flags: { ...session.flags }, position: positionOf(statement) });
      } else {
        throw new Error(`仅支持 SET NAMES 与 SET SQL_MODE，收到 ${head}`);
      }
    }
  }

  function parseUse(statement, cursor) {
    const name = requireDatabaseName(cursor);
    if (name === null || !cursor.atEnd) throw new Error('USE 语句形态不支持');
    session.database = name;
    sessionTrace.push({ kind: 'database', database: name, position: positionOf(statement) });
  }

  function parseCreateTable(statement, cursor) {
    if (!cursor.takeWord('TABLE')) throw new Error('CREATE 目标仅支持 TABLE');
    cursor.takeWord('IF'); cursor.takeWord('NOT'); cursor.takeWord('EXISTS');
    let database = session.database;
    let table = cursor.takeName();
    if (table === null) throw new Error('CREATE TABLE 缺少表名');
    if (cursor.takePunct('.')) {
      database = table;
      table = cursor.takeName();
      if (table === null) throw new Error('限定表名不完整');
    }
    if (session.database === null && database === null) {
      quarantineStatement(statement, 'missing-database', 'CREATE TABLE 未限定数据库且尚未执行 USE');
      return;
    }
    if (!cursor.takePunct('(')) throw new Error('CREATE TABLE 缺少列定义括号');

    const columns = [];
    let depth = 1;
    while (depth > 0) {
      const token = cursor.take();
      if (token === null) throw new Error('CREATE TABLE 定义被截断');
      if (token.kind === 'punct' && token.raw === '(') { depth += 1; continue; }
      if (token.kind === 'punct' && token.raw === ')') {
        depth -= 1;
        if (depth === 0) break;
        continue;
      }
      if (depth !== 1) continue;
      if (token.kind === 'conditional') throw new Error('表定义中包含条件可执行注释');
      // 表级约束：跳过到本层下一个逗号或右括号
      if (token.kind === 'word' && ['PRIMARY', 'UNIQUE', 'KEY', 'INDEX', 'CONSTRAINT', 'FOREIGN', 'CHECK', 'FULLTEXT', 'SPATIAL'].includes(token.upper)) {
        let inner = 0;
        let guard = cursor.take();
        while (guard) {
          if (guard.kind === 'punct' && guard.raw === '(') inner += 1;
          else if (guard.kind === 'punct' && guard.raw === ')') {
            if (inner === 0) break;
            inner -= 1;
          } else if (guard.kind === 'punct' && guard.raw === ',' && inner === 0) break;
          guard = cursor.take();
        }
        continue;
      }
      const columnName = cursor.nameOf(token);
      if (columnName === null) throw new Error('列定义无法识别');
      const typeToken = cursor.take();
      if (!typeToken || typeToken.kind !== 'word') throw new Error(`列 ${columnName} 缺少类型`);
      const column = { name: columnName, type: typeToken.raw.toUpperCase() };
      // 消费该列剩余定义，同时识别不支持的生成列表达式
      let inner = 0;
      for (let next = cursor.peek(); next; next = cursor.peek()) {
        if (next.kind === 'punct' && next.raw === '(') { inner += 1; cursor.take(); continue; }
        if (next.kind === 'punct' && next.raw === ')') { if (inner === 0) break; inner -= 1; cursor.take(); continue; }
        if (next.kind === 'punct' && next.raw === ',' && inner === 0) break;
        if (next.kind === 'conditional') throw new Error('列定义中包含条件可执行注释');
        if (next.kind === 'word' && (next.upper === 'AS' || next.upper === 'GENERATED')) {
          throw new Error(`列 ${columnName} 使用生成列表达式，不支持解释`);
        }
        cursor.take();
      }
      columns.push(column);
      if (cursor.isPunct(',')) cursor.takePunct(',');
    }
    // 右括号之后的表选项（ENGINE、DEFAULT CHARSET 等）仅允许普通记号；条件注释仍隔离
    while (!cursor.atEnd) {
      const token = cursor.take();
      if (token.kind === 'conditional') throw new Error('表选项中包含条件可执行注释');
    }
    if (columns.length === 0) throw new Error('CREATE TABLE 没有可识别的列');

    const key = qualifiedName(database, table);
    const record = obtainTable(key, { database, table });
    newGeneration(record, table, database, columns, statement);
    definitionStatementCount += 1;
  }

  function parseDropTable(statement, cursor) {
    if (!cursor.takeWord('TABLE')) throw new Error('DROP 目标仅支持 TABLE');
    cursor.takeWord('IF'); cursor.takeWord('EXISTS');
    let database = session.database;
    let table = cursor.takeName();
    if (table === null) throw new Error('DROP TABLE 缺少表名');
    if (cursor.takePunct('.')) { database = table; table = cursor.takeName(); }
    if (cursor.takePunct(',')) throw new Error('一条 DROP TABLE 仅支持单表');
    if (!cursor.atEnd) throw new Error('DROP TABLE 尾部存在无法解释的记号');
    const key = tableKeyFor(statement, database, table);
    if (key === null) return;
    const record = tableMap.get(key);
    if (!record || record.generations.length === 0) {
      quarantineStatement(statement, 'unknown-table', `DROP 指向未在本脚本中建立的表 ${qualifiedName(database ?? session.database, table)}`);
      return;
    }
    record.generations.at(-1).droppedAt = positionOf(statement);
  }

  function literalValue(statement, token) {
    if (token.kind === 'word' && token.upper === 'NULL') return { ok: true, value: null };
    if (token.kind === 'word' && token.upper === 'TRUE') return { ok: true, value: 1 };
    if (token.kind === 'word' && token.upper === 'FALSE') return { ok: true, value: 0 };
    if (token.kind === 'word' && token.upper === 'DEFAULT') {
      return { ok: false, reason: 'DEFAULT 表达式需要求值，不在只读支持子集内', token };
    }
    if (token.kind === 'word') {
      return { ok: false, reason: `函数/关键字表达式 ${token.raw} 不支持解释`, token };
    }
    if (token.kind === 'string') {
      const decoded = decodeStringLiteral(token.inner, token.quote, session.flags, session.charset);
      if (decoded.unsupportedCharset) {
        return { ok: false, reason: '字符串依赖未识别的会话字符集，无法可靠还原', token };
      }
      return { ok: true, value: decoded.value };
    }
    if (token.kind === 'hex') {
      const buffer = decodeHexLiteral(token.value);
      if (buffer === null) return { ok: false, reason: "X'hex' 字面量内容非法", token };
      return { ok: true, value: binaryEnvelope(buffer) };
    }
    if (token.kind === 'number') {
      if (!isDecimalText(token.raw)) return { ok: false, reason: `数值字面量 ${token.raw} 不是十进制文本`, token };
      const asNumber = Number(token.raw);
      return { ok: true, value: Number.isSafeInteger(asNumber) || !Number.isInteger(asNumber) ? asNumber : token.raw };
    }
    if (token.kind === 'punct' && token.raw === '-') {
      return { ok: false, reason: '带符号/运算表达式不支持解释（请使用完整十进制文本字面量）', token };
    }
    return { ok: false, reason: `记号 ${token.kind} 不支持作为列值`, token };
  }

  function parseTuple(statement, cursor, target, rowEvidence) {
    if (!cursor.takePunct('(')) throw new Error('VALUES 元组缺少左括号');
    const values = [];
    let first = true;
    while (!cursor.isPunct(')')) {
      if (!first) {
        if (!cursor.takePunct(',')) throw new Error('元组缺少逗号');
      }
      first = false;
      const token = cursor.take();
      if (token === null) throw new Error('VALUES 元组被截断');
      const literal = literalValue(statement, token);
      if (!literal.ok) {
        const located = tokenByte(statement, token);
        throw Object.assign(new Error(literal.reason), { offset: located?.offset ?? null });
      }
      values.push(literal.value);
    }
    cursor.takePunct(')');
    if (values.length !== target.columns.length) {
      throw new Error(`值个数 ${values.length} 与表代际列数 ${target.columns.length} 不一致`);
    }
    const row = {};
    target.columns.forEach((column, index) => { row[column.name] = values[index]; });
    return { row, values, evidence: rowEvidence };
  }

  function parseInsert(statement, cursor) {
    cursor.takeWord('INTO');
    let database = session.database;
    let table = cursor.takeName();
    if (table === null) throw new Error('INSERT 缺少表名');
    if (cursor.takePunct('.')) { database = table; table = cursor.takeName(); }
    const key = tableKeyFor(statement, database, table);
    if (key === null) return;
    const record = tableMap.get(key);
    if (!record || record.generations.length === 0) {
      quarantineStatement(statement, 'unknown-table', `INSERT 指向未在本脚本中建立表定义的 ${key}`);
      return;
    }
    const target = record.generations.at(-1);

    let namedColumns = null;
    if (cursor.takePunct('(')) {
      namedColumns = [];
      while (!cursor.isPunct(')')) {
        const name = cursor.takeName();
        if (name === null) throw new Error('列清单无法识别');
        namedColumns.push(name);
        if (!cursor.takePunct(',')) break;
      }
      if (!cursor.takePunct(')')) throw new Error('列清单缺少右括号');
      for (const name of namedColumns) {
        if (!target.columns.some(column => column.name === name)) {
          throw new Error(`列 ${name} 不属于当前表代际（表重建后不能沿用旧布局）`);
        }
      }
    }

    if (!cursor.takeWord('VALUES') && !cursor.takeWord('VALUE')) throw new Error('仅支持 INSERT ... VALUES 形态');
    const rows = [];
    for (;;) {
      const rowEvidence = { ...positionOf(statement), tupleIndex: rows.length };
      const parsed = parseTuple(statement, cursor, target, rowEvidence);
      if (namedColumns) {
        const mapped = Object.fromEntries(target.columns.map(column => [column.name, null]));
        namedColumns.forEach((name, index) => { mapped[name] = parsed.values[index]; });
        parsed.row = mapped;
      }
      rows.push(parsed);
      if (!cursor.takePunct(',')) break;
    }
    if (cursor.takeWord('ON') && cursor.takeWord('DUPLICATE') && cursor.takeWord('KEY') && cursor.takeWord('UPDATE')) {
      throw new Error('ON DUPLICATE KEY UPDATE 需要执行语义，不支持解释');
    }
    if (!cursor.atEnd) throw new Error('INSERT 尾部存在无法解释的记号');

    dataStatementCount += 1;
    const provenance = {
      statementIndex: statement.index,
      position: positionOf(statement),
      charset: session.charset,
      sqlMode: { ...session.flags },
      columnLayout: target.columns.map(column => column.name),
      namedColumns,
      tableGeneration: target.generation,
    };
    const accepted = rows.map(item => ({ ...provenance, row: item.row, evidence: item.evidence }));
    if (transaction === null) {
      batchSeq += 1;
      target.batches.push({
        batchId: batchSeq,
        autocommit: true,
        begin: null,
        commit: positionOf(statement),
        statements: [statement.index],
      });
      target.acceptedRows.push(...accepted);
    } else {
      transaction.statements.push(statement.index);
      if (!transaction.touched.includes(key)) transaction.touched.push(key);
      target.pendingRows.push(accepted);
    }
  }

  function flushImplicitCommit(statement) {
    // 没有活动事务时，DDL 本身就是普通自动提交语句，不需要额外动作。
    if (transaction === null) return;
    commitTransaction({ kind: 'implicit', position: positionOf(statement) });
  }

  function commitTransaction(commitEvidence) {
    const open = transaction;
    transaction = null;
    batchSeq += 1;
    for (const key of open.touched) {
      const record = tableMap.get(key);
      const target = record.generations.at(-1);
      const groups = target.pendingRows.splice(0, target.pendingRows.length);
      target.batches.push({
        batchId: batchSeq,
        autocommit: false,
        begin: open.begin,
        commit: commitEvidence.position,
        commitKind: commitEvidence.kind,
        statements: [...new Set(groups.flatMap(group => group.map(row => row.statementIndex)))],
      });
      target.acceptedRows.push(...groups.flat());
    }
  }

  function rollbackTransaction(statement) {
    if (transaction === null) {
      quarantineStatement(statement, 'transaction-error', 'ROLLBACK 没有对应的活动事务');
      return;
    }
    const open = transaction;
    transaction = null;
    for (const key of open.touched) {
      const target = tableMap.get(key).generations.at(-1);
      const groups = target.pendingRows.splice(0, target.pendingRows.length);
      const rows = groups.flat();
      incomplete.push({
        kind: 'rolled-back',
        batch: { begin: open.begin, rollback: positionOf(statement), statements: open.statements },
        table: key,
        statementIndices: [...new Set(rows.map(row => row.statementIndex))],
        rowCount: rows.length,
      });
    }
  }

  // ---------- 主循环：逐语句按当时会话设置解释 ----------

  for (const statement of statements) {
    if (statement.text.trim() === '') continue;
    // 扫描层已对未终止语句（截断/未闭合引号）留痕，解析器不再二次诊断或产生半截登记。
    if (!statement.terminated) continue;
    let tokens;
    try {
      tokens = tokenize(statement.raw, session.flags);
    } catch (error) {
      quarantineStatement(statement, 'tokenizer-error', error.message);
      continue;
    }
    if (tokens.some(token => token.kind === 'malformed')) {
      const malformed = tokens.find(token => token.kind === 'malformed');
      quarantineStatement(statement, 'malformed-syntax', malformed.reason);
      continue;
    }
    // DELIMITER 指令行已在扫描层作为事件留痕，这里不再产生重复的语句级隔离。
    if (/^\s*DELIMITER(?:\s|$)/i.test(statement.text)) continue;
    if (tokens.length === 0) continue;
    if (tokens.some(token => token.kind === 'conditional')) {
      quarantineStatement(statement, 'conditional-executable', '语句包含 MySQL 条件可执行注释或优化器提示，不能作为普通空白吞掉');
      continue;
    }
    const cursor = new Cursor(tokens);
    const first = cursor.take();
    const verb = first.kind === 'word' ? first.upper : null;

    try {
      switch (verb) {
        case 'SET': parseSet(statement, cursor); break;
        case 'USE': parseUse(statement, cursor); break;
        case 'CREATE':
        case 'DROP': {
          flushImplicitCommit(statement);
          if (verb === 'CREATE') {
            // CREATE PROCEDURE/FUNCTION/TRIGGER/EVENT/VIEW 等是存储程序或执行型对象，
            // 即便被分隔符切碎，也按存储程序隔离而不是报“目标仅支持 TABLE”。
            const target = cursor.peek();
            if (target && target.kind === 'word' && target.upper !== 'TABLE' && target.upper !== 'TEMPORARY') {
              quarantineStatement(statement, 'stored-program',
                `CREATE ${target.upper} 属于存储程序/视图等执行型对象，只读接收不解释不运行`,
                { verb: target.upper });
              break;
            }
            if (target && target.kind === 'word' && target.upper === 'TEMPORARY') {
              quarantineStatement(statement, 'unsupported-statement', 'CREATE TEMPORARY TABLE 不在只读支持子集内', { verb: 'TEMPORARY' });
              break;
            }
            parseCreateTable(statement, cursor);
          } else {
            parseDropTable(statement, cursor);
          }
          break;
        }
        case 'INSERT': parseInsert(statement, cursor); break;
        case 'BEGIN': {
          if (transaction !== null) throw new Error('BEGIN 嵌套：前一事务尚未 COMMIT/ROLLBACK');
          cursor.takeWord('WORK');
          if (!cursor.atEnd) throw new Error('BEGIN 形态不支持');
          batchSeq += 1;
          transaction = { batchId: batchSeq, begin: positionOf(statement), statements: [], touched: [] };
          break;
        }
        case 'START': {
          if (!cursor.takeWord('TRANSACTION')) throw new Error('仅支持 START TRANSACTION 事务开始');
          if (transaction !== null) throw new Error('事务嵌套：前一事务尚未结束');
          batchSeq += 1;
          transaction = { batchId: batchSeq, begin: positionOf(statement), statements: [], touched: [] };
          break;
        }
        case 'COMMIT': {
          // MySQL 中无活动事务时 COMMIT 是空操作（autocommit 已各自落账），不构成隔离项。
          if (transaction === null) break;
          if (!cursor.atEnd) throw new Error('COMMIT 形态不支持');
          commitTransaction({ kind: 'commit', position: positionOf(statement) });
          break;
        }
        case 'ROLLBACK': {
          cursor.takeWord('WORK');
          rollbackTransaction(statement, cursor);
          break;
        }
        default: {
          // 由非分号分隔符切出的语句是存储程序主体；DELIMITER 行本身是客户端指令。
          if (statement.delimiter !== ';') {
            quarantineStatement(statement, 'stored-program',
              '该语句由 DELIMITER 指令切分，属于存储程序/触发器主体，只读接收不解释不运行',
              { verb, delimiter: statement.delimiter });
            break;
          }
          if (!SUPPORTED_TOP_LEVEL.has(verb)) {
            quarantineStatement(statement, verb === null ? 'unparseable-statement' : 'unsupported-statement',
              verb === null ? '语句无法解析为受支持的 SQL 动词' : `${verb} 属于执行型语句或存储程序，只读接收不解释不运行`,
              { verb });
          } else {
            throw new Error(`动词 ${verb} 的该形态不在支持子集内`);
          }
        }
      }
    } catch (error) {
      quarantineStatement(statement, 'unsupported-expression', error.message, { verb, byteOffset: error.offset ?? null });
    }
  }

  // ---------- EOF：未提交/截断事务不得作为完整登记 ----------
  if (transaction !== null) {
    const open = transaction;
    for (const key of open.touched) {
      const record = tableMap.get(key);
      for (const generation of record.generations) {
        const groups = generation.pendingRows.splice(0, generation.pendingRows.length);
        const rows = groups.flat();
        if (rows.length === 0) continue;
        incomplete.push({
          kind: 'uncommitted-transaction',
          batch: { batchId: open.batchId, begin: open.begin, commit: null, statements: open.statements },
          table: key,
          statementIndices: [...new Set(rows.map(row => row.statementIndex))],
          rowCount: rows.length,
          pendingRows: rows,
        });
      }
    }
  }

  // ---------- 扫描事件落隔离区 ----------
  for (const event of events) {
    const map = {
      'conditional-comment': ['conditional-executable', '条件可执行注释不能作为普通空白吞掉'],
      'delimiter-directive': ['client-directive', 'DELIMITER 是客户端指令：后续由其分隔的存储程序主体不解释不运行'],
      'malformed-delimiter': ['malformed-syntax', 'DELIMITER 指令形态非法'],
      'truncated-statement': ['truncated-statement', '脚本在语句结束前被截断，该语句不具完整登记效力'],
      'unterminated-string': ['truncated-statement', '字符串字面量未闭合，脚本疑似中途截断'],
      'unclosed-comment': ['truncated-statement', '块注释未闭合，脚本疑似中途截断'],
    };
    const [type, reason] = map[event.kind] || ['scanner-event', event.kind];
    quarantine.push({
      type,
      reason,
      position: {
        statementIndex: null,
        startByte: event.start,
        endByte: event.end,
        startLine: event.line,
        endLine: event.line,
        ...(event.from ? { delimiter: { from: event.from, to: event.to } } : {}),
      },
      preview: raw.subarray(event.start, Math.min(event.end, event.start + 200)).toString('utf8'),
    });
  }

  // ---------- 汇总表代际 ----------
  const tables = tableOrder.map(key => {
    const record = tableMap.get(key);
    return {
      database: record.database,
      table: record.table,
      generations: record.generations.map(generation => ({
        database: generation.database,
        table: generation.table,
        generation: generation.generation,
        columns: generation.columns,
        definition: generation.definition,
        droppedAt: generation.droppedAt,
        status: generation.acceptedRows.length > 0 ? 'accepted'
          : incomplete.some(item => item.table === key && item.pendingRows?.some(row => row.tableGeneration === generation.generation)) ? 'incomplete'
          : 'definition-only',
        rowCount: generation.acceptedRows.length,
        batches: generation.batches,
        rows: generation.acceptedRows,
      })),
    };
  });

  const acceptedGenerations = tables.flatMap(table => table.generations.filter(generation => generation.status === 'accepted'));
  const unusable = definitionStatementCount === 0 && dataStatementCount === 0;
  const deliveryStatus = unusable ? 'unusable'
    : quarantine.length > 0 || incomplete.length > 0 ? 'partial'
    : 'complete';

  return {
    format: 'sql-delivery-manifest/v1',
    sourceFile,
    byteLength: raw.length,
    statementCount: statements.length,
    deliveryStatus,
    session: {
      charset: session.charset,
      sqlMode: { ...session.flags },
      database: session.database,
      trace: sessionTrace,
    },
    tables,
    accepted: {
      tableCount: new Set(acceptedGenerations.map(generation => qualifiedName(generation.database, generation.table))).size,
      generationCount: acceptedGenerations.length,
      rowCount: acceptedGenerations.reduce((sum, generation) => sum + generation.rowCount, 0),
    },
    incomplete,
    quarantine,
  };
}
