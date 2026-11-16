import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Archive } from './archive.mjs';
import { receiveManual } from './intake.mjs';
import { receiveDelivery } from './delivery.mjs';

export async function createIntake(directory) {
  const archive = await new Archive(directory).initialize();
  return createServer(async (incoming, outgoing) => {
    const reply = (status, body) => { outgoing.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); outgoing.end(JSON.stringify(body)); };
    const requestUrl = new URL(incoming.url, 'http://localhost');
    try {
      if (incoming.method === 'GET' && requestUrl.pathname === '/health') return reply(200, { status: 'ok', acquisition: 'manual' });
      if (incoming.method === 'GET' && requestUrl.pathname === '/api/records') return reply(200, await archive.list());
      if (incoming.method === 'POST' && requestUrl.pathname === '/api/collect') return reply(501, { error: '当前仅支持人工收件，尚无自动来源接入' });
      if (incoming.method === 'POST' && requestUrl.pathname === '/api/deliveries/sql') {
        const chunks = []; let length = 0;
        for await (const chunk of incoming) { length += chunk.length; if (length > 16777216) return reply(413, { error: '单份 SQL 交付过大' }); chunks.push(chunk); }
        const bytes = Buffer.concat(chunks);
        if (bytes.length === 0) return reply(400, { error: '交付内容为空' });
        const sourceFile = requestUrl.searchParams.get('sourceFile') || 'delivery.sql';
        try {
          const result = await receiveDelivery(archive, bytes, { sourceFile });
          // 完整接受 201；存在隔离项或未完成事务时 202，已确认材料仍正常入档；完全无可用材料 422。
          const status = result.deliveryStatus === 'unusable' ? 422 : result.deliveryStatus === 'complete' ? 201 : 202;
          return reply(status, result);
        } catch (error) { return reply(422, { error: error.message }); }
      }
      if (incoming.method === 'POST' && requestUrl.pathname === '/api/manual') {
        const chunks = []; let length = 0;
        for await (const chunk of incoming) { length += chunk.length; if (length > 1048576) return reply(413, { error: '单份人工收件过大' }); chunks.push(chunk); }
        let payload; try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400, { error: 'JSON 无效' }); }
        try { return reply(201, await receiveManual(archive, payload)); } catch (error) { return reply(422, { error: error.message }); }
      }
      return reply(404, { error: '路径不存在' });
    } catch (error) { return reply(500, { error: error.message }); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = await createIntake(process.env.ARCHIVE_DIR || '.local/archive');
  service.listen(Number(process.env.PORT || 3200), '0.0.0.0', () => console.log('收件服务已就绪'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => service.close(() => process.exit(0)));
}
