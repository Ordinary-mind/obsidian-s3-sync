# Obsidian S3 Sync

一个面向个人、多设备 Vault 的 S3 Compatible Storage 同步插件项目。

项目目标是：

- 使用原始字节 SHA-256 判断真实内容变化，不按 `mtime` 选择新旧。
- 使用不可变对象和提交日志，避免共享 manifest 的并发覆盖。
- 离线编辑、删除和多设备并发最多形成显式冲突，不静默丢失数据。
- 同步普通 Vault 文件，以及经用户确认的主题、社区插件包和配置快照。
- 支持手动同步、启动同步、事件同步和可关闭的远端轮询。
- 在失败、重启和状态损坏后提供可解释、可恢复的路径。

## 当前状态

**v1 协议、同步内核、Vault/ConfigTree 产品闭环与发布安全审计已实现**，但仍是不可用于真实数据的预发布版本。发布前还必须完成 Task 16 的真实对象存储和桌面生命周期验收；移动端明确不属于 v1 支持范围。

现有 `src/sync-engine.ts` 和 `src/s3-remote.ts` 是早期 legacy prototype，仍使用共享 `.s3-sync/manifest.json` 和路径直写对象。它们只可作为 Obsidian API、设置页和 UI 参考，不能作为新同步核心继续扩展。

机器可读协议、确定性多客户端模拟、Durable Outbox、Journal 安全应用、冲突处理、配置快照、仓库世代迁移和脱敏诊断均可在无网络的 Node 22 测试环境运行。legacy 同步和“本地重建远端”入口保持禁用；v1 发布/应用仅能经过不可变 Outbox、完整验证与非破坏性接入路径。

## v1 协议概览

远端使用独立仓库世代：

```text
<prefix>/.obsidian-s3-sync/v1/repositories/<repository-id>/
  format.json
  blobs/sha256/...
  config-trees/sha256/...
  changes/sha256/...
  commits/<writer-id>/...
```

- `repositoryId` 隔离同一 Prefix 下的仓库世代；新一代仓库不会复用旧本地基线。
- `format.json` 的规范 Hash 绑定本地 Locator 及每个 Tree/Chunk/Commit；descriptor 或 configDir 被替换时停止仓库，不重解释旧提交。
- Blob、ConfigTree、Change Chunk 和 Commit 都是不可变对象。
- Commit 最后发布，是一次远端变更可见的唯一边界。
- Vault 文件按路径维护多版本头；不同内容并发时保留所有版本。
- 配置作为完整 ConfigTree 版本同步，不把并发快照按文件静默拼接。
- S3 控制台中的物理布局不是可直接编辑的 Vault 镜像。

## 本地安全模型

同步核心严格区分：

- `observedHeads`：已从远端验证到的头。
- `projectedHeads`：当前本地字节实际代表的远端头。
- `basisHeads`：本地第一次可观察编辑时从 projectedHeads 固定的父版本。

发布前拉到的新远端头不会替换已经固定的 basisHeads。Outbox 冻结后的后续编辑只继承同路径前一冻结本地版本，不吸收期间拉到的远端头。待发布内容会先进入本地不可变暂存，Outbox 保存可逐字节重放的 Commit；发布确认后还会重新核对本地 Hash/ConfigTree，不能只凭事件 generation 清理 dirty。远端内容只有在当前本地值仍等于已持久化 projection 时才能破坏性落盘；安装后、projection 记账前还会再次校验后像、dirty/generation 和远端头，并始终保留恢复字节与 ApplyJournal。

本地缺失还会区分确认删除、读取失败、扫描未完成和退出同步范围；只有确认删除才能发布墓碑。

v1 不自动删除本地恢复文件。即使外部进程在文件移入恢复区后继续通过旧句柄写入，新 Hash/size 也会作为 post-capture edit 保留并提示；清理必须由用户查看当前恢复记录后显式执行。

大小写别名以及 `foo` 文件与 `foo/bar.md` 这类文件/目录碰撞会作为显式结构冲突保留，任何平台都不会静默选择其中一边。当前和历史配置目录、本插件状态与恢复数据始终排除，避免配置目录切换后泄露旧凭证。

## 配置与插件

配置路径相对于 Obsidian 实际的 `vault.configDir` 处理，不硬编码 `.obsidian`。

同一 repositoryId 的所有设备必须使用相同的规范 `configDir` 和历史配置目录排除集合，这些值写入不可变 `format.json`。目录不一致、出现 descriptor 未记录的本机历史目录或运行中改变时停止原仓库同步，并通过携带历史并集的新 repositoryId 非破坏性迁移，避免任何设备把旧配置目录和凭证当普通 Vault 文件。

- 远端配置自动下载和预览，但不会自动应用。
- 社区插件包按目录级单元处理，`data.json` 默认排除并逐插件启用。
- 平台相关的 `core-plugins.json` 不进入 v1 便携配置；未来需要同步时会使用结构化字段，而不是覆盖原始文件。
- ConfigProfile 明确记录最低目标 Obsidian 版本和便携插件 ID；desktop-only、版本不兼容及未纳入便携集合的插件保持设备本地，不参与 ConfigTree Hash。
- 应用远端启用列表时只替换便携插件子集，并始终合并回设备本地插件和本同步插件。
- 本同步插件的代码、凭证、writerId、本地状态、Outbox 和恢复目录永久排除。
- 平台没有可用密钥存储时，S3 凭证可能以本地插件 data.json 明文保存；本插件不会上传或放入诊断，但其他备份工具仍可能读取。
- 插件 JavaScript 是可执行代码，必须显示高风险确认；v1 假定 Bucket 和所有写入者可信。
- v1 没有端到端加密或提交签名；Vault 字节、路径和含密钥的第三方配置都会以应用层明文保存在 S3。

## 仓库连接

首次连接时，向导会持久化规范 endpoint、region、path-style、Bucket、确切 Prefix、repositoryId，以及 format.json 中的 configDir、historicalConfigDirs 和规范 descriptor Hash。凭证只属于本机认证配置，不进入仓库身份或远端协议。

Prefix 可以根据 Vault 名称提出建议，但确认后不会随 Vault 改名自动变化。同一 Prefix 下存在多个 repositoryId 时必须显式选择，不会自动挑选或覆盖。

普通同步只要求 List、Head/Get 和 Put 权限，但 Put 必须支持 `If-None-Match: *` 或等价原子“仅不存在时创建”；不支持的存储只能只读诊断。DeleteObject 不是 v1 正常同步的最低权限；旧世代删除和维护使用独立权限或供应商控制台。

权限模板位于 `docs/s3-policy-minimal.json`、`docs/s3-policy-probe.json` 和 `docs/s3-policy-maintenance.json`。普通设备只使用 minimal；可删除 probe 和旧世代的凭证必须分开授予，并严格替换为对应独立 Prefix/旧 repositoryId。

## 真实 S3 合同测试

真实存储服务验证只用于确认 S3 adapter 的能力，不会同步 Vault，也不会创建或应用 v1 仓库。请使用专用测试 Bucket，或将 IAM 权限限制到 `contract/*` 前缀。测试会创建不可变对象，默认不执行 `DeleteObject`。

不要将 Access Key、Secret Key 或 Session Token 写入 `test/setup-minio-contract.ts`、插件设置、`.env` 或任何提交文件。仅在当前 PowerShell 会话设置环境变量：

```powershell
$env:S3_ENDPOINT = "https://s3.<region>.amazonaws.com"
$env:S3_REGION = "<region>"
$env:S3_BUCKET = "<专用测试桶>"
$env:S3_ACCESS_KEY_ID = "<AWS access key>"
$env:S3_SECRET_ACCESS_KEY = "<AWS secret>"
$env:S3_FORCE_PATH_STYLE = "false"

# 仅临时 AWS 凭证需要：
# $env:S3_SESSION_TOKEN = "<AWS session token>"

npm run test:s3-aws
```

标准 AWS endpoint 形如 `https://s3.ap-southeast-1.amazonaws.com`；中国区 endpoint 形如 `https://s3.cn-north-1.amazonaws.com.cn`。测试会验证同 Key 的两个并发条件写恰有一次成功，且后续 `GET`、`HEAD`、`LIST` 读取一致；同时执行下述仓库级恢复合同。

测试 IAM 最小权限为 Bucket 上的 `s3:ListBucket`，以及 `contract/*` 对象上的 `s3:GetObject` 和 `s3:PutObject`。不要授予 `s3:DeleteObject`。可测试 MinIO 时运行 `npm run test:s3-minio`；它使用 Docker Compose 的本地默认凭证，不需要任何云端密钥。

v1 当前声明支持百度云 BOS 与 MinIO。AWS S3 保留为未验证、未声明支持；在通过 `npm run test:s3-aws` 前不得将其列为兼容供应商。未来新增腾讯 COS 或其他 S3 兼容服务时，必须先增加对应的 fail-closed 测试入口并通过同一合同。

百度云 BOS 使用相同的合同，但必须使用专用入口，避免误用 MinIO 默认值或 AWS endpoint：

```powershell
$env:S3_ENDPOINT = "https://s3.gz.bcebos.com"
$env:S3_REGION = "gz"
$env:S3_BUCKET = "<专用测试桶>"
$env:S3_ACCESS_KEY_ID = "<Baidu access key>"
$env:S3_SECRET_ACCESS_KEY = "<Baidu secret key>"
$env:S3_FORCE_PATH_STYLE = "true"

npm run test:s3-baidu
```

成功输出必须显示对应供应商的 `ObjectStore contract` 与 `repository release acceptance`。仓库级合同会在随机 `contract/release/*` 下执行多 Chunk 续传、第三客户端恢复、世代隔离和 ConfigTree 恢复。MinIO 还会自动开启测试 Bucket Versioning，验证条件重试不产生多余版本；云端若要运行同项检查，需显式设置 `S3_TEST_VERSIONING=1` 并临时授予 Bucket Versioning/ListObjectVersions 权限。请在轮换旧密钥后使用新的受限凭证，且绝不把它们写入仓库文件。

## 设计与实施

- [design.md](design.md)：v1 协议、安全不变量、状态机和验收场景。
- [tasks.md](tasks.md)：从协议证明、同步内核到配置快照和发布验收的实施顺序。
- [docs/protocol-compatibility.md](docs/protocol-compatibility.md)：协议、运行时和供应商兼容边界。
- [docs/release-v1.md](docs/release-v1.md)：旧原型迁移、灾难恢复和发布门禁。
- [需求.md](需求.md)：项目背景和最初目标。

实施顺序固定为：协议与测试向量 -> 纯 TypeScript 领域核心 -> 本地持久状态和安全应用 -> Vault 产品闭环 -> 配置快照 -> 发布加固。
