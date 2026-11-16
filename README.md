# 合作系统 SQL 交付的会话语义与事务收件

这是面向资料接收人员的 Node.js 服务。当前提供人工收件、只读 SQL 交付接收、原始字节保管、业务身份版本记录和收件查询；本地来源独立提供合作方交互环境。备份中的任何语句都不会被执行；`POST /api/collect` 仍返回 501，不会把人工或文件导入宣称为自动采集。

## 环境

支持 Node.js 22.22.1 及以上的 22.x 补丁版本；项目 Dockerfile 仍固定原有镜像摘要以保证可复现，正式 Linux 基线另外在 Node.js 22.23.4 验证。运行期没有第三方包及公网数据依赖。`npm ci --ignore-scripts --no-audit --no-fund` 安装锁定环境，`npm run build` 检查所有模块语法，`npm test` 验证归档、HTTP 入口及来源行为。来源材料均为本地合成的业务样本，没有真实账号、个人材料或访问外部站点的要求。

`npm start` 同时启动收件服务 3200 和来源 4200；可分别通过 `PORT`、`SOURCE_PORT` 修改端口。`ARCHIVE_DIR` 指定收件目录，默认 `.local/archive`。`npm run demo` 使用临时目录和系统分配端口展示来源、人工收件与只读 SQL 交付（完整、含隔离项、截断三种结论），结束即清理，通常只需数秒，当前不演示尚未提供的自动采集。

## 容器

`docker build -t sql-deliveries:local .` 构建环境，`docker run --rm -p 3200:3200 -p 4200:4200 sql-deliveries:local` 启动。环境准备后，`docker run --rm --network none sql-deliveries:local sh -c 'npm run build && npm test && npm run demo'` 可离线检查现有功能。正式展示应从干净归档启动真实新增功能并展示当前输出，完整操作限时 90 秒；准备镜像不计入运行时间。

## 接口与目录

`POST /api/manual` 接收 `fixtures/manual.json` 同形的业务对象，`GET /api/records` 查询全部人工收件版本，`GET /health` 检查进程。人工记录身份字段为 database, table, generation。同一身份与相同原文重复提交复用版本，内容变化保留旧版本；不同来源不能混淆。归档目录有按摘要保存的 blobs 和按业务身份保存的 receipts。

`POST /api/deliveries/sql`（可用 `?sourceFile=` 标注来源文件名）只读接收合作方 SQL 备份的原始字节，不启动旧数据库、不执行备份内任何语句。解析器按每条语句生效当时的会话设置解释数据：`SET NAMES` 决定字符串字符集，`SET SQL_MODE` 决定反斜杠转义（`NO_BACKSLASH_ESCAPES`）与双引号角色（`ANSI_QUOTES`），`CREATE TABLE`/`DROP TABLE` 划分表代际，省略列名的 `INSERT` 按该代际列布局位置映射，重建表后的同名列不会沿用旧布局。每行保留语句序号、字节范围、行号、元组序号、事务批次与当时会话设置；只有 `COMMIT` 完成的事务进入登记，未提交、回滚和中途截断的事务进入 `incomplete` 并保留全部待决行证据。存储程序、`DELIMITER` 指令、条件可执行注释、执行型语句和无法解释的表达式进入 `quarantine`，带位置与原文片段，绝不静默跳过。响应状态：全部可解释为 `201`；存在隔离项或未完成事务但已有确认材料为 `202`；没有任何可解释材料为 `422`。交付结论分三档 `complete`/`partial`/`unusable`，部分成功不会被宣称为整份成功。确认的表代际以 `sql-delivery` 来源、含交付文件维度的身份入档，完整清单以 `sql-delivery-manifest` 来源单独留据，与 `manual` 来源互不混淆。

`src/` 为收件与传输，`provider/` 为独立来源服务，`fixtures/` 保留来源字节与人工记录，`test/` 验证现有行为。协议范围与局部身份约定见 `docs/source-contract.md`，该文档不规定新增接入的架构。
