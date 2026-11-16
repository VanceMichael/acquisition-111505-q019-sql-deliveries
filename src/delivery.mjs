// 只读 SQL 交付收件：解析合作方备份，确认过的表代际按业务身份入档，
// 原始字节与完整清单（含隔离区、未完成事务）一并保留。全程不执行备份中的任何语句。
import { parseDelivery } from './sql/parser.mjs';
import { digest } from './archive.mjs';

const DELIVERY_SOURCE = 'sql-delivery';
const MANIFEST_SOURCE = 'sql-delivery-manifest';

export function explainDelivery(raw, options = {}) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  return parseDelivery(bytes, options);
}

export async function receiveDelivery(archive, raw, options = {}) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const sourceFile = options.sourceFile || 'delivery.sql';
  const manifest = explainDelivery(bytes, { sourceFile });
  const rawSha256 = digest(bytes);

  // 每个被确认的表代际独立留据。身份在 database/table/generation 之外加入 delivery 维度：
  // 不同备份文件是不同交付批次，不能互相覆盖版本；同一文件重复提交则由摘要+正文去重。
  const tableReceipts = [];
  for (const table of manifest.tables) {
    for (const generation of table.generations) {
      if (generation.status !== 'accepted') continue;
      const businessIdentity = { database: table.database, table: table.table, generation: generation.generation };
      const identity = { ...businessIdentity, delivery: sourceFile };
      const data = {
        source: DELIVERY_SOURCE,
        sourceFile,
        rawSha256,
        deliveryStatus: manifest.deliveryStatus,
        identity: businessIdentity,
        columns: generation.columns,
        definition: generation.definition,
        batches: generation.batches,
        rows: generation.rows,
      };
      const receipt = await archive.accept(DELIVERY_SOURCE, identity, data, bytes);
      tableReceipts.push({ identity: businessIdentity, delivery: sourceFile, ...receipt });
    }
  }

  // 清单留据：隔离项与未完成事务的依据随交付整体保存，不被“部分成功”吞没。
  const manifestIdentity = { database: manifest.session.database || '__unknown__', table: sourceFile, generation: 1 };
  const manifestReceipt = await archive.accept(MANIFEST_SOURCE, manifestIdentity, manifest, bytes);

  return {
    source: DELIVERY_SOURCE,
    sourceFile,
    rawSha256,
    deliveryStatus: manifest.deliveryStatus,
    accepted: manifest.accepted,
    incompleteCount: manifest.incomplete.length,
    quarantineCount: manifest.quarantine.length,
    manifest: { identity: manifestIdentity, ...manifestReceipt },
    tableReceipts,
    detail: manifest,
  };
}
