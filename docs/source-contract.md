# 合作来源约定

## 资料边界

支持交付子集 SET SQL_MODE、SET NAMES、CREATE TABLE、DROP TABLE、INSERT INTO VALUES、BEGIN/COMMIT/ROLLBACK、USE；标识符支持反引号，字符串遵循 NO_BACKSLASH_ESCAPES，值支持 NULL、十进制文本和 X'hex'。不解释任意函数、触发器、存储程序或外部文件指令。事务边界及表代际影响可见收件集合；comments 中的可执行扩展语句不能作为普通空白吞掉。fixtures/source.sql 为本地合成登记数据。

## 只读接收的落实

`src/sql/` 与 `src/delivery.mjs` 对上述子集做只读解释，不执行任何语句。解释严格以语句生效当时的会话状态为准：转义模式、字符集、当前数据库和表代际都会随 SET/USE/CREATE/DROP 推进，事后改动不回溯影响已解释的行。表被 DROP 再 CREATE 后产生新代际，列布局独立解析；省略列名的 INSERT 按当代际列顺序位置映射，带列名的按名映射，引用当代际不存在的列即隔离整条语句。只有 COMMIT 闭合的事务成为登记行；ROLLBACK、EOF 未提交和语句中途截断进入未完成区并保留待决行与位置证据。存储程序、DELIMITER 主体、条件注释、执行型语句及不支持表达式进入隔离区，带语句序号、字节范围、行号和原文预览；隔离是逐语句的，不影响前后已确认材料。

## 本地服务

来源和收件端是两个独立 HTTP 监听器。来源 `/health` 报告运行状态，`/__state` 返回当前情景；仅本地使用的 `POST /__control` 可改变来源情景，不属于收件端的业务 API。具体情景字段在 `provider/scenario.mjs` 的 `initialState` 中定义，切换只影响后续来源响应，不会改写已有收件。探查入口为 `/exports`，请求相对链接必须以实际来源地址解释。

## 已有归档约定

人工入口只接收人工确认过的结构化对象，并不验证自动来源完整性。`Archive.accept(source, identity, data, raw)` 把原始字节按摘要保存，并为同一来源与身份保留不同版本。`source` 和 `identity` 的选择必须与业务对象对应，正文摘要只用于原文复用，不代表两份业务记录相同。`src/transport.mjs` 仅提供一次请求，不包含自动分页、协议解释或领域恢复策略。
