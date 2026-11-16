import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { receiveDelivery } from '../src/delivery.mjs';
import { Archive } from '../src/archive.mjs';

async function withService(context) {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-http-'));
  const service = await createIntake(directory);
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  context.after(async () => {
    service.closeAllConnections();
    await new Promise(resolve => service.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${service.address().port}`, directory };
}

test('完整 SQL 交付返回 201，原始字节与表代际分别入档', async context => {
  const { base, directory } = await withService(context);
  const sql = await readFile(new URL('../fixtures/source.sql', import.meta.url));
  const response = await fetch(base + '/api/deliveries/sql?sourceFile=source.sql', {
    method: 'POST',
    headers: { 'content-type': 'application/sql' },
    body: sql,
  });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.deliveryStatus, 'complete');
  assert.equal(result.accepted.generationCount, 2);
  assert.equal(result.accepted.rowCount, 4);
  assert.equal(result.tableReceipts.length, 2);

  const archive = await new Archive(directory).initialize();
  const records = await archive.list();
  const sources = [...new Set(records.map(record => record.source))].sort();
  assert.deepEqual(sources, ['sql-delivery', 'sql-delivery-manifest']);
  // 原始字节按摘要可完整取回
  const original = await archive.bytes(result.rawSha256);
  assert.equal(original.toString('utf8'), sql.toString('utf8'));
  // 表代际身份仍是 database/table/generation
  assert.deepEqual(result.tableReceipts[0].identity, { database: 'museum', table: 'register', generation: 1 });
  assert.deepEqual(result.tableReceipts[1].identity, { database: 'museum', table: 'register', generation: 2 });
});

test('含隔离项的交付返回 202 而非宣称整份成功，已确认材料不丢', async context => {
  const { base } = await withService(context);
  const sql = await readFile(new URL('../fixtures/unsupported.sql', import.meta.url));
  const response = await fetch(base + '/api/deliveries/sql', { method: 'POST', headers: { 'content-type': 'application/sql' }, body: sql });
  assert.equal(response.status, 202);
  const result = await response.json();
  assert.equal(result.deliveryStatus, 'partial');
  assert.equal(result.quarantineCount, 2);
  assert.equal(result.accepted.rowCount, 4);
  assert.ok(result.detail.quarantine.some(item => item.type === 'stored-program'));
});

test('无可用材料的交付返回 422', async context => {
  const { base } = await withService(context);
  const response = await fetch(base + '/api/deliveries/sql', {
    method: 'POST',
    headers: { 'content-type': 'application/sql' },
    body: 'SELECT 1;',
  });
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.deliveryStatus, 'unusable');
});

test('空交付与超大交付被拒绝', async context => {
  const { base } = await withService(context);
  const empty = await fetch(base + '/api/deliveries/sql', { method: 'POST', body: '' });
  assert.equal(empty.status, 400);
  const huge = await fetch(base + '/api/deliveries/sql', {
    method: 'POST',
    body: Buffer.alloc(16777216 + 1, 0x61),
  });
  assert.equal(huge.status, 413);
});

test('同一交付重复提交复用版本，内容变化保留新版本', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-version-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const archive = await new Archive(directory).initialize();
  const sql = await readFile(new URL('../fixtures/source.sql', import.meta.url));
  const first = await receiveDelivery(archive, sql, { sourceFile: 'source.sql' });
  const second = await receiveDelivery(archive, sql, { sourceFile: 'source.sql' });
  assert.equal(first.manifest.version, 1);
  assert.equal(second.manifest.duplicate, true);
  const changed = await receiveDelivery(archive, Buffer.concat([sql, Buffer.from('\n-- 新增备注\n')]), { sourceFile: 'source.sql' });
  assert.equal(changed.manifest.version, 2);
  assert.equal(changed.manifest.duplicate, false);
});

test('SQL 交付与人工收件来源隔离，不互相混淆', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-separate-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const archive = await new Archive(directory).initialize();
  const { receiveManual } = await import('../src/intake.mjs');
  await receiveManual(archive, { database: 'museum', table: 'register', generation: 1, row: { id: 99 } });
  await receiveDelivery(archive, await readFile(new URL('../fixtures/source.sql', import.meta.url)), { sourceFile: 'source.sql' });
  const records = await archive.list();
  const manual = records.filter(record => record.source === 'manual');
  const sqlDelivery = records.filter(record => record.source === 'sql-delivery');
  assert.equal(manual.length, 1);
  assert.equal(sqlDelivery.length, 2);
  assert.equal(manual[0].versions[0].data.row.id, 99);
  assert.equal(sqlDelivery[0].versions[0].data.source, 'sql-delivery');
});
