import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createProvider } from '../provider/server.mjs';
async function withSource(context) {
  const service = createProvider(); service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const control = value => fetch(base + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const post = (path, value) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { base, control, post };
}

test('数据原文具有模式切换和表代际变化', async context => {
  const { base } = await withSource(context); const sql = await (await fetch(base + '/exports/source.sql')).text();
  assert.match(sql, /NO_BACKSLASH_ESCAPES/); assert.match(sql, /DROP TABLE/); assert.match(sql, /X'00ff'/); assert.equal((sql.match(/CREATE TABLE/g) || []).length, 2);
});
test('截断事务和不支持执行语句以原文保留', async context => {
  const { base, control } = await withSource(context); await control({ truncated: true });
  let sql = await (await fetch(base + '/exports/source.sql')).text(); assert.match(sql, /INSERT INTO `register` VALUES \('重新建表'/); assert.doesNotMatch(sql.trim().split('\n').at(-1), /COMMIT/);
  await control({ truncated: false, unsupported: true }); sql = await (await fetch(base + '/exports/source.sql')).text(); assert.match(sql, /CREATE PROCEDURE/);
});
