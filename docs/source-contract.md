# 合作来源约定

## 资料边界

支持交付子集 SET SQL_MODE、SET NAMES、CREATE TABLE、DROP TABLE、INSERT INTO VALUES、BEGIN/COMMIT/ROLLBACK、USE；标识符支持反引号，字符串遵循 NO_BACKSLASH_ESCAPES，值支持 NULL、十进制文本和 X'hex'。不解释任意函数、触发器、存储程序或外部文件指令。事务边界及表代际影响可见收件集合；comments 中的可执行扩展语句不能作为普通空白吞掉。fixtures/source.sql 为本地合成登记数据。

## 本地服务

来源和收件端是两个独立 HTTP 监听器。来源 `/health` 报告运行状态，`/__state` 返回当前情景；仅本地使用的 `POST /__control` 可改变来源情景，不属于收件端的业务 API。具体情景字段在 `provider/scenario.mjs` 的 `initialState` 中定义，切换只影响后续来源响应，不会改写已有收件。探查入口为 `/exports`，请求相对链接必须以实际来源地址解释。

## 已有归档约定

人工入口只接收人工确认过的结构化对象，并不验证自动来源完整性。`Archive.accept(source, identity, data, raw)` 把原始字节按摘要保存，并为同一来源与身份保留不同版本。`source` 和 `identity` 的选择必须与业务对象对应，正文摘要只用于原文复用，不代表两份业务记录相同。`src/transport.mjs` 仅提供一次请求，不包含自动分页、协议解释或领域恢复策略。
