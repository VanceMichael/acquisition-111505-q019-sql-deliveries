import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const intake = await createIntake(directory); const provider = createProvider();
try {
  intake.listen(0, '127.0.0.1'); provider.listen(0, '127.0.0.1');
  await Promise.all([once(intake, 'listening'), once(provider, 'listening')]);
  const base = `http://127.0.0.1:${intake.address().port}`;
  const source = `http://127.0.0.1:${provider.address().port}`;
  const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));
  const project = JSON.parse(await readFile(new URL('../fixtures/project.json', import.meta.url), 'utf8'));
  const observed = await fetch(source + project.probe, project.probeBody ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(project.probeBody) } : {}); const raw = Buffer.from(await observed.arrayBuffer());
  console.log(JSON.stringify({ 来源状态: observed.status, 原始字节: raw.length, 来源类型: observed.headers.get('content-type') }));
  const accepted = await fetch(base + '/api/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample) });
  console.log(JSON.stringify({ 人工收件: await accepted.json() }));

  // 只读 SQL 交付：完整备份、含存储程序的备份、截断备份各自独立呈现结论
  const supported = await readFile(new URL('../fixtures/source.sql', import.meta.url));
  const full = await fetch(base + '/api/deliveries/sql?sourceFile=source.sql', { method: 'POST', headers: { 'content-type': 'application/sql' }, body: supported });
  const fullBody = await full.json();
  console.log(JSON.stringify({ 只读交付: fullBody.deliveryStatus, HTTP: full.status, 确认表代际: fullBody.accepted.generationCount, 登记行数: fullBody.accepted.rowCount, 隔离项: fullBody.quarantineCount }));

  const unsupported = await readFile(new URL('../fixtures/unsupported.sql', import.meta.url));
  const partial = await fetch(base + '/api/deliveries/sql?sourceFile=unsupported.sql', { method: 'POST', headers: { 'content-type': 'application/sql' }, body: unsupported });
  const partialBody = await partial.json();
  console.log(JSON.stringify({ 含不支持项: partialBody.deliveryStatus, HTTP: partial.status, 已保留登记: partialBody.accepted.rowCount, 隔离类型: partialBody.detail.quarantine.map(item => item.type) }));

  const truncated = supported.subarray(0, supported.lastIndexOf(Buffer.from('COMMIT;')));
  const cut = await fetch(base + '/api/deliveries/sql?sourceFile=truncated.sql', { method: 'POST', headers: { 'content-type': 'application/sql' }, body: truncated });
  const cutBody = await cut.json();
  console.log(JSON.stringify({ 中途截断: cutBody.deliveryStatus, HTTP: cut.status, 完整登记: cutBody.accepted.rowCount, 未完成事务: cutBody.incompleteCount }));

  const pending = await fetch(base + '/api/collect', { method: 'POST' });
  console.log(JSON.stringify({ 自动接入状态: pending.status, 说明: await pending.json() }));
  console.log(JSON.stringify({ 已存记录: await (await fetch(base + '/api/records')).json() }));
} finally { intake.closeAllConnections(); provider.closeAllConnections(); await Promise.all([new Promise(resolve => intake.close(resolve)), new Promise(resolve => provider.close(resolve))]); await rm(directory, { recursive: true, force: true }); }
