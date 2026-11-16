import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { explainDelivery } from '../src/delivery.mjs';

const fixture = name => readFile(new URL(`../fixtures/${name}`, import.meta.url));
const rowsOf = manifest => manifest.tables.flatMap(table => table.generations).flatMap(generation => generation.rows.map(item => item.row));

test('完整备份按当时会话设置与表代际解释并标记 complete', async () => {
  const manifest = explainDelivery(await fixture('source.sql'), { sourceFile: 'source.sql' });
  assert.equal(manifest.deliveryStatus, 'complete');
  assert.equal(manifest.session.charset, 'utf8mb4');
  assert.equal(manifest.session.database, 'museum');
  assert.equal(manifest.session.sqlMode.noBackslash, true);
  assert.deepEqual(manifest.accepted, { tableCount: 1, generationCount: 2, rowCount: 4 });

  const [first, second] = manifest.tables[0].generations;
  assert.deepEqual(first.columns.map(column => column.name), ['id', 'label']);
  assert.deepEqual(second.columns.map(column => column.name), ['label', 'id', 'raw']);
  assert.equal(second.droppedAt, null);
  assert.equal(first.droppedAt.statementIndex, 10);

  const rows = rowsOf(manifest);
  // 默认转义：反斜杠被解释为转义符
  assert.equal(rows[0].label, '借展\\登记');
  assert.equal(rows[1].label, null);
  // NO_BACKSLASH_ESCAPES：反斜杠是普通字符，\n 保持为两个字符
  assert.equal(rows[2].label, '原样\\n文字');
  assert.equal(rows[2].id, 3);
  // 重建表后按新布局位置映射，X'hex' 以二进制信封保留
  assert.deepEqual(rows[3], { label: '重新建表', id: 4, raw: { $type: 'binary', encoding: 'hex', data: '00ff' } });
});

test('转义模式差异改变字段含义而不是保留同样文本', () => {
  const backslash = explainDelivery(Buffer.from("USE d; CREATE TABLE t (s TEXT); INSERT INTO t VALUES ('a\\nb');"), { sourceFile: 'a.sql' });
  const plain = explainDelivery(
    Buffer.from("SET SQL_MODE='NO_BACKSLASH_ESCAPES'; USE d; CREATE TABLE t (s TEXT); INSERT INTO t VALUES ('a\\nb');"),
    { sourceFile: 'b.sql' },
  );
  assert.equal(rowsOf(backslash)[0].s, 'a\nb');
  assert.equal(rowsOf(plain)[0].s, 'a\\nb');
});

test('省略列名按语句当时的表布局位置映射，命名列按名映射', () => {
  const sql = `USE d;
CREATE TABLE t (id INTEGER, label TEXT);
INSERT INTO t VALUES (7,'位置');
INSERT INTO t (label,id) VALUES ('命名',8);`;
  const manifest = explainDelivery(Buffer.from(sql), { sourceFile: 'c.sql' });
  const rows = rowsOf(manifest);
  assert.deepEqual(rows[0], { id: 7, label: '位置' });
  assert.deepEqual(rows[1], { id: 8, label: '命名' });
});

test('表重建后同名列不沿用旧布局，代际编号独立递增', () => {
  const sql = `USE d;
CREATE TABLE t (id INTEGER, label TEXT);
INSERT INTO t VALUES (1,'旧');
DROP TABLE t;
CREATE TABLE t (label TEXT, id INTEGER, note TEXT);
INSERT INTO t VALUES ('新',2,NULL);`;
  const manifest = explainDelivery(Buffer.from(sql), { sourceFile: 'd.sql' });
  const [g1, g2] = manifest.tables[0].generations;
  assert.equal(g1.generation, 1);
  assert.equal(g2.generation, 2);
  assert.deepEqual(rowsOf(manifest), [{ id: 1, label: '旧' }, { label: '新', id: 2, note: null }]);
  // 重建前的布局不能借同名表混过新代际：新表没有 legacy 列
  const bad = explainDelivery(Buffer.from(`${sql}\nINSERT INTO t (id,legacy) VALUES (3,'x');`), { sourceFile: 'd2.sql' });
  assert.equal(bad.quarantine.some(item => item.type === 'unsupported-expression' && /不属于当前表代际/.test(item.reason)), true);
  // 旧代际已确认的行不受隔离项影响
  assert.equal(bad.accepted.rowCount, 2);
});

test('每行保留原始语句位置、事务批次与生效会话设置', async () => {
  const manifest = explainDelivery(await fixture('source.sql'), { sourceFile: 'source.sql' });
  const generation = manifest.tables[0].generations[0];
  const [row] = generation.rows;
  assert.equal(row.evidence.statementIndex, 4);
  assert.equal(row.evidence.startLine, 5);
  assert.equal(row.evidence.tupleIndex, 0);
  assert.equal(row.sqlMode.noBackslash, false);
  assert.deepEqual(row.columnLayout, ['id', 'label']);
  const batch = generation.batches[0];
  assert.equal(batch.autocommit, false);
  assert.equal(batch.begin.startLine, 4);
  assert.equal(batch.commit.startLine, 6);
  assert.deepEqual(batch.statements, [4]);
});

test('未提交与中途截断的事务不进入完整登记但保留为未完成材料', async () => {
  const full = await fixture('source.sql');
  const truncated = full.subarray(0, full.lastIndexOf(Buffer.from('COMMIT;')));
  const manifest = explainDelivery(truncated, { sourceFile: 'truncated.sql' });
  assert.equal(manifest.deliveryStatus, 'partial');
  assert.equal(manifest.accepted.rowCount, 3);
  assert.equal(manifest.tables[0].generations[1].status, 'incomplete');
  const [item] = manifest.incomplete;
  assert.equal(item.kind, 'uncommitted-transaction');
  assert.equal(item.rowCount, 1);
  assert.deepEqual(item.statementIndices, [13]);
  assert.equal(item.batch.commit, null);
  assert.equal(item.pendingRows[0].row.label, '重新建表');
});

test('语句中途截断产生 truncated 隔离项且不产生半截登记', () => {
  const sql = `USE d;
CREATE TABLE t (id INTEGER, label TEXT);
INSERT INTO t VALUES (1,'完整');
INSERT INTO t VALUES (2,'半截`;
  const manifest = explainDelivery(Buffer.from(sql), { sourceFile: 'midcut.sql' });
  assert.equal(manifest.deliveryStatus, 'partial');
  assert.deepEqual(rowsOf(manifest), [{ id: 1, label: '完整' }]);
  assert.equal(manifest.quarantine.some(item => item.type === 'truncated-statement'), true);
});

test('ROLLBACK 的行进入未完成区，不冒充登记', () => {
  const sql = `USE d;
CREATE TABLE t (id INTEGER);
BEGIN;
INSERT INTO t VALUES (1);
ROLLBACK;
INSERT INTO t VALUES (2);`;
  const manifest = explainDelivery(Buffer.from(sql), { sourceFile: 'rollback.sql' });
  assert.equal(manifest.deliveryStatus, 'partial');
  assert.deepEqual(rowsOf(manifest), [{ id: 2 }]);
  assert.equal(manifest.incomplete[0].kind, 'rolled-back');
  assert.equal(manifest.incomplete[0].rowCount, 1);
});

test('存储程序、DELIMITER 与执行型语句隔离且不运行，已确认材料保留', async () => {
  const manifest = explainDelivery(await fixture('unsupported.sql'), { sourceFile: 'unsupported.sql' });
  assert.equal(manifest.deliveryStatus, 'partial');
  assert.deepEqual(manifest.accepted, { tableCount: 1, generationCount: 2, rowCount: 4 });
  const types = manifest.quarantine.map(item => item.type).sort();
  assert.ok(types.includes('client-directive'));
  assert.ok(types.includes('stored-program'));
  const directive = manifest.quarantine.find(item => item.type === 'client-directive');
  assert.deepEqual(directive.position.delimiter, { from: ';', to: '$$' });
  const program = manifest.quarantine.find(item => item.type === 'stored-program');
  assert.match(program.preview, /CREATE PROCEDURE/);
});

test('条件可执行注释不能当作普通空白吞掉', () => {
  const sql = `USE d;
CREATE TABLE t (id INTEGER);
/*!40101 SET @secret = 1 */;
INSERT INTO t VALUES (1);`;
  const manifest = explainDelivery(Buffer.from(sql), { sourceFile: 'hint.sql' });
  assert.equal(manifest.deliveryStatus, 'partial');
  assert.equal(manifest.quarantine.some(item => item.type === 'conditional-executable'), true);
  assert.equal(manifest.accepted.rowCount, 1);
});

test('不支持表达式只隔离该语句，前后已确认行不丢失', () => {
  const sql = `USE d;
CREATE TABLE t (id INTEGER, label TEXT);
INSERT INTO t VALUES (1,'先');
INSERT INTO t VALUES (NOW(), CONCAT('a','b'));
INSERT INTO t VALUES (3,'后');`;
  const manifest = explainDelivery(Buffer.from(sql), { sourceFile: 'expr.sql' });
  assert.equal(manifest.deliveryStatus, 'partial');
  assert.deepEqual(rowsOf(manifest).map(row => row.id), [1, 3]);
  const [quarantined] = manifest.quarantine;
  assert.equal(quarantined.type, 'unsupported-expression');
  assert.equal(quarantined.position.statementIndex, 3);
});

test('值个数与表布局不符时整条 INSERT 隔离', () => {
  const sql = `USE d;
CREATE TABLE t (a INTEGER, b INTEGER);
INSERT INTO t VALUES (1,2,3);
INSERT INTO t VALUES (4,5);`;
  const manifest = explainDelivery(Buffer.from(sql), { sourceFile: 'arity.sql' });
  assert.equal(manifest.quarantine[0].type, 'unsupported-expression');
  assert.match(manifest.quarantine[0].reason, /值个数/);
  assert.deepEqual(rowsOf(manifest), [{ a: 4, b: 5 }]);
});

test('ANSI_QUOTES 下双引号是标识符而普通字符串仍按单引号解释', () => {
  const sql = `SET SQL_MODE='ANSI_QUOTES';
USE d;
CREATE TABLE t ("id" INTEGER, "label" TEXT);
INSERT INTO t VALUES (1,'文本');`;
  const manifest = explainDelivery(Buffer.from(sql), { sourceFile: 'ansi.sql' });
  assert.equal(manifest.deliveryStatus, 'complete');
  assert.deepEqual(rowsOf(manifest), [{ id: 1, label: '文本' }]);
});

test('字符集声明被记录；无法解释的声明隔离并提示人工复核', () => {
  const known = explainDelivery(Buffer.from("SET NAMES utf8mb4; USE d; CREATE TABLE t (s TEXT); INSERT INTO t VALUES ('好');"), { sourceFile: 'u1.sql' });
  assert.equal(known.session.charset, 'utf8mb4');
  assert.equal(known.session.trace.some(item => item.kind === 'charset' && item.known), true);
  const unknown = explainDelivery(Buffer.from("SET NAMES koi8r; USE d; CREATE TABLE t (s TEXT); INSERT INTO t VALUES ('x');"), { sourceFile: 'u2.sql' });
  assert.equal(unknown.quarantine.some(item => item.type === 'unsupported-charset'), true);
  assert.equal(unknown.deliveryStatus, 'partial');
});

test('没有任何可解释材料时判定 unusable', () => {
  const manifest = explainDelivery(Buffer.from('SELECT 1; DROP DATABASE d;'), { sourceFile: 'empty.sql' });
  assert.equal(manifest.deliveryStatus, 'unusable');
  assert.equal(manifest.accepted.rowCount, 0);
  assert.equal(manifest.quarantine.length, 2);
});

test('缺少数据库上下文的表与插入被隔离而不是猜测归属', () => {
  const manifest = explainDelivery(Buffer.from('CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1);'), { sourceFile: 'nodb.sql' });
  assert.equal(manifest.quarantine.some(item => item.type === 'missing-database'), true);
  assert.equal(manifest.accepted.rowCount, 0);
});

test('多字节字符的裸标识符与字符串可解释，字节位置仍然准确', () => {
  const sql = "USE 库;\nCREATE TABLE 表 (编号 INTEGER, 名称 TEXT);\nINSERT INTO 表 VALUES (1,'数据🎉');";
  const manifest = explainDelivery(Buffer.from(sql), { sourceFile: 'multibyte.sql' });
  assert.equal(manifest.deliveryStatus, 'complete');
  assert.equal(manifest.session.database, '库');
  const generation = manifest.tables[0].generations[0];
  assert.equal(manifest.tables[0].table, '表');
  assert.deepEqual(generation.columns.map(column => column.name), ['编号', '名称']);
  assert.deepEqual(rowsOf(manifest), [{ 编号: 1, 名称: '数据🎉' }]);
  assert.equal(generation.rows[0].evidence.startLine, 3);
});

test('DDL 在事务内触发隐式提交，事务内已确认行落账', () => {
  const sql = `USE d;
CREATE TABLE t (id INTEGER);
BEGIN;
INSERT INTO t VALUES (1);
CREATE TABLE t2 (id INTEGER);
INSERT INTO t2 VALUES (9);
COMMIT;`;
  const manifest = explainDelivery(Buffer.from(sql), { sourceFile: 'implicit.sql' });
  assert.equal(manifest.deliveryStatus, 'complete');
  assert.deepEqual(rowsOf(manifest), [{ id: 1 }, { id: 9 }]);
});

test('事务内重建表：隐式提交边界两侧的行分属不同代际', () => {
  const sql = `USE d;
CREATE TABLE t (id INTEGER);
BEGIN;
INSERT INTO t VALUES (1);
DROP TABLE t;
CREATE TABLE t (id INTEGER, tag TEXT);
INSERT INTO t VALUES (2,'新');
COMMIT;`;
  const manifest = explainDelivery(Buffer.from(sql), { sourceFile: 'regen.sql' });
  assert.equal(manifest.deliveryStatus, 'complete');
  const [g1, g2] = manifest.tables[0].generations;
  assert.deepEqual(g1.rows.map(item => item.row), [{ id: 1 }]);
  assert.deepEqual(g2.rows.map(item => item.row), [{ id: 2, tag: '新' }]);
  assert.equal(g1.batches[0].commitKind, 'implicit');
});

test('嵌套 BEGIN 与无表 REPLACE 被隔离，不影响已确认行', () => {
  const nested = explainDelivery(Buffer.from(`USE d;
CREATE TABLE t (id INTEGER);
BEGIN;
INSERT INTO t VALUES (1);
BEGIN;
COMMIT;`), { sourceFile: 'nested.sql' });
  assert.equal(nested.quarantine.some(item => /嵌套/.test(item.reason)), true);
  assert.equal(nested.accepted.rowCount, 1);
  const replace = explainDelivery(Buffer.from(`USE d;
CREATE TABLE t (id INTEGER);
REPLACE INTO t VALUES (1);
INSERT INTO t VALUES (2);`), { sourceFile: 'replace.sql' });
  assert.equal(replace.quarantine.some(item => item.type === 'unsupported-statement'), true);
  assert.deepEqual(rowsOf(replace), [{ id: 2 }]);
});

test('多表事务按表分别保留批次，仅建表未插数据的代际为 definition-only', () => {
  const sql = `USE shop;
CREATE TABLE customer (id INTEGER, name TEXT);
CREATE TABLE log (id INTEGER, msg TEXT);
INSERT INTO customer VALUES (1,'甲');
BEGIN;
INSERT INTO customer VALUES (2,'乙');
INSERT INTO log VALUES (10,'记录');
COMMIT;
DROP TABLE log;
CREATE TABLE log (id INTEGER, level TEXT);`;
  const manifest = explainDelivery(Buffer.from(sql), { sourceFile: 'multi.sql' });
  assert.equal(manifest.deliveryStatus, 'complete');
  const logTable = manifest.tables.find(table => table.table === 'log');
  assert.equal(logTable.generations[0].status, 'accepted');
  assert.equal(logTable.generations[1].status, 'definition-only');
  const customer = manifest.tables.find(table => table.table === 'customer');
  assert.equal(customer.generations[0].batches.length, 2);
});
