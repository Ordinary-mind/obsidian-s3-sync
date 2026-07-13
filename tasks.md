# Obsidian S3 Sync v1 实施清单

> 依据：`design.md`。
>
> 执行原则：协议和测试工具先行；每个任务通过验收门后再进入依赖它的任务。
>
> 禁止事项：任务 0 未完成前，不实现或改造同步核心，不复用旧 `.s3-sync/manifest.json` 协议。
>
> 文档状态：`design.md`、本文与 README 已于 2026-07-11 完成协议设计基线审查。机器可读 Schema、严格解析/语义校验、Unicode 15.1 固定数据、固定向量、供应商/Obsidian 适配器契约和 Node 22 CI 验收均已完成；任务 0 已于 2026-07-13 通过。

## 0. 协议冻结与测试基础设施

依赖：无。

### 文档与协议决策

- [x] 逐条确认 `design.md` 第 4 节安全不变量，并在任务 1 至 16 或第 21 节冻结场景中指定实现/测试落点。
- [x] 冻结术语：RepositoryLocator、RepositoryDescriptor、descriptorHash、Blob、ConfigProfile、ConfigTree、Change Chunk、Commit、Version ID、observedHeads、projectedHeads、basisHeads、localPredecessorVersion、DirtyRecord、LocalConcurrentRecord、OutboxCommit、PublishedReconcile、ApplyJournal、DeletionEvidence。
- [x] 冻结远端根路径：`<prefix>/.obsidian-s3-sync/v1/repositories/<repository-id>/`，并把规范 configDir/historicalConfigDirs 固定进 RepositoryDescriptor/RepositoryLocator 仓库指纹。
- [x] 冻结 normalizedPrefix 的 NFC/分段规则和完整 S3 Key 1,024 UTF-8 bytes 上限。
- [x] 冻结 repositoryId、writerId、20 位 sequence、Commit Hash 和 Version ID 的格式。
- [x] 冻结 RFC 8785 规范 JSON、UTF-8、SHA-256、小写十六进制、UTF-8 数组排序和 Unicode 15.1.0 Default Case Folding 规则。
- [x] 使用 JSON Schema Draft 2020-12 冻结 RepositoryDescriptor/`format.json`、ConfigProfile、ConfigTree、两种 Change Chunk/Mutation 分支和 Commit；所有对象封闭、字段 required/条件组合与 `design.md` 完全一致。
- [x] Schema 与语义校验固定 descriptorHash 绑定、channel/Mutation 联合分支、四种 Commit kind、bootstrap/change/resolution/reduction 的 parent 基数、parent-reduction 单 Mutation 和 put/delete 字段组合。
- [x] 跨对象语义校验固定 ConfigSnapshotMutation 的 delete 因果：根快照 Tree 不含 delete，非根 Tree 的每个 delete path 至少由一个直接父 Tree 管理；缺父保持 pending，全部父验证后仍无依据则版本无效。
- [x] 将 `design.md` 第 7.1 节固定资源上限写入 JSON Schema、解析器测试和兼容性说明。
- [x] 冻结 ConfigProfile、minimumTargetAppVersion、portablePluginIds、显式 config delete、停止管理与删除之间的语义；`core-plugins.json` 固定排除于 v1 portable Tree。
- [x] 冻结 v1 信任模型：可信 Bucket/写入者、无签名、无 E2EE、插件代码属于高风险可执行内容。
- [x] 冻结普通同步所需 S3 权限；DeleteObject 只属于可选 probe 清理或维护能力。
- [x] 确定桌面、移动端和 S3 供应商支持矩阵，至少包含一个真实云端 S3 兼容实现和一个 MinIO 类实现；每个声明支持的供应商均须通过相同合同测试，未验证供应商不得宣称支持；核对 Obsidian `editor-change`、`vault.configDir`、rename/no-clobber 能力并据此冻结 manifest.minAppVersion、isDesktopOnly 或移动端保守模式。
- [x] 三份指导文档已将现有 `src/sync-engine.ts`、`src/s3-remote.ts` 及“本地重建远端”标记为 legacy prototype。
- [x] 在任何真实 Bucket 测试前，从可用 UI 禁用旧版“本地重建远端”，防止文档冻结期误用 legacy 协议。

### 测试工具

- [x] 选择 TypeScript 测试运行器并添加 `npm test`、watch 和 CI 命令。
- [x] 引入属性测试能力，用固定 seed 输出可重放失败样本。
- [x] 固定 Unicode 15.1.0 NFC/CaseFolding 数据来源、许可证和上游文件 SHA-256，生成可复现的规范化与 C/F 映射产物/向量；测试和运行时不依赖宿主 Unicode 版本或网络，并评估移动端 bundle 体积。
- [x] 实现有界 UTF-8/JSON 读取和验证管线测试：正文上限 -> 非法编码/BOM/重复 Key/深度/数组/字符串上限 -> RFC 8785 逐字节相等 -> 封闭 Schema -> 跨对象语义。
- [x] 实现确定性虚拟时钟、Fake Local FS、Fake Editor Events 和 Fake ObjectStore。
- [x] Fake Local FS 必须支持在每个读、rename、写、删除和状态落盘边界注入竞态与崩溃。
- [x] Fake ObjectStore 必须支持 List 乱序、重复、空页、晚可见、临时 404、丢失响应和对象篡改。
- [x] 建立规范协议正向/状态向量：descriptor/configDir/historicalConfigDirs/descriptorHash、空仓库、Vault put/delete、多 Chunk bootstrap、ConfigTree、由直接父 Tree 支持的 config delete、writer 正常链/分叉、暂缺 parent 的 pending、Vault Unicode case alias/路径前缀结构冲突，以及 vault/config 两个 channel 中的 change、bootstrap、conflict-resolution、parent-reduction。
- [x] 建立规范协议负向向量：字段缺失/多余/错型、错误 kind/channel 分支、BOM/非法 UTF-8/未配对 surrogate/重复 Key/非规范 JSON、非规范数组、Key/Hash/descriptorHash 不一致、parent 自引用/循环/跨寄存器、根 ConfigTree 携带 delete、所有直接父 Tree 均未管理逐字节相同 delete path，以及 ConfigTree 非法插件 ID/alias/前缀形状。
- [x] 为小型向量保存规范 JSON 原始 bytes、SHA-256、S3 Key 和期望逻辑状态；大型边界使用确定性生成配方/计数流，覆盖每项固定上限的 `limit` 与 `limit + 1`，不提交 5 GB fixture。

### 验收门

- [x] `design.md`、`tasks.md` 和 README 不再包含旧 manifest 作为目标协议。
- [x] 协议 Schema、上限和测试向量无待定字段。
- [x] 新测试命令可在无 Obsidian、无 AWS SDK、无网络环境运行。
- [x] Schema 正反例、固定 bytes/Hash/Key 和全部资源边界在 CI 中可确定性复现；任何向量变化都必须作为协议变更审查。
- [x] 文档用同一状态模型解释“本地编辑为何只能继承 projectedHeads 或精确本地冻结前驱，而不能继承刚拉到的 observedHeads”。

## 1. 可测试的领域核心

依赖：任务 0。

### 类型与编码

- [x] 新建不依赖 `obsidian` 和 AWS SDK 的 `core` 模块。
- [x] 定义 RepositoryDescriptor、含 descriptorHash 的 RepositoryLocator、BlobRef、ConfigTree、ConfigProfile、ChangeChunk、VaultMutation、ConfigSnapshotMutation 和 Commit 类型。
- [x] 实现 RFC 8785 编码和严格 JSON 解析；解析后重新编码必须与原始规范字节相同。
- [x] 实现 repositoryId、writerId、sequence、Hash、Version ID 和所有 Key 片段校验。
- [x] UUIDv4 生成只接受注入的 CSPRNG（生产 Web Crypto/Node crypto），正确设置 version/variant bits；禁止 Math.random，测试使用确定性 RNG adapter。
- [x] sequence 使用 BigInt/20 位十进制字符串运算并覆盖 2^53、uint64 最大值与溢出边界，禁止 Number 精度参与 Key 或链判断。
- [x] 实现 `versionId = commitHash:chunkIndex:mutationIndex`。
- [x] 拒绝重复路径、重复 parent、跨 channel 数据、字段组合错误和超限对象。

### 远端状态模型

- [x] 实现 Vault 路径寄存器：`heads = verifiedVersions - validSupersededVersions`。
- [x] 实现 ConfigTree 单寄存器，不按配置文件独立选择胜者。
- [x] 实现 parent 依赖 pending；父版本验证前不完成相关寄存器归并。
- [x] parent 验证必须检查同 repositoryId、同 channel 和同逻辑寄存器。
- [x] ConfigSnapshotMutation 按直接父 Tree 验证每个 delete path 的既有管理依据；根 delete 和无父依据 delete 隔离为无效版本，缺任一父/Tree 时保持 pending。
- [x] 实现相同 Blob Hash、相同 delete、相同 ConfigTree Hash 的语义折叠。
- [x] 实现 put/put、put/delete、多方并发、配置快照并发和并发解决判定。
- [x] 实现跨寄存器文件/目录前缀结构冲突；保留全部头且不按本地平台选择可物化版本。
- [x] 实现 writer sequence 连续链、缺口、重复 Commit 和同 sequence 分叉判定。

### 本地因果命令

- [x] 定义 RemoteRegisterState、PathProjection、dirtyIntent、DirtyRecord、LocalConcurrentRecord、DeletionEvidence 和 generation 类型。
- [x] `captureDirtyIntent` 只能复制 projectedHeads，不接收 observedHeads 参数。
- [x] 实现 DirtyRecord 连续编辑合并，但 basisHeads 永远不可变。
- [x] 定义 localPredecessorVersion：只能引用同一本地因果队列、同路径前一冻结 Outbox 的精确 Version ID；writerId 轮换不改变该引用，后续 generation 用它替代 basisHeads 且不能吸收新 observedHeads。
- [x] 实现相同最终字节的净变化消除；存在冻结 Outbox 时不得取消已冻结 generation。
- [x] 实现冲突解决命令；必须引用操作时已观察的全部头。
- [x] 实现超过 1,024 头的 parent-reduction 命令链；DirtyRecord 原始 basisHeads 不变，归约不得吸收之后观察的新头。
- [x] 实现首次接入命令：相同采用、local-only 根版本、remote-only 投影、不同内容根冲突。

### 测试

- [x] 同一提交集合随机排列和重复至少 1,000 次，最终状态完全一致。
- [x] 属性测试覆盖归并的交换律、结合律、幂等性和已覆盖版本不复活。
- [x] 子版本先于 parent 到达时保持 pending，parent 到达后得到正确结果。
- [x] dangling、跨路径、自引用和循环 parent 被隔离。
- [x] 时间戳、mtime、List 顺序和跨 writer sequence 不影响 heads。
- [x] 本地 dirtyIntent 建立后新增远端头，发布仍使用原 projectedHeads。
- [x] 两个不同 ConfigTree 并发时保持两个快照头，不产生文件级混合结果。

验收门：纯领域测试能证明远端收敛规则和本地父版本选择，不需要 Obsidian、S3 或真实文件系统。

## 2. 路径、本地观察与稳定读取

依赖：任务 0、1。

### 路径与范围

- [x] 实现 Vault 相对路径规范化：`/`、NFC、禁止绝对路径、空段和 `..`。
- [x] 本地两个原始名称归一成同一 NFC path 时形成结构冲突，不按扫描顺序覆盖；远端非 NFC path 拒绝。
- [x] 按冻结的 Unicode 15.1.0 NFC 与 C/F 映射实现规范路径和 case-fold key，不使用 locale 或运行时隐式 Unicode 版本。
- [x] 实现 Windows 保留名、尾随点/空格和平台非法字符检查；插件 ID 额外按冻结的 1..255 UTF-8 bytes、非法字符和设备名集合验证。
- [x] 从 `vault.configDir` 获取实际配置根，不硬编码 `.obsidian`。
- [x] Vault channel 按 descriptor 永久排除当前及全部 historicalConfigDirs；Config channel 只映射 current，并排除位于 current 内的历史子树。
- [x] 本机已知历史 configDir 不是 descriptor 集合子集时拒绝加入该 repositoryId，不能只在单机追加排除后造成跨设备范围分歧。
- [x] 永久排除本同步插件目录、固定 `.obsidian-s3-sync-local/<repositoryId>/` 状态/恢复根和 Vault 根 `.s3-sync-conflicts`，用户规则不能覆盖；不得另建只在本机生效的 Vault 级保留根。
- [x] 状态根和冲突根使用可验证所有权 metadata；同名文件、symlink、未知目录或 metadata 不匹配时拒绝接管、覆盖或静默排除用户内容。
- [x] 检测 case-only 路径别名和远端并发别名冲突。
- [x] 检测本地及远端 put 路径的严格段前缀碰撞，作为结构冲突阻止受影响子树自动应用。
- [x] symlink 检测能力不足时明确标记该路径不支持，不跟随到 Vault 外部。

### 编辑和文件事件

- [x] 接入 Obsidian `editor-change`，首次编辑立即在内存中阻塞远端应用并排队持久化 dirtyIntent。
- [x] editor dirtyIntent 持久化 awaitingLocalWrite/editor generation/可比较内容标识；Vault 事件本身不能解除，只有同 generation editor 内容与稳定磁盘字节精确匹配或适配器证明缓冲区已干净才可解除。
- [ ] 门闩期间稳定磁盘值等于原 projectedValue 时继续等待；其他值先进入不可变 localCandidates，匹配已知 editor generation 可视为中间 autosave。只有适配器有来源证据时才创建 LocalConcurrentRecord，不能因不匹配最新 buffer 猜外部并发。
- [x] awaitingLocalWrite 路径不得冻结进 Outbox；最新未变化 editor generation 与稳定磁盘匹配或适配器证明 buffer clean 后才选最终 DirtyRecord，未选候选保留到发布复核完成后的本地恢复策略。
- [x] 接入 Vault create/modify/delete/rename，事件记录路径、generation 和当时 projectedHeads。
- [x] rename 事件在一个本地状态事务中保存旧路径删除和新路径新增意图。
- [ ] 配置通道没有通用文件事件时，依靠安静窗口扫描和应用前完整复查保证安全。
- [ ] 插件 unload、移动端挂起前停止调度并尽力刷新已进入内存的 dirtyIntent。

### Hash、暂存与删除证据

- [x] 实现原始字节流式 SHA-256，不使用 ETag、mtime 或 size 替代。
- [x] 实现防抖稳定读取：第一次边复制到临时不可变暂存边计算 size/Hash，安静窗口后第二次完整读取活动路径；类型、size、Hash 全相同才接受第一份字节。
- [x] 两次读取之间或期间发生变化、读取失败、文件类型变化时保留 dirtyIntent 并重试，不发布撕裂字节。
- [x] 暂存写入完成后重新 Hash，不能只保存活动文件路径。
- [x] 实现 `present`、`confirmed-absent`、`unknown/error` 和 `out-of-scope` 四态观察。
- [x] 文件逻辑路径上出现目录、symlink、reparse point 或不可安全枚举节点时返回 unknown，不返回 confirmed-absent。
- [x] delete/rename 事件必须排除本插件 ApplyJournal 对应操作。
- [x] 审计缺失只有在整轮成功、未取消、范围版本不变且直接复查仍缺失时才能成为 DeletionEvidence。
- [x] ignore/config profile 变更只停止管理，不产生 tombstone。
- [x] 文件超限、路径不兼容、读取失败和扫描不完整都返回 unknown，不返回 absent。
- [ ] 新建根 put 冻结后发生 confirmed-absent 时持久化等待删除意图和该 put 的 localPredecessorVersion；put 验证发布前不得冻结根 delete，发布后 delete 只继承该 Version ID。
- [x] 设计 Hash 缓存；完整审计绕过不可靠缓存，缓存失效不改变结果。

### 测试

- [x] `editor-change -> 远端新头 -> 本地尚未保存` 时远端应用被阻止。
- [x] editor-change 后旧磁盘字节重复稳定、轮询超时和插件热重载都不能提前清除 awaitingLocalWrite；后续 autosave 仍继承原 projectedHeads。
- [ ] editor-change 后旧 projectedValue 反复稳定不会制造 LocalConcurrentRecord；匹配 editor 候选的 autosave 只生成正常 DirtyRecord。
- [ ] editor-change 后外部 modify/delete/rename 先到：无来源证据时只暂存候选并继续门闩，有来源证据时进入 LocalConcurrentRecord；两种情况都不发布伪父子版本或允许远端应用。
- [x] 本地磁盘先变化、Vault 事件后到、远端先拉取时，basisHeads 仍为旧 projectedHeads。
- [x] 同内容只改 mtime 100 次，不产生 DirtyRecord。
- [x] 写入过程中读取、零字节、大文件、Unicode 和大小写别名测试。
- [x] delete 后快速 recreate 合并为最终 put，不发布瞬时墓碑。
- [x] 权限错误、取消扫描、目录临时不可用和 ignore 变更均不产生墓碑。
- [x] 自定义 configDir 下，本插件 data/state 永远不可进入扫描结果。
- [x] configDir 切换后，旧目录中的凭证、状态、Outbox 和恢复数据仍在 sensitivePathExclusions 中且不能被用户 ignore 规则重新纳入。
- [ ] configDir 切换会使原 RepositoryLocator 指纹失配并停止发布/应用；新 repositoryId descriptor 携带旧 current/histories 并集，所有设备继续排除旧目录。
- [x] `foo` 文件与 `foo/bar.md` 并发、case-fold 特殊字符和不同运行时 locale 得到同一冲突结果。
- [x] 规范等价但字节不同的 Unicode 文件名在可创建它们的平台形成同一 NFC collision，不丢任何本地字节。

验收门：观察层只报告已确认字节或删除意图；任何不确定情况都能明确解释且不会进入发布命令。

## 3. ObjectStore 抽象与 S3 兼容性

依赖：任务 0。

### 接口与适配器

- [ ] 定义 ObjectStore：分页 List、Head、流式 Get、PutImmutable 和可选 DeleteProbe。
- [ ] AWS SDK 只存在于 S3 adapter，领域层不引用供应商类型。
- [ ] 实现冻结的 Locator 规范：HTTPS origin-only WHATWG endpoint（测试模式仅 loopback HTTP）、`[A-Za-z0-9._-]{1,128}` region、显式 forcePathStyle、Bucket 和 normalizedPrefix；验证所有完整协议 Key 不超过 1,024 UTF-8 bytes。
- [ ] 实现超时、取消、指数退避、限流和错误分类。
- [ ] List 正确处理空页、重复 Key、乱序结果、continuation token 和 Prefix delimiter。
- [ ] PutImmutable 强制 `If-None-Match: *` 或已证明等价的原子仅创建；条件失败 GET 比对，写后再次 GET/Hash。无条件 PUT + HEAD 检查不得进入正式 adapter。
- [ ] 同 Key 不同字节立即报告完整性错误，不自动覆盖或修复。
- [ ] 正常协议接口不暴露 DeleteObject；probe 清理和维护删除使用独立能力。
- [ ] 连接测试执行隔离 Key 的 Put、Get、Hash、Head、List；Delete 不可用时仍可通过正常同步能力测试。
- [ ] 记录并脱敏 HTTP 状态、Request ID、重试和失败阶段。

### 测试

- [ ] Fake ObjectStore 模拟晚可见、重复、乱序、临时 404 和 PUT 响应丢失。
- [ ] 条件创建不可用或语义不原子时，连接 probe 明确拒绝写模式；只读诊断不得发 PUT。
- [ ] 以不同正文并发 PutImmutable 同一 Key，契约测试必须证明恰好一个请求成功、失败请求不覆盖当前字节；客户端锁、HEAD+PUT 和无条件 PUT adapter 必须失败。
- [ ] 预先存在不同字节的同 Key 对象被拒绝，不发生覆盖。
- [ ] AWS S3 和声明支持的兼容存储运行同一契约测试。
- [ ] Bucket Versioning 开启时，重复重试不会无意义地产生大量非当前版本。
- [ ] 无 DeleteObject 权限的普通凭证可完成全部正常同步契约。

验收门：所有声明支持的存储通过同一契约；不满足关键能力时向导能指出具体缺失，不进入正式仓库。

## 4. 不可变远端协议

依赖：任务 1、2、3。

### 仓库与 Key

- [ ] 实现 RepositoryLocator、仓库指纹和 repositoryId 根路径。
- [ ] RepositoryDescriptor/Locator 持久化规范 configDir、historicalConfigDirs 和 descriptorHash；实际 vault.configDir、本机历史集合、descriptor bytes 或 Tree/Chunk/Commit descriptorHash 不一致时拒绝绑定、发布和应用。
- [ ] 实现 Prefix 下 repositoryId 发现：只接受精确深度的 canonical UUIDv4/format.json，逐项 GET 并校验 Key/descriptor/Hash；畸形或缺失候选仅诊断，多个合法仓库必须显式选择。
- [ ] 实现固定 RepositoryDescriptor/`format.json` 编码：仅创建者用 PutImmutable 写，加入者只读；条件失败只 GET 比对，永不无条件覆盖。
- [ ] 空仓库保存 descriptor anchor；非空仓库保存每个已知 writer 的连续 frontier 分支 tip Hash 集合，并在发布前逐个 GET、验证 Key 和正文 Hash，HEAD/ETag 不足以通过。
- [ ] List 缺失不视为损坏；已观察 integrity anchor 或已知 Commit 经重试仍无法直接 HEAD/GET 时停止发布。
- [ ] 实现 Blob、ConfigTree、Change Chunk 和 Commit Key builder。
- [ ] Key builder 对空 Prefix 不产生前导 `/`，非空 Prefix 只连接一个 `/`；固定向量覆盖空/Unicode Prefix 和完整 Key 1,024/1,025 bytes。
- [ ] 内容寻址 Key 的分片目录严格使用 Hash 前两个小写字符。

### 对象读写

- [ ] 实现 Blob 上传、下载、流式 Hash 和可读验证。
- [ ] Config/Vault put 的声明 size 必须等于实际 Blob bytes；同 Hash 不同 size 只验证匹配引用，不按声明 size 预分配或错误应用。
- [ ] v1 拒绝超过 5,000,000,000 bytes 的 Blob，不实现 multipart；平台更低上限必须可诊断。
- [ ] 实现 ConfigTree 编码、上传、下载和完整 profile/item 校验。
- [ ] ConfigTree validator 按冻结映射验证 baseFiles/themes/snippets/pluginPackages/pluginData 的路径覆盖，拒绝重叠/越界和 package 根 data.json 混入。
- [ ] ConfigTree validator 按固定 case-fold/段前缀规则拒绝映射到 current 内 historicalConfigDir、`.obsidian-s3-sync-local` 或 `plugins/obsidian-s3-sync` 的 item，不使用本机自定义保留根改变协议判定。
- [ ] 实现多 Change Chunk 编码；同一 Commit 全局禁止重复 Vault path。
- [ ] Vault Mutation 按固定 case-fold/段前缀规则命中 descriptor current/historical configDir 或 Vault 根 `.s3-sync-conflicts` 时只隔离该寄存器版本，绝不创建/应用；同信封其他合法寄存器可继续。
- [ ] 拒绝空 Change Chunk 和空 Commit；真正空仓库只使用 RepositoryDescriptor anchor。
- [ ] Config Commit 必须恰有一个 Chunk 和一个 ConfigSnapshotMutation。
- [ ] 校验 Chunk 数组非空、index 连续、跨 Chunk Mutation 全局排序，以及 repositoryId/channel/chunkCount 一致。
- [ ] Commit 结构信封使用磁盘/增量验证，不能把最多 1,024 个 4 MiB Chunk 同时留在内存；创建任何 Version 前仍须完成全信封校验。
- [ ] 实现 Commit 规范编码、Commit Hash 和 20 位 sequence Key。
- [ ] sequence 达到 uint64 最大值后轮换 writerId；禁止溢出、回绕或复用。
- [ ] `parent-reduction` Commit 必须恰有一个 Chunk 和一个 Mutation。
- [ ] 校验两个 channel 的全部 kind：bootstrap=0、change=0..1,024、conflict-resolution=1..1,024、parent-reduction=2..1,024 parents 且 reduction 仅单 Mutation；kind 不参与选胜者。
- [ ] 实现发布顺序：Blob -> ConfigTree -> Change Chunk -> Commit。
- [ ] 所有对象同 Key 同字节视为重试成功，同 Key 不同字节为完整性错误。

### 发现、依赖和 writer 链

- [ ] 分页发现 writer 和 Commit，不依赖可变 writer registry。
- [ ] 校验 writer sequence、首提交 null previous、后续 previousCommitHash、缺口和分叉。
- [ ] 实现 parent 依赖队列，依赖未齐不应用相关寄存器。
- [ ] 实现增量轮询和从头完整 Commit 审计；marker 只是缓存。
- [ ] 实现可恢复的远端完整校验：遍历全部已验证 Commit 及可达 Chunk/Tree/Blob 并重新 GET/Hash；tip anchor 检查不能冒充全仓健康。
- [ ] 实现远端全量重建 API，不依赖本地数据库或 checkpoint。
- [ ] checkpoint 在 v1 后续实现前保持未使用状态。

### 测试

- [ ] 与任务 0 固定测试向量逐字节一致。
- [ ] 在每个远端写入步骤前后注入崩溃，Commit 可见状态始终完整可重建。
- [ ] 已共享 repositoryId 的两个 writer 并发 bootstrap，结果合并或显式冲突。
- [ ] 不同 repositoryId 在同 Prefix 完全隔离。
- [ ] Commit 先可见、依赖暂不可见时只重试。
- [ ] 任一 Change Chunk 缺失/损坏或跨 Chunk 规则失败时，Commit 的所有 Mutation 都不创建；完整结构信封通过后再按 Mutation 验证 Blob/Tree/parent。
- [ ] 单个 Vault Blob 或 ConfigTree 内容依赖缺失/损坏只阻塞对应寄存器，其他 Mutation 可归并；缺依赖值绝不按空内容应用。
- [ ] parent 来自其他路径、其他仓库或其他 channel 时隔离。
- [ ] writer 同 sequence 两个 Hash 均参与归并并触发身份轮换。
- [ ] sequence 最大值或 fork 排空后轮换 writerId，下一本地 generation 仍可把旧 writer 的精确 Version ID 作为 localPredecessor，previousCommitHash 则在新 writer 上从 null 开始。
- [ ] 任意对象被篡改、截断或超限时停止相关寄存器应用。
- [ ] format.json 被替换、或 Tree/Chunk/Commit descriptorHash 不一致时，新旧客户端都停止该仓库发布/应用，不按新 configDir 重解释旧提交。

验收门：删除所有本地状态后，空本地仅靠远端不可变对象能重建相同 Vault 头、配置头和冲突集合。

## 5. 本地状态、内容暂存与 Durable Outbox

依赖：任务 1、2、4。

### 状态存储

- [ ] `data.json` 只保存连接设置、凭证或平台 secret provider 引用和 UI 偏好；无 secret provider 时明确提示本地明文风险。
- [ ] 在实际 configDir 下建立固定 `.obsidian-s3-sync-local/<repositoryId>/` 状态根，全部暂存、Journal 和非冲突恢复文件都只能位于其下。
- [ ] 实现 schema 版本、state generation、校验和、双副本和单写入队列。
- [ ] 一个状态事务可原子更新 dirtyIntent、projection、writer sequence 和 Outbox 引用。
- [ ] 实现 RepositoryLocator、descriptor Hash 和每个 writer frontier branch-tip integrity anchors 持久化。
- [ ] 实现 ingested frontier、稀疏 seen commits、observedHeads、projectedHeads、projectedValue 和 pending apply。
- [ ] 持久化 LocalConcurrentRecord、对应暂存引用和用户选择/合并状态；未解决时阻止该路径发布与远端应用。
- [ ] 持久化每个已发布 Mutation 的 Version ID、暂存引用和 PublishedReconcile；该状态未解决前阻止相关寄存器远端应用。
- [ ] 设置切换仓库时先停止协调器；旧仓库 Outbox 不得发送到新仓库。
- [ ] endpoint/region/path-style 受控变更先停协调器并用候选连接对 descriptor 和全部 branch-tip anchors 执行 GET/Key/正文 Hash 重验，再原子更新 Locator；Bucket/Prefix/repositoryId/descriptor 变化进入重新接入，凭证轮换不重建因果状态。

### 本地内容暂存

- [ ] put 字节以 SHA-256 存入不可变本地暂存，写后重算 Hash。
- [ ] 引用计数或可达性只用于暂存缓存清理，不能删除仍被 DirtyRecord、LocalConcurrentRecord、Outbox、PublishedReconcile、冲突草稿或 Journal 引用的内容；v1 的恢复文件即使解除引用也不自动删除。
- [ ] 恢复记录持久化来源、路径、最近稳定 Hash/size 和 post-capture edit 标记；恢复文件只能由用户查看当前状态后显式清理。
- [ ] 大文件暂存采用流式 I/O，并在空间不足前给出预估和明确错误。
- [ ] 插件更新不能自动删除状态根；卸载后的重新安装必须检测遗留状态或进入重新接入。

### Outbox 状态机

- [ ] 创建 Outbox 时冻结 Blob 引用、Tree/Chunk/Commit 规范字节和 Commit Hash。
- [ ] sequence、previousCommitHash、Outbox 和捕获 generation 在一个状态事务中持久化。
- [ ] 每个 writer 只允许一个 publishing Outbox；其余 FIFO 排队。
- [ ] 已分配 sequence 不允许跳过、复用或替换 Commit 内容。
- [ ] 重启后继续同一 Commit；不生成语义相同但 ID 不同的替代提交。
- [ ] Commit 发布确认后先事务性把本机 Commit 纳入 verified frontier/observedHeads、推进 writer 链并创建逐 Mutation PublishedReconcile，不能仅凭 generation 未变清理 DirtyRecord。
- [ ] Vault 重新稳定 Hash/确认缺失、Config 重新完整构建 Tree 后，只有结果等于发布值且无新 dirtyIntent 才更新 projection 并清理。
- [ ] 结果不同则事务性创建/保留下一 generation 并只继承 published Version ID；结果 unknown 则保持 reconcile 状态和暂存引用。
- [ ] 后续 generation 在前一 Outbox 冻结时即持久化 localPredecessorVersion；发布确认不得再重算或替换它。
- [ ] 没有 projectedHeads 的冻结根 put 被本地删除时仍先发布原 put；delete Outbox 等待其验证发布，且 parents 精确等于该 put 的单一 Version ID，绝不抵消两代或生成根墓碑。
- [ ] writer 分叉后旧身份停止冻结新 Commit；可验证的既有 Outbox 按原 FIFO/字节排空后换新 writerId，无法验证的链进入 recovery-required，绝不改写或自动复制冻结提交。

### 状态丢失与恢复测试

- [ ] 在每个状态落盘点终止进程，重启后继续或安全停止。
- [ ] Outbox 冻结后活动文件修改、删除，仍可发布冻结字节。
- [ ] 本地新建 put 冻结后删除并重启：put 仍按原字节发布，delete 发布前始终等待该 put，最终远端头是以该 put 为唯一 parent 的墓碑。
- [ ] Outbox 冻结后出现新远端头且活动文件再次编辑时，下一 generation 的 parents 只含已冻结 localPredecessorVersion；重启结果相同。
- [ ] 外部改写发生在稳定读取后、事件入队前时，发布后 Hash 守卫发现差异并创建后续 generation，不把活动字节错误标记为已投影。
- [ ] 发布后本地读取失败或 config Tree 无法完整重建时保持 PublishedReconcile，重启不清 dirty、不重复发布旧 generation。
- [ ] 当前与备份状态文件均损坏时，不自动清空或推断本地删除。
- [ ] 有本地内容的状态丢失进入非破坏性接入；空本地才允许纯远端重建。
- [ ] 错误仓库指纹、repositoryId、anchor、旧 schema 和重复 writer sequence 均有明确处理。
- [ ] writer fork 前已冻结一个或多个 Outbox 时，只发布原字节并在排空后轮换身份；任一项不可验证时保持全部暂存且不跳 sequence。
- [ ] Vault 改名不改变已持久化 Prefix 或 repositoryId。

验收门：任意重启都不会遗失已冻结待提交字节、复用 writer sequence 或把旧仓库状态用于新仓库。

## 6. 本地安全应用器

依赖：任务 1、2、5。

### LocalFileAdapter 契约

- [ ] 定义 present/absent/unknown 读取、流式暂存、rename-to-recovery、no-clobber install 和恢复接口。
- [ ] 为桌面和移动适配器记录 rename、覆盖、文件占用和原子性能力。
- [ ] 不能证明字节保留语义的平台进入明确保守模式：不覆盖/delete 正式路径，只允许无写入采用或把远端候选物化到排除区供用户处理；恢复复制不能冒充 no-clobber。
- [ ] Vault 普通文件与 configDir 文件使用各自合适的 Obsidian API/adapter 路径，并保持事件可观察。

### ApplyJournal 状态机

- [ ] ApplyPlan 绑定 targetHeads、targetValue、expectedLocalValue、projection generation 和 dirty generation。
- [ ] 破坏性 ApplyPlan 只允许 expectedLocalValue 等于持久化 projectedValue；不同则先按旧 projectedHeads 固定本地变化。仅“本地已等于唯一远端目标且无 dirtyIntent”可无写入采用。
- [ ] 执行前校验 RepositoryLocator 和 targetHeads 仍等于当前 verified observedHeads；已知新头使计划失效并重建，不把旧计划继续落盘。
- [ ] 本地值已等于目标 put Hash 或双方均 absent 时不重写文件，只事务性采用目标全部等价头。
- [ ] 下载到暂存区并验证 size/Hash，正式路径不接触未验证内容。
- [ ] 每个破坏性 I/O 前先持久化 ApplyJournal。
- [ ] 应用前检查 dirtyIntent、DirtyRecord、LocalConcurrentRecord 和 generation。
- [ ] 目标存在时先 rename 到唯一恢复文件，再 Hash 被移走字节。
- [ ] 观察恢复路径；rename 后旧文件句柄继续写入使 Hash/size 改变时更新 post-capture edit 恢复记录，文件不得自动清理。
- [ ] 前像不匹配时不安装远端内容；恢复或保留双方并创建 DirtyRecord。
- [ ] 安装使用 no-clobber 语义；目标重新出现时取消应用并保留双方。
- [ ] delete 只移入恢复区，不直接 unlink。
- [ ] 安装后重读正式路径并验证目标后像，此时尚不得更新 projectedHeads/projectedValue。
- [ ] projection 记账前再次验证目标后像、RepositoryLocator、targetHeads、projection/dirty generation 和非本插件 dirtyIntent；delete 必须重读为 confirmed-absent，unknown 不得成功。
- [ ] 写入静音标记绑定 operationId 和预期结果，不能按固定时间或盲目吞下下一事件。
- [ ] 一个路径失败保持 pending apply，其他路径按策略继续。
- [ ] 对 delete/put 文件-目录形状变换建立 Journal group：阻挡项深到浅移入恢复区、put 浅到深 no-clobber 安装；计划外子项或 dirty 路径使整组停止。

### 测试

- [ ] 在下载、Journal、前像读取、目标移出、恢复 Hash、安装、后验 Hash 和记账各阶段注入崩溃。
- [ ] 在上述每个阶段注入 editor-change、Vault 事件和外部文件写入。
- [ ] 目标在 no-clobber install 前重新出现时不被覆盖。
- [ ] POSIX 旧句柄在 rename 后继续写恢复文件时，新字节保持可达、被标记 post-capture edit，且不阻止对正式目标执行独立的后像/记账守卫。
- [ ] 本地值在计划生成前已偏离 projectedValue 时不得被当作“已验证前像”覆盖；即使 Vault 事件晚到也必须生成本地 DirtyRecord。
- [ ] 安装后到 projection 记账前注入 editor-change/外部写入时，不误标 projectedHeads，不清除新 dirtyIntent。
- [ ] 删除竞态中所有本地字节都在正式路径或恢复区可达。
- [ ] 远端应用事件与紧随其后的用户编辑不会被同一个静音标记吞掉。
- [ ] 磁盘不足、权限错误、文件占用和父目录创建失败可恢复。
- [ ] Windows、macOS、Linux 和移动适配器分别运行声明能力的契约测试。
- [ ] `delete foo + put foo/bar` 及反向变换在每个 I/O 边界崩溃或并发写入时都保留全部字节。

验收门：任何注入点都不能丢弃本地字节；无法满足该条件的平台不会启用破坏性自动应用。

## 7. 同步协调器

依赖：任务 4、5、6。

### 状态机

- [ ] 实现单轮流程：恢复 -> 校验仓库 -> 拉取/验证 -> 持久归并 -> Vault 应用 -> 本地检测 -> 再拉取 -> 冻结 Outbox -> 发布 -> 验证。
- [ ] ingested frontier、observedHeads、pending apply 和 projectedHeads 使用独立状态。
- [ ] 远端 Commit 可先入库；本地应用失败仍保留 pending。
- [ ] 实现单进程全局协调锁和路径级锁。
- [ ] 能检测同 Vault 多实例时进入只读；远端 writer fork 作为最终安全网。
- [ ] 同步中产生的新事件进入下一 generation，不递归启动协调器。
- [ ] 路径冲突和路径错误只阻塞相关路径。

### 调度

- [ ] 实现手动“立即同步”和只读“仅预览”。
- [ ] 实现可开关的启动同步、事件同步和远端轮询。
- [ ] 实现启动对账和低频完整内容审计。
- [ ] 预览计划执行前必须重验远端头和本地前像。
- [ ] unload/挂起停止新任务、取消请求并保留所有持久队列。
- [ ] 认证错误停止自动重试；网络/限流/5xx 指数退避。

### 测试

- [ ] 断网编辑后重连、快速连续保存、轮询失败和手动同步同时触发。
- [ ] editor-change 在远端拉取与本地 autosave 之间发生。
- [ ] 两设备不同文件、同文件、修改/delete 和 rename/modify 并发。
- [ ] List 晚到后只形成冲突，不把新头加入旧 DirtyRecord 的 parents。
- [ ] 一个 Commit 的一个路径应用失败，其他路径收敛且失败路径重启后继续。
- [ ] 预览后本地或远端变化使原计划失效。

验收门：压力运行中所有状态可解释，客户端最终头集合一致且没有未解释的数据丢失。

## 8. 仓库与 Vault 首次接入

依赖：任务 4、5、6、7。

### 仓库向导

- [ ] 测试正常同步所需 S3 能力，不把 DeleteObject 当作必需。
- [ ] 向导收集并确认 endpoint、region、forcePathStyle、Bucket 和 Prefix；生产拒绝非 HTTPS、URL base path/userinfo/query/fragment，凭证与 Locator 分开保存。
- [ ] 列出 Prefix 下 repositoryId；零个时可新建，一个时确认加入，多个时必须选择。
- [ ] 创建者生成 repositoryId 并写固定 format.json；加入者只读验证 descriptorHash，不写全局 current/latest 指针，也不补写暂时不可见的 descriptor。
- [ ] 创建时把实际规范 configDir 和全部已知 historicalConfigDirs 写入 format.json；加入设备 current 不一致或本机有 descriptor 外历史根时只提供调整/新 repositoryId 并集迁移，不允许继续。
- [ ] current/history configDir 与固定 Vault 根 `.s3-sync-conflicts` 按 case-fold 比较存在相同/祖先/后代关系时拒绝创建或加入。
- [ ] 校验 current/history 的 case-fold、祖先和后代关系，并按设计冻结的通道规则生成同一排除集合；history 位于 current 内时 ConfigTree 不能覆盖该子树。
- [ ] 扫描既有状态根和冲突根的所有权；任何未认领同名路径先阻断向导，不自动迁移或删除，恢复文件只能位于已认领状态根内。
- [ ] 从可验证的旧状态/插件所有权 metadata 恢复 historicalConfigDirs 候选并让用户确认；状态丢失时不能假定“没有本机历史根”。
- [ ] Prefix 首次确认后持久化，Vault 改名不重算。
- [ ] 发现旧 manifest 时只提供迁移说明，不原地升级。
- [ ] 向导完成前关闭自动同步，并持久化检查点。

### Vault 接入语义

- [ ] 实现远端空/非空 × 本地空/非空四种组合。
- [ ] local-only 发布 `parents=[]` 根 put。
- [ ] remote-only 安全投影，不把本地缺失发布为 delete。
- [ ] 相同 Hash 采用当时全部等价远端头。
- [ ] 同路径不同内容发布本地根 put，形成首次冲突。
- [ ] 远端墓碑 + 本地文件形成 put/delete 首次冲突。
- [ ] 远端已有冲突时继承全部头；本地匹配某头不重复发布，不匹配任何头才经确认增加本地根。
- [ ] 本地匹配冲突中的某个语义值时采用该值全部等价头为 projectedHeads，但冲突仍未解决且 UI 不标记胜者。
- [ ] 多 Chunk bootstrap 的所有 Blob/Chunk 完成后由一个 Commit 发布。
- [ ] 发布前再拉取只用于提示并发；不得改变首次本地根的空 parents。
- [ ] “以远端克隆已有本地”先把本地内容移入恢复区并二次确认。
- [ ] “以本地覆盖远端”替换为新 repositoryId/新世代。

### 状态丢失重新接入

- [ ] 本地状态损坏但 Vault 非空时自动进入已有内容接入，不执行普通 pull/apply。
- [ ] 本地缺失不生成 tombstone，本地内容不继承当前 observedHeads。
- [ ] 用户确认新 projection 前不发布、覆盖或删除。

### 测试矩阵

- [ ] 远端空 + 本地空。
- [ ] 远端空 + 本地有内容。
- [ ] 远端有内容 + 本地空。
- [ ] 相同路径相同内容、不同内容和双方独有内容。
- [ ] 远端墓碑 + 首次本地文件。
- [ ] 远端已有冲突 + 全新客户端。
- [ ] bootstrap 中断、共享 repositoryId 并发 bootstrap、不同 repositoryId 并发新建。
- [ ] 状态丢失后本地有修改、有删除和有未完成恢复文件。

验收门：所有首次和恢复组合默认不覆盖、不删除已有用户内容，也不伪造共同父版本。

## 9. Vault 冲突与解决

依赖：任务 1、6、7、8。

- [ ] 使用规范编码的 repositoryId/channel/logical-key/heads 生成稳定冲突 ID。
- [ ] 实现 `.s3-sync-conflicts/<conflict-id>/` 物化并永久排除。
- [ ] 为所有 put 头保存可打开副本，为 delete 头保存结构化意图。
- [ ] 冲突正文使用 sha256(version-id) 等安全 ASCII 文件名，metadata 保存原路径/Version ID；Windows 非法名和跨平台路径也能完整物化。
- [ ] 原路径已有本地内容时保持不动；新客户端只显示确定性候选，不标记胜者。
- [ ] 冲突期间编辑成为本地草稿，不自动发布普通覆盖。
- [ ] 展示并解决 LocalConcurrentRecord 的 editor/磁盘候选；最终值只继承记录中的原 basisHeads，未选暂存不在提交后立即删除。
- [ ] 实现“选本地”“选某版本”“用当前合并内容”“确认删除”。
- [ ] 解决命令冻结操作时 observedHeads 和选定字节；已知头变化时要求刷新。
- [ ] 未见并发头稍后到达时形成新冲突。
- [ ] 冲突集合扩展导致 conflictId 变化时迁移本地草稿，不误清理。
- [ ] 文件/目录前缀结构冲突使用稳定跨路径 ID，解决前不自动应用受影响子树。
- [ ] 冲突解决传播后清理副本；未提交草稿和恢复文件不得自动删除。

测试：

- [ ] 第三个全新客户端得到相同远端冲突集合和全部内容。
- [ ] 冲突副本不上传，增加客户端不会产生副本风暴。
- [ ] 两设备同时不同方式解决冲突时产生新冲突。
- [ ] 解决预览后新增远端头、修改本地草稿和重启均安全。
- [ ] 1,025 个以上等价头和冲突头可分步归约；任一步崩溃都不丢失未覆盖头。

验收门：每个内容版本和删除意图都可恢复，解决动作本身仍遵守并发规则。

## 10. ConfigTree 核心与安全应用

依赖：任务 1、2、4、5、6、7、8、9。

### ConfigTree 构建

- [ ] 从实际 `vault.configDir` 构建 config 相对路径。
- [ ] 实现 ConfigProfile：baseFiles、themes、snippets、minimumTargetAppVersion、portablePluginIds、pluginPackages、pluginData。
- [ ] baseFiles 默认值严格采用设计基线的三个文件；`community-plugins.json`、`core-plugins.json` 和 `workspace*.json` 不能作为 raw baseFiles 加入。
- [ ] ConfigTree 保存完整受管理 put/delete，不以“扫描没看到”隐式删除。
- [ ] profile 仍覆盖且没有新 put 时，后继 Tree 必须继续携带已有 delete item；丢弃 delete 只能作为显式停止管理，不能由扫描重建顺手消失。
- [ ] 两次配置扫描都必须完整、无 unknown 且 scopeRevision 相同；projected put 缺失经防抖直接复查后才可生成 config delete。
- [ ] 拒绝不被 ConfigProfile 覆盖的 item、保留路径 item 和重复 config path；仅拒绝 put-put 大小写别名或严格前缀碰撞，允许由 delete/put 表达的合法形状变换。
- [ ] 按精确冻结映射验证覆盖：base 根文件、themes/snippets 严格后代、package 严格后代且排除根 data.json、pluginData 精确 data.json；每个 item 恰有一个覆盖来源。
- [ ] profile 范围内的本地额外文件构成不同本地 Tree；保留、显式删除和停止管理产生三种不同解决结果。
- [ ] profile 变更是显式操作；移出 profile 表示停止管理并保留本地。
- [ ] 配置安静窗口后连续两次逻辑扫描相同才接受。
- [ ] 第二次扫描的确切 put 字节直接进入内容暂存。
- [ ] Obsidian 反复重写相同字节不产生新 Tree Hash。

### 插件包与启用状态

- [ ] 社区插件包按目录级单元管理，包含额外静态资源，不假定只有三个文件；包扫描永久排除 case-fold 后的 data.json。
- [ ] `data.json` 始终独立逐插件 opt-in，并显示启发式敏感信息警告。
- [ ] `community-plugins.json` 转换为结构化启用 ID；远端表示不包含本同步插件。
- [ ] community-plugins.json 读取/解析/ID 校验失败使整次扫描 unknown；仅 confirmed-absent 表示空启用集合。
- [ ] community-plugins.json 输入及合并输出使用 4 MiB/100,000 ID 上限；非法 UTF-8、BOM、重复/case-fold alias、错型和超限均为 unknown，不截断。
- [ ] `pluginPackages`、`pluginData`、`enabledCommunityPlugins` 必须是 portablePluginIds 子集，四个数组都排除本同步插件。
- [ ] 插件 ID 必须按冻结的 1..255 UTF-8 bytes、非法字符、尾点/空格和 Windows 设备名集合验证，并保持 NFC、case-fold 唯一；版本严格解析为三段十进制并逐段数值比较，不使用 locale 或字符串比较。
- [ ] 应用启用列表时，以远端便携子集替换本地便携子集，并合并本地未管理 ID 与本同步插件 ID。
- [ ] 本地未管理 ID/目录与 portable ID 出现 case-fold alias 时阻断启用列表及 package/data 的整棵 Tree 应用并显示结构冲突，不静默去重。
- [ ] 读取插件 manifest ID、版本、minAppVersion 和 isDesktopOnly；缺失/非法、ID 不一致、desktop-only 或高于 minimumTargetAppVersion 的插件不得进入 portablePluginIds。
- [ ] manifest.json 使用 256 KiB、depth 16、string 4 KiB 的有界重复 Key 感知解析器；未知字段允许，已知字段错型或超限使 manifest 非法。
- [ ] 有 package put、或受管 package ID 被要求启用时强制存在并验证 manifest.json put；未同步 package 的启用项/pluginData put 在目标设备无兼容本地包时整棵 Tree incompatible，不部分写入或记 projection。
- [ ] 设备本地插件的启用 ID、包和 data 不参与 Tree Hash，远端省略它们不产生 pending、删除或“未完整应用”。
- [ ] 当前设备版本低于 minimumTargetAppVersion 时整棵 Tree 标为 incompatible，不部分应用。
- [ ] 插件 JS、CSS 和新增插件显示高风险确认，不自动启用未知插件。

### 快照归并与发布

- [ ] 一个 Config Commit 只发布一个完整 ConfigTree 引用。
- [ ] 配置 dirtyIntent/basisHeads 绑定 projected ConfigTree 头，不采用新 observedHeads。
- [ ] 同 Tree Hash 采用，异 Tree Hash 并发形成快照级冲突。
- [ ] 提供纯函数配置树 diff 和 merge builder；合并结果发布 parents=全部操作时头。
- [ ] 配置头超过 parent 上限时使用与 Vault 相同的安全归约链。
- [ ] 首次本地/远端配置不同使用本地根快照形成冲突，不自动覆盖。

### 批量应用

- [ ] 所有 ConfigTree/Blob 先完整下载、校验和暂存。
- [ ] 生成新增、修改、删除、停止管理、代码变化和敏感项差异。
- [ ] 用户确认前不写正式配置。
- [ ] 破坏性计划要求当前完整逻辑 Tree 等于 projected Tree；不同则固定配置 dirtyIntent。当前 Tree 已等于远端且无 dirtyIntent 时只做无写入采用。
- [ ] 写入前重新验证全部本地前像；任一路径变化使整批计划失效。
- [ ] 写入前重新验证配置 observedHeads 和 RepositoryLocator；任一变化使整批计划失效。
- [ ] 创建完整恢复快照和批量 ApplyJournal。
- [ ] 插件包先于启用列表写入；已加载插件要求停用或明确接受风险。
- [ ] 每个配置文件继续执行安全前像守卫；中途失败时回滚已写项目。
- [ ] 回滚逐文件验证本批次后像；并发改写时保持活动路径原样并停止该 Journal group，旧前像留在恢复区，不为恢复批次而移走新编辑。
- [ ] 配置 delete/put 形状变换按 Journal group 排序；计划外子项形成不同本地 Tree，不被当作空目录清理。
- [ ] 中断后整批续做或回滚；回滚不完整时保持 recovery-required 并停用配置发布/应用。
- [ ] 重载后重建逻辑 ConfigTree 验证实际结果；完整成功前不更新配置 projectedHeads。

### 测试

- [ ] 两个并发 ConfigTree 不按文件静默混合。
- [ ] 插件包额外资源完整传输，data.json 默认缺席。
- [ ] profile 移除路径不会删除接收端文件。
- [ ] 远端 Tree 省略本地额外文件时不会把它删除或错误标记为已采用远端快照。
- [ ] 已建立基线后的显式 config delete 能传播并恢复。
- [ ] 根 ConfigTree 含 delete 被拒绝；非根 delete 缺父时保持 pending，全部直接父都未管理逐字节相同 path 时隔离，至少一个直接父已管理时可传播。
- [ ] 配置枚举/读取失败、扫描取消、范围变化和瞬时缺失都不生成 config delete 或可发布候选 Tree。
- [ ] 扫描期间写入、预览后变化和多文件应用崩溃均安全。
- [ ] 自定义 configDir、同步插件自保护、版本下限和 desktop-only 永不进入 portable Tree 测试。
- [ ] historicalConfigDir 位于 current 内/外/祖先三种关系都按冻结通道规则排除；descriptor 外本机历史根阻止接入而不是单机悄悄忽略。
- [ ] 设备本地插件的启用、包或 data 变化不改变便携 Tree Hash，也不造成永久 pending config 状态。
- [ ] 桌面或移动端改写 `core-plugins.json` 不改变便携 Tree Hash、不产生 DirtyRecord 或 pending config。
- [ ] 批量失败后回滚期间发生本地编辑时，新字节保持可达且 projectedHeads 不前进。
- [ ] 合法但未确认的远端插件代码不会落入自动加载路径。

验收门：配置以完整树为并发单位，可预览、可恢复、默认不执行远端代码或静默覆盖本地配置。

## 11. 核心 UI、状态与诊断

依赖：任务 7、8、9。配置专用 UI 不属于本任务。

- [ ] 状态栏显示恢复、扫描、拉取、验证、上传、应用、冲突和等待重试。
- [ ] 提供“立即同步”“仅预览”“完整校验”“查看 Vault 冲突”。
- [ ] “完整校验”展示对象覆盖率、缺失闭包和中断续检；未完成或失败不显示仓库完全健康。
- [ ] 展示最后成功拉取、发布、完整审计、pending apply、Outbox、LocalConcurrentRecord、恢复文件/post-capture edit 和提交缺口。
- [ ] 每轮展示逐路径决策：相同、本地 put、远端 put、墓碑、冲突、忽略、unknown。
- [ ] 错误区分认证、网络、限流、完整性、仓库身份、本地路径和冲突。
- [ ] 提供指数退避倒计时和手动重试。
- [ ] 导出脱敏诊断包；默认 Hash 化路径，不含凭证和正文。
- [ ] 高风险克隆/新世代操作显示 repositoryId、Prefix、对象数量、大小和恢复位置。
- [ ] 仓库损坏、anchor 缺失和状态丢失只能进入诊断/重新接入，不提供“一键清空后重传”。

验收门：不打开开发者控制台即可回答当前阶段、失败原因、重试状态和受影响路径。

## 12. 配置 UI 与信任确认

依赖：任务 10、11。

- [ ] 提供 ConfigProfile 编辑器，声明最低目标 Obsidian 版本，并区分 base、主题、snippets、便携/设备本地插件、插件包和 plugin data。
- [ ] profile 变更明确显示“停止管理”与“传播删除”的差异。
- [ ] 展示本地/远端 ConfigTree、快照头和逐文件 diff。
- [ ] ConfigTree 冲突提供“选本地树”“选远端树”“生成合并树”。
- [ ] 插件代码变化展示插件 ID、版本、来源 writer 和兼容性。
- [ ] `data.json` 启用前显示明文远端存储和启发式检测局限。
- [ ] 配置应用要求显式确认、恢复位置和停用/重载提示。
- [ ] 配置 pending、冲突和应用失败不显示为普通网络失败。

验收门：用户能明确知道哪些配置和代码将被写入、哪些仅停止管理、哪些会删除，并可在写入前退出。

## 13. 性能与大仓库

依赖：任务 7、10 稳定后。

- [ ] 建立 1 万、10 万小文件，大附件和高频配置基准集。
- [ ] 验证冻结的 Chunk 上限可让大型 bootstrap 单 Commit 发布且移动端内存受控。
- [ ] 限制 Hash、上传、下载并发，记录桌面和移动端内存峰值。
- [ ] 大文件流式读取、Hash、暂存和上传；超限路径可解释隔离。
- [ ] Blob 存在性缓存失效时回退 GET/Hash，不影响发布正确性。
- [ ] 完整审计支持进度、取消和空闲分片；取消不产生删除证据。
- [ ] 设计 checkpoint 状态根和 writer frontier 验证；无法验证时不允许新客户端跳过历史。
- [ ] checkpoint/latest/device-head 全部是可删除缓存，不参与正确性。

验收门：目标规模不阻塞 Obsidian 主线程，性能缓存损坏不改变逻辑状态。

## 14. 空间统计与仓库维护

依赖：任务 4、5、7、8；大规模优化依赖任务 13。

- [ ] 统计活跃、冲突、历史和孤儿 Blob/Tree/Chunk/Commit 大小。
- [ ] 展示去重节省、历史增长和供应商请求成本。
- [ ] 识别 Commit 发布前孤儿，但 v1 不自动删除。
- [ ] 禁止对全部协议对象使用按 LastModified 自动过期。
- [ ] 实现新 repositoryId 世代计划：冻结源计划、新 descriptor 继承旧 current/histories 与参与设备已知历史并集、写新世代、验证树和 Hash、迁移设备、保留旧世代。
- [ ] 新增历史排除根与源世代 Vault 头重叠时列出全部受影响版本并阻断，用户迁移/导出前不得从新世代静默省略。
- [ ] 新世代迁移或任何维护删除前强制完成源/目标可达对象完整校验。
- [ ] 正常设备凭证不需要 DeleteObject；维护删除使用独立权限和二次确认。
- [ ] 无锁原地 GC 在真实多设备故障证明前不得实现。

验收门：任何空间操作都有旧世代回滚路径，不会删除活跃或冲突唯一内容。

## 15. 发布安全审计

依赖：任务 0 至 12 的发布功能。

- [ ] 提供普通同步最小权限 S3 Policy，不包含协议根 DeleteObject。
- [ ] 提供可选 probe/维护权限 Policy，限制到独立 Prefix。
- [ ] 日志、Notice、错误堆栈和诊断包不泄露 secret、正文或敏感配置值。
- [ ] UI 明确 v1 可信写入者假设、路径/字节应用层明文、无签名、无 E2EE 和插件代码执行风险。
- [ ] 对所有远端 JSON 执行对象字节、字符串字节、层级、通用/专用数组和 parent 数量限制，并在构造完整对象图前尽早拒绝。
- [ ] 对路径穿越、别名、保留目录、超长 Key、畸形 Unicode 和重复 JSON Key 做模糊测试。
- [ ] 对固定 Unicode case-fold 表、UTF-8 数组排序和路径段前缀冲突运行跨运行时一致性测试。
- [ ] 未知字段、未来协议版本和不规范 JSON 默认拒绝。
- [ ] 检查依赖体积、供应链漏洞、许可证和移动端兼容性。
- [ ] 审核本地状态目录、插件自身和凭证在自定义 configDir 下的永久排除。

验收门：畸形对象最多导致相关寄存器隔离；合法远端插件代码只有用户明确确认后才进入可执行位置。

## 16. 故障模拟与发布验收

依赖：任务 1 至 15 中计划进入发布的功能。

- [ ] 多客户端确定性模拟器控制提交乱序、重复、晚可见、掉线、重启和所有本地 I/O 边界。
- [ ] 自动覆盖 `design.md` 第 21 节全部冻结验收场景。
- [ ] 随机运行创建、编辑、删除、rename、离线、重连、冲突解决和配置快照操作。
- [ ] 每轮验证：已发布内容可达、无静默胜者、客户端最终头集合一致、pending 不丢失。
- [ ] 真实 S3 执行大型 bootstrap、中断续传、第三客户端克隆、仓库世代隔离和 ConfigTree 恢复。
- [ ] 桌面和移动端执行启动、挂起、恢复、插件更新和卸载/重装演练。
- [ ] 删除本地操作状态：空 Vault 从远端重建，非空 Vault 强制非破坏性接入。
- [ ] 制作协议兼容表和“不支持旧原型原地升级”的发布说明。

最终验收：

- [ ] 编辑基线永远来自 projectedHeads。
- [ ] Outbox 可逐字节重放，sequence 不跳过或复用。
- [ ] 任意本地应用竞态不丢弃字节。
- [ ] 任意本地不确定缺失不产生墓碑。
- [ ] 两设备并发不会静默覆盖内容、删除意图或完整配置树。
- [ ] 第三客户端继承 Vault 和 ConfigTree 冲突。
- [ ] 首次接入、状态丢失和新世代迁移默认不覆盖、不删除。
- [ ] 用户可手动同步并关闭任意自动调度。

## 17. 里程碑

### M0：协议冻结

- [x] 三份指导文档完成语义交叉复核，`design.md` 状态改为“v1 协议设计基线已冻结”。
- [x] 完成任务 0。
- [x] 固定 Schema、上限和测试向量进入版本控制。

### M1：协议证明

- [ ] 完成任务 1 至 4。
- [ ] 纯内存三客户端模拟通过。
- [ ] 删除本地数据库后可从远端测试向量重建相同状态。

### M2：安全同步内核

- [ ] 完成任务 5 至 7。
- [ ] 两台测试 Vault 可同步普通文件、墓碑和离线变化。
- [ ] editor-change、Outbox 和本地应用崩溃测试通过。

### M3：Vault 产品闭环

- [ ] 完成任务 8、9、11。
- [ ] 仓库向导、手动/自动同步、Vault 冲突解决和诊断可用。
- [ ] 第三客户端冲突传播验收通过。

### M4：配置快照

- [ ] 完成任务 10、12。
- [ ] 插件、主题和选定配置以完整树方式预览、冲突、应用和恢复。
- [ ] 插件代码、敏感 data.json 和第三方运行期限制有明确交互。

### M5：发布加固

- [ ] 完成任务 13 至 16 中发布必需项。
- [ ] 完成真实供应商、桌面和移动端验证。
- [ ] README、协议兼容表、灾难恢复和安全边界与实现一致。
