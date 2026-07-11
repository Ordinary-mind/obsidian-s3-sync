# Obsidian S3 Sync v1 设计

> 状态：v1 协议设计基线已冻结（2026-07-11 文档审查）；任务 0 的机器可读 Schema、固定测试向量和测试底座进入版本控制前，仍禁止实现同步核心。
>
> 核心原则：可靠优先于“看起来实时”；任何不确定状态都不静默覆盖、删除或伪装成已合并。

## 1. 结论与边界

### 1.1 是否需要自建服务端

个人、多设备、最终一致的 Vault 同步可以只使用 Obsidian 插件和 S3 Compatible Storage，不需要业务服务端。

S3 负责持久化，插件负责：

- 内容寻址 Blob。
- 不可变提交日志。
- 本地持久队列和崩溃恢复。
- 按逻辑对象维护多版本头。
- 显式冲突、删除和配置应用。

服务端只能额外提供推送、账号系统、集中式事务、后台任务和统一维护；它不是个人文件同步正确性的必要条件。

纯插件的边界：

- Obsidian 关闭或移动端被挂起时不能继续同步。
- 没有推送服务时，远端变化依靠启动检查、轮询或手动同步发现。
- 插件不能通用保证在所有第三方插件之前应用配置，也不能保证第三方插件运行中接受配置替换。
- 插件能观察 Obsidian 的编辑事件和已落盘字节，但无法保证保存从未落盘的编辑器缓冲区，也无法对任意外部进程提供跨平台文件系统 CAS。
- 因此普通 Vault 文件可自动同步；配置采用完整快照、差异预览、显式应用和重载生效。

### 1.2 v1 信任模型

v1 假定 Bucket、S3 管理员和所有拥有写权限的客户端均可信。

- SHA-256 提供内容寻址和意外损坏检测，不提供作者认证。
- Vault 字节、配置字节和逻辑路径在应用层均为明文；HTTPS 和 S3 服务端加密不等于端到端加密。
- 拥有仓库写权限的一方可以创建新的合法提交。
- 同步社区插件代码意味着仓库写权限可以间接成为代码执行权限。
- v1 不宣称端到端加密、提交签名或对恶意仓库写入者的防护。
- 畸形或损坏的对象必须被拒绝，但“结构合法且来自可信仓库”的配置内容仍由用户决定是否应用。

若以后需要不信任存储端，应在新协议版本中加入设备公钥、签名和加密，不能给 v1 后补一个 UI 开关假装兼容。

## 2. 目标与非目标

### 2.1 目标

- 原始字节 SHA-256 是内容变化的唯一依据；`mtime` 和 size 只能安排检查。
- 笔记、附件、主题、插件包和明确选择的配置可跨设备收敛。
- 正常远端同步只写不可变对象，不覆盖全局 manifest。
- 不按设备时间、上传顺序或跨设备 sequence 选择胜者。
- 删除是显式墓碑，冲突是可传播的远端状态。
- 本地编辑基线、待发布内容和本地替换过程都能跨重启恢复。
- 网络中断、请求重放、S3 List 延迟和进程崩溃最多导致重试或显式冲突。
- 首次接入、状态丢失和仓库切换均走非破坏性流程。
- 每次同步可解释：展示检查、上传、下载、跳过、冲突、等待和失败原因。

### 2.2 非目标

- 不做字符级协同编辑或 CRDT 编辑器。
- 不保证 Obsidian 关闭后继续运行。
- 不保证任意第三方插件热加载被替换的 `data.json`。
- 不保留空目录；需要保留时使用 `.keep` 文件。
- 不保留文件权限、所有者或原始 `mtime`。
- 不把 S3 控制台作为可直接编辑的 Vault 文件树。
- MVP 不做自动、无锁、原地历史 GC。
- v1 不兼容旧原型的 `.s3-sync/manifest.json`。
- 同一个本地 Vault 被多个 Obsidian 进程同时打开不属于受支持场景；能检测时进入只读诊断，不能检测时远端 writer 分叉仍必须安全暴露。

## 3. 核心术语与状态分离

每个 Vault 路径和“便携配置”都称为一个逻辑寄存器。正确性依赖以下状态不能混用：

| 状态 | 含义 | 允许何时变化 |
| --- | --- | --- |
| `observedHeads` | 已验证远端日志计算出的最新头 | 拉取并验证远端提交后 |
| `projectedHeads` | 当前本地字节实际代表的远端头 | 本地安全应用完成，或确认本地字节与远端语义值相同时 |
| `projectedValue` | `present(hash)` 或 `absent` | 与 `projectedHeads` 同一事务更新 |
| `dirtyIntent` | 已观察到编辑行为，但字节可能尚未稳定 | 首次 editor/Vault 事件时立即创建 |
| `DirtyRecord` | 已确认的本地 put/delete 及固定父版本 | 稳定读取或确认删除后创建 |
| `LocalConcurrentRecord` | editor 待落盘期间，适配器可证明来自 editor lineage 之外的另一磁盘值/删除意图 | 立即暂存并阻断该路径，直到用户选择或合并 |
| `localPredecessorVersion` | 当前 generation 紧接的同路径本机冻结 Outbox 版本 | 前一 generation 冻结后创建后续 generation 时一次性固定 |
| `OutboxCommit` | 已冻结、可逐字节重放的待发布提交 | 发布前一次性创建，之后不可改写 |
| `PublishedReconcile` | Commit 已验证可读、但本地值是否仍等于已发布值尚待证明 | 发布记账时创建，Hash/Tree 守卫完成后解决 |
| `ApplyJournal` | 本地应用的预期前像、暂存、恢复和阶段 | 每个破坏性 I/O 前先持久化 |

强制规则：

- `basisHeads` 只能复制自当时的 `projectedHeads`，绝不能来自更新后的 `observedHeads`。
- `localPredecessorVersion` 只能引用同一本地因果队列、同逻辑寄存器、前一冻结 Outbox 中的精确 Version ID；writerId 因 fork 或 sequence 上限轮换时该引用仍有效。它不能改指任意远端版本，也不能吸收新拉到的 observedHeads。
- 仅拉取远端提交不得改变 `projectedHeads`。
- 仅 Hash 相同还不足以重建父版本；必须持久化完整 `projectedHeads` 集合。
- 多个等价头代表相同语义值时，`projectedHeads` 必须包含当时已实际采用的全部等价头。

## 4. 必须始终成立的安全不变量

1. 相同字节必定得到相同 SHA-256；只改 `mtime` 不产生版本。
2. 正常同步只写不可变对象；可变索引即使存在也只能是缓存。
3. Blob、配置树和 Change Chunk 先上传，Commit 最后上传；Commit 是唯一远端可见边界。
4. 所有下载对象都按 Key 和正文重新计算 Hash，验证前不得影响正式路径。
5. S3 List 中没看到对象不等于用户删除；远端删除只来自墓碑。
6. 本地观察结果必须区分 `present`、`confirmed-absent`、`unknown/error` 和 `out-of-scope`。
7. 没有共同基线时，本地缺失和远端缺失都不推断为删除。
8. 本地第一次可观察编辑时立即固定 `basisHeads = projectedHeads`；以后拉到的新头不能被冒充为父版本。前一 generation 已冻结时，后续 generation 只能改为继承其精确本机 Version ID。
9. Outbox 必须保存待上传的确切字节或其不可变本地暂存引用，Hash 不能代替内容。
10. 已分配的 writer sequence 必须发布同一个冻结 Commit；不能跳过、复用或换内容。
11. 应用远端内容前必须检查本地前像、dirty generation 和编辑意图；任何不一致都转为本地并发修改。
12. 插件不能依赖一次“检查后写入”；破坏性操作必须先持久化 Journal，并保留实际被移走的本地字节。
13. 对本地覆盖或删除前，当前字节必须已有可验证远端 Blob，或已进入本地恢复区。
14. 路径应用失败不得因远端 frontier 前进而丢失；失败项必须保持为持久化 pending apply。
15. 本地状态丢失或仓库身份变化时进入非破坏性重新接入，不自动重建基线。
16. 插件凭证、writerId、本地状态、Outbox、暂存和恢复目录永不进入任何同步范围。
17. 配置快照是一个完整树版本；不得把两个并发快照按文件静默拼成混合配置。
18. 任何有效父版本引用都必须最终解析到同一仓库、同一逻辑寄存器的已验证版本；否则相关提交保持隔离。
19. 大小写别名和文件/目录前缀碰撞不得按平台能力静默选边；不能同时物化的远端路径必须保持为显式结构冲突。

## 5. 总体架构与两条通道

```text
Obsidian editor-change / Vault 事件 / 手动同步 / 定时审计
                            │
                            ▼
               本地观察器与稳定读取器
                            │
              projectedHeads / SHA-256
                            │
                            ▼
       本地状态库 + 内容暂存 + Durable Outbox
                            │
                            ▼
                单实例同步协调器
                  │                    │
                  ▼                    ▼
          S3 不可变协议层         本地安全应用器
      Blob/Tree/Chunk/Commit    Journal/恢复/前像守卫
```

核心状态机必须是与 Obsidian、AWS SDK 无关的纯 TypeScript 模块。Obsidian 文件系统、编辑器事件和 S3 都通过接口适配，测试可控制乱序、掉线、重启和每一个 I/O 边界。

### 5.1 Vault 文件通道

- 逻辑身份为 `vault:<规范化 Vault 相对路径>`。
- RepositoryDescriptor 的当前 configDir 与全部 historicalConfigDirs 整体不属于 Vault 文件通道；当前 configDir 只通过配置通道处理。
- Markdown 编辑器的 `editor-change` 用于尽早创建 `dirtyIntent`，避免尚未落盘的编辑被远端应用越过。
- editor 来源的 dirtyIntent 带 `awaitingLocalWrite` 门闩；反复读到旧磁盘 Hash、任意较晚 Vault 事件或等待超时都不能清除它。只有适配器能把同路径稳定磁盘字节与未变化的 editor generation 精确对应，或明确证明该 generation 已无待落盘内容时才能解除。
- 门闩期间反复读到原 projectedValue 只是“尚未 autosave”。任何其他稳定磁盘值先进入 dirtyIntent 的不可变 localCandidates；如果它匹配某个已记录 editor generation，则只是正常中间 autosave。仅当适配器有来源证据证明某候选/delete/rename 不属于 editor lineage 时，才把它与当时 editor 候选升级为 LocalConcurrentRecord；不能仅因它不等于“最新” editor buffer 就判并发。候选共享门闩创建时的 basisHeads，互相不得成为 localPredecessor。
- `awaitingLocalWrite=true` 时该路径不得冻结进 Outbox；手动同步只报告“等待编辑器落盘”，其他路径可继续。未变化的最新 editor generation 与稳定磁盘字节精确匹配，或适配器证明已无待落盘 buffer 后，才以最终稳定磁盘值创建/更新 DirtyRecord。未被选为最终值的 localCandidates 保留到该 DirtyRecord 发布并完成 PublishedReconcile 后，再按可见的本地恢复保留策略清理。
- Vault create/modify/delete/rename 事件立即持久化路径、generation 和当时的 `projectedHeads`。
- 外部程序或插件关闭期间的变化由启动对账和低频完整审计发现。
- 稳定读取确认字节后，`dirtyIntent` 才升级为带 Hash 的 `DirtyRecord`。
- 连续保存按路径合并；一旦内容已冻结进入 Outbox，后续编辑使用新的 generation，并固定该 Outbox 中同路径 Version ID 为本地前驱。
- 本地新建文件的根 put 已冻结后又被确认删除时，仍必须逐字节发布已冻结 put；删除只记录为等待前驱发布的后续意图。该 put 经 GET/Hash 验证已发布后，delete generation 的唯一 parent 才是其固定 `localPredecessorVersion`；不得把两次变化抵消、绕过未发布 put 或生成 `parents=[]` 的根墓碑。

`editor-change` 只能保护插件可观察到的编辑会话。进程崩溃前从未落盘的缓冲区不属于同步插件可以持久化的数据。

### 5.2 配置快照通道

- 逻辑身份固定为 `config:portable`，它是单个多版本寄存器，不与 Vault 路径寄存器混用。
- 配置路径相对于当前设备的 `vault.configDir` 保存，远端不硬编码 `.obsidian`。
- 一个配置版本引用完整的内容寻址 `ConfigTree`，而不是把配置文件分别当作独立胜负单位。
- 两个并发配置树即使只修改不同文件，也先形成快照级冲突；用户预览后可生成一个合并树解决。
- 远端提交只提供原子发布；多文件本地应用是可恢复事务，不宣称跨平台运行时原子。
- 远端配置自动下载并暂存，但永不自动应用。

## 6. 仓库身份与物理布局

### 6.1 Repository Locator

本地绑定仓库时必须持久化：

```ts
interface RepositoryLocator {
  endpoint: string;
  region: string;
  forcePathStyle: boolean;
  bucket: string;
  normalizedPrefix: string;
  protocol: 1;
  repositoryId: string;
  configDir: string;
  historicalConfigDirs: string[];
  descriptorHash: string;
}
```

- `repositoryId` 是由密码学安全随机源生成的 UUIDv4，小写连字符规范格式。
- `endpoint` 固定为 WHATWG URL 规范化后的 S3 origin：生产仅允许 HTTPS，不含 userinfo/query/fragment，path 只能是 `/` 并在持久化时移除末尾 `/`；显式测试模式可允许 loopback HTTP。`region` 是匹配 `[A-Za-z0-9._-]{1,128}` 的 signing region，`forcePathStyle` 是显式布尔值，三者都不能在请求时临时猜测。
- `bucket` 在去除首尾 ASCII whitespace 后必须是 1 至 255 个 UTF-8 bytes，禁止 `/`、`\\`、C0/DEL 控制字符和空值；其余供应商规则由连接 probe 验证。持久化后大小写和字节不再折叠，bucket 精确字符串属于仓库身份。
- Prefix 可以在向导中根据 Vault 名称提出建议，但确认后保存确切规范值；Vault 改名不得改变已绑定 Prefix。
- `normalizedPrefix` 先按第 7.1 节固定 Unicode 15.1.0 做 NFC，再移除首尾 `/`；空 Prefix 合法，非空时禁止空段、`.`、`..`、反斜杠、C0 `U+0000..U+001F` 和 DEL `U+007F`，不折叠大小写。连接向导必须验证拼接后的每一种 v1 对象 Key 都不超过 S3 的 1,024 UTF-8 bytes。
- `configDir` 是创建仓库时实际 `vault.configDir` 的规范 Vault 相对目录路径；同一 repositoryId 的所有设备必须完全一致，以免 Vault channel 与 config channel 在不同设备重叠。
- `historicalConfigDirs` 来自 RepositoryDescriptor，保存该仓库世代必须共同排除的旧配置根；所有设备即使本机从未使用过也必须从 Vault channel 排除它们。本机另有未列入的历史配置根时不得加入，必须创建包含并集的新 repositoryId。
- `descriptorHash` 是已验证 `format.json` 规范字节的 SHA-256；它必须与 RepositoryDescriptor、ConfigTree、Change Chunk 和 Commit 的仓库绑定一致。
- endpoint、region、forcePathStyle、bucket、Prefix、协议版本、repositoryId、configDir、historicalConfigDirs 和 descriptorHash 共同参与本地仓库指纹。endpoint/region/path-style 变更必须先停协调器，以候选连接直接 GET 同一 format.json，并对 descriptor 与全部已知 writer branch-tip anchors 执行正文/Key/Hash 验证；成功后才可原子替换传输定位并恢复既有队列。bucket/Prefix/repositoryId/descriptor 变化仍走重新接入。
- 凭证或 secret-provider 引用属于本机认证配置，不进入 RepositoryLocator/仓库指纹；轮换凭证也必须暂停请求并重新验证 descriptor/anchors，但不会因此重建本地因果状态。
- Outbox、frontier、projection 和 writer 链都绑定该指纹，不能跨仓库复用。

### 6.2 无 CAS 的并发初始化

物理根路径包含 `repositoryId`，不使用一个可争抢的全局“当前仓库”指针：

```text
<prefix>/.obsidian-s3-sync/v1/repositories/<repository-id>/
```

`normalizedPrefix` 为空时根 Key 精确以 `.obsidian-s3-sync/` 开头，不添加前导 `/`；非空时只在 Prefix 后添加一个 `/`。所有 Key builder 共用这一连接规则，不能各自 trim 或 URL 编码后再参与身份判断。

Blob、ConfigTree 和 Change Chunk 路径中的 `ab` 固定为对应 64 个小写十六进制 Hash 字符的前两个字符。

- 第一台设备生成 repositoryId；其他设备通过仓库列表或导出的非秘密 locator 选择它。
- 仓库发现只把 `.../repositories/<canonical-uuidv4>/format.json` 这一精确深度的 Key 当作候选；对每个候选直接 GET，并在 descriptor 的 repositoryId、Key 段、Schema 和 Hash 全部一致后展示。更深对象、畸形 ID、缺失/非法 descriptor 只进入诊断，不算空仓库、不会自动修复或删除。
- 只有创建者写入 `format.json`；加入设备只 GET 并验证，不把“暂未读到 descriptor”当成空仓库自行补写。多个加入设备可以同时验证和 bootstrap，使用的 descriptor 字节必须完全相同。
- 两台不知道彼此的设备并发“新建”时会得到两个独立 repositoryId，不会覆盖；向导之后列出两个仓库并要求用户选择或非破坏性合并。
- 新一代仓库使用新 repositoryId；旧设备仍绑定旧仓库，不会污染新一代。
- 创建 `format.json` 必须使用 `If-None-Match: *` 或供应商证明等价的原子“仅不存在时创建”。条件失败后 GET 并逐字节验证，相同视为幂等成功、不同为完整性错误。缺少该能力的 ObjectStore 不得创建或发布 v1 仓库，无条件 PUT + 事前 HEAD 不能冒充不可变写入。
- 同一 repositoryId 下任何已观察不可变对象经重试后仍无法直接 HEAD/GET 时视为仓库损坏，停止发布，不把它当作空仓库重新初始化；一次 List 缺失本身不是损坏证据。
- 空仓库以 RepositoryDescriptor 为 anchor；一旦观察到 Commit，本地同时保存每个已知 writer 的连续 frontier 分支 tip Hash 集合，并在发布前直接 GET 每个 anchor、验证 Key 与正文 Commit Hash。HEAD、ETag 或“能读到某对象”不能代替正文 Hash。正常 writer 只有一个 tip，分叉 writer 保留全部已知分支 tip。

### 6.3 物理对象布局

```text
<prefix>/.obsidian-s3-sync/v1/repositories/<repository-id>/
  format.json
  blobs/sha256/ab/<64-hex>
  config-trees/sha256/ab/<64-hex>.json
  changes/sha256/ab/<64-hex>.json
  commits/<writer-id>/<20-digit-sequence>-<64-hex>.json
  checkpoints/<checkpoint-id>.json             # v1 后续优化
```

`checkpoints/` 只是保留的非权威缓存命名空间；冻结的 v1 MVP 不读、不写，也没有 checkpoint 对象 Schema。以后加入的缓存必须可整体删除，不能成为发现 Commit 或证明完整性的必要条件。

`format.json` 的规范结构固定为：

```ts
interface RepositoryDescriptor {
  protocol: 1;
  repositoryId: string;
  configDir: string;
  historicalConfigDirs: string[];
  hashAlgorithm: "sha256";
  canonicalJson: "RFC8785";
}
```

它不含时间、设备名或可变 head，因而同一仓库的创建重试幂等。configDir 和 historicalConfigDirs 使用第 14 节 Vault 路径规范；configDir 必须非空，历史数组按 UTF-8 bytes 排序、逐字节去重并 case-fold 唯一，且不得包含与当前 configDir case-fold 相等的值。创建者按第 6.2 节写入，加入者只读验证；本机实际 configDir 不匹配、或本机已知历史根不是 descriptor 集合的逐字节子集时不得绑定该仓库。其规范字节 Hash 是本仓库唯一合法的 descriptorHash；远端 descriptor 字节变化、或任一 Tree/Chunk/Commit 声明不同 descriptorHash 时停止该仓库发布和应用，新客户端也不得按替换后的 descriptor 重解释旧提交。

## 7. v1 线协议

### 7.1 规范编码与 ID

- JSON 使用 UTF-8、无 BOM，并按 RFC 8785 JSON Canonicalization Scheme 编码。
- RepositoryDescriptor、ConfigTree、Change Chunk 和 Commit 的 Hash 是各自完整规范 JSON 字节的 SHA-256；Blob Hash 是原始 Blob 字节的 SHA-256。所有 Hash 均为 64 个小写十六进制字符，词法形式固定为 `[0-9a-f]{64}`。
- JSON 数字必须是有限安全整数；不得使用 NaN、Infinity、负零或浮点协议字段。
- `writerId` 和 `repositoryId` 使用 CSPRNG 生成的 UUIDv4，小写连字符形式必须匹配 `[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`。
- writer sequence 是从 1 开始的 20 位零填充十进制字符串，线上按字符串保存和排序。
- 规范路径先做 NFC；协议数组的字符串排序固定为 UTF-8 无符号字节字典序，不使用 locale。historicalConfigDirs、parents、插件 ID 和 baseFiles 直接按该规则排序；ConfigItem 和 Vault Mutation 按规范 path 排序；`changeChunkHashes` 例外，按 chunkIndex 排列。
- NFC 规范化和大小写别名键都固定在 Unicode 15.1.0 数据；别名键使用该版本 Default Case Folding 的 C/F 映射后再做同版本 NFC。实现不得直接信任宿主运行时 Unicode 版本；这些规则只用于规范路径/ID 与检测别名，不改变展示名。
- historicalConfigDirs、Mutation、parents、配置项和 ID 数组在编码前按协议规则排序并去重；数组顺序属于 Hash 的一部分，接收端必须拒绝非规范顺序。
- Version ID 使用 `<commit-hash>:<chunk-index>:<mutation-index>`，两个 index 从 0 开始且使用无前导零十进制；词法形式为 `[0-9a-f]{64}:(0|[1-9][0-9]*):(0|[1-9][0-9]*)`。index 还必须落在被引用 Commit 的实际 Chunk/Mutation 范围内，因此不依赖随机 commitId，也没有字符串拼接歧义。
- Key 中的 repositoryId、writerId、sequence 和 Hash 必须与正文完全一致。
- JSON 对象不得包含重复 Key；解析器不能依赖 `JSON.parse` 的覆盖行为接受重复字段。
- 字符串必须由合法 Unicode scalar value 组成；非法 UTF-8、未配对 UTF-16 surrogate 和非 NFC 的规范字段一律拒绝。

机器可读协议使用 JSON Schema Draft 2020-12。RepositoryDescriptor、ConfigProfile、ConfigTree、两种 Mutation、两种 ChangeChunk 分支和 Commit 都是封闭对象：Schema 使用 `additionalProperties: false`，除 `blobHash`/`size` 的 kind 条件字段外，接口中列出的字段全部 required；`previousCommitHash` 也是 required，只是允许 null。未知字段、未知 enum、未来 protocol/schema 值默认拒绝，不能忽略后继续归并。

接收端验证顺序固定为：

1. 在分配完整对象图前限制正文 bytes，并以有界 UTF-8/JSON 解析器检查 BOM、非法编码、重复 Key、字符串 bytes、数组元素数和嵌套深度。
2. 将解析值重新按 RFC 8785 编码；所得字节必须与输入逐字节相同，否则拒绝非规范 JSON。
3. 执行封闭 JSON Schema，以及 UUID、Hash、sequence、时间、SemVer、路径和 Version ID 的格式校验。
4. 执行 Schema 无法表达的排序/去重、profile 覆盖、kind/channel 字段组合、Key/Hash/descriptorHash 一致性和跨 Chunk/Commit/parent 图校验。

嵌套深度以根 JSON object 为 1，每进入一个 object 或 array 加 1；属性名和字符串值都受字符串 UTF-8 bytes 上限约束。资源上限在任何 Hash、Key 或业务语义判断之前生效，专用上限优先于通用上限。

v1 固定资源上限：

| 对象或字段 | v1 上限 |
| --- | --- |
| `format.json` 规范字节 | 4 KiB |
| Commit 规范字节 | 256 KiB |
| 单个 Change Chunk 规范字节 | 4 MiB |
| 单个 Change Chunk Mutation 数 | 4,096 |
| 单个 Commit 的 Chunk 数 | 1,024 |
| ConfigTree 规范字节 | 16 MiB |
| ConfigTree item 数 | 100,000 |
| 单个 Mutation parent 数 | 1,024 |
| JSON 最大嵌套层级 | 16 |
| 任意协议 JSON 数组元素数 | 100,000 |
| 任意协议 JSON 字符串解码后 UTF-8 字节数 | 4 KiB |
| 逻辑路径 UTF-8 字节数 | 1,024 |
| Blob 协议大小 | 5,000,000,000 bytes |

sequence 的合法范围为 1 至 `18446744073709551615`，线上始终编码为 20 位字符串并使用 BigInt/十进制字符串比较，绝不能转成可能丢精度的 Number。chunk/mutation index 使用无前导零的十进制安全整数。通用数组上限不能放宽 parents、mutations、chunks 或 items 的更小专用上限。KiB/MiB 分别按 1,024/1,048,576 bytes 计算。v1 不实现 multipart upload；实现平台可以声明更低的 Blob 上限，但必须隔离超限路径并继续同步其他路径。

协议实现必须提供固定测试向量，至少覆盖 RepositoryDescriptor/configDir/historicalConfigDirs/descriptorHash、空仓库、两个 channel 的全部 Commit kind、Vault put/delete、Unicode case-fold、ConfigTree 便携插件边界、多 Chunk Commit、parent-reduction、writer 分叉、路径结构冲突和各类超限/非法对象。大型上限不得靠提交巨型 fixture：使用确定性生成配方、计数流和预期 Hash/错误，分别验证“恰好等于上限”和“超过 1”。

### 7.2 Blob

- Key 由原始文件字节 SHA-256 决定。
- 正文保存原始字节，不以 ETag 代替 Hash。
- 上传前后都验证正文 Hash；相同 Key 只允许相同字节。
- 所有 Blob/Tree/Chunk/Commit 必须通过 PutImmutable 原子条件创建；条件失败后 GET 并比对正文，相同视为幂等成功、不同为完整性错误。每次成功创建仍须 GET/Hash 验证，不能仅信任 PUT 响应或 ETag。
- 远端存在性缓存只能减少请求，发布前不得把缓存当作 Blob 真实可读的证明。

### 7.3 ConfigTree

```ts
interface ConfigProfile {
  schema: 1;
  baseFiles: string[];
  syncThemes: boolean;
  syncSnippets: boolean;
  minimumTargetAppVersion: string;
  portablePluginIds: string[];
  pluginPackages: string[];
  pluginData: string[];
}

interface ConfigItem {
  path: string;                 // 相对 vault.configDir
  kind: "put" | "delete";
  blobHash?: string;
  size?: number;
}

interface ConfigTree {
  protocol: 1;
  repositoryId: string;
  descriptorHash: string;
  profile: ConfigProfile;
  enabledCommunityPlugins: string[]; // 不包含本同步插件自身
  items: ConfigItem[];
}
```

- `descriptorHash` 必须等于当前已验证 RepositoryDescriptor 规范字节的 Hash。
- ConfigTree 是完整的显式管理决策集合，不是一次扫描差异；未出现的路径仍不隐含删除。
- `baseFiles` 只能包含用户明确选择且满足 Config path 单段规则的 config 根级普通文件名，不能包含 `/`。与 `community-plugins.json`、`core-plugins.json`、`plugins`、`themes`、`snippets` 或固定本地状态根 `.obsidian-s3-sync-local` 做 case-fold 比较后相同，或 case-fold 后同时以 `workspace` 开头、以 `.json` 结尾的名称均禁止。默认值见第 15.1 节。
- `minimumTargetAppVersion` 是所有声明目标设备中最低的 Obsidian 版本，规范格式固定为无前导零的 `MAJOR.MINOR.PATCH`；v1 不接受预发布或构建后缀。
- Obsidian 版本按三个十进制分量逐段数值比较，不按整个版本字符串或 locale 比较；每个无前导零分量先比较位数、位数相同再按 ASCII 比较，不能用可能丢精度的 Number。manifest 的 `minAppVersion` 不满足同一规范格式时，该插件不能进入便携集合。
- `baseFiles`、插件 ID、启用 ID 和 items 必须规范排序并逐字节去重；baseFiles 和每个插件 ID 数组还必须分别 case-fold 唯一，同一路径最多一个 ConfigItem。
- 插件 ID 必须是 NFC 后 1 至 255 UTF-8 bytes 的单个跨平台安全路径段，禁止 `.`、`..`、ASCII `< > : " / \\ | ? *`、C0 `U+0000..U+001F`、DEL `U+007F` 和尾随 ASCII 点/空格。取第一个 `.` 前的完整子串并只将其中 ASCII `a..z` 转为大写后，不得等于 `CON`、`PRN`、`AUX`、`NUL`、`CLOCK$`、`CONIN$`、`CONOUT$`、`COM1` 至 `COM9`、`LPT1` 至 `LPT9`、`COM¹` 至 `COM³` 或 `LPT¹` 至 `LPT³`；各插件 ID 数组内还必须 case-fold 唯一。
- `pluginPackages`、`pluginData` 和 `enabledCommunityPlugins` 必须都是 `portablePluginIds` 的逐字节子集；本同步插件 ID 及其任何 case-fold 别名不得出现在这四个数组中。
- ConfigItem 的 profile 覆盖关系固定如下；路径必须逐字节匹配规范 ID/文件名，不能用 case-fold 别名代替：`baseFiles` 只覆盖同名 config 根文件；`syncThemes=true` 覆盖 `themes/` 的严格后代；`syncSnippets=true` 覆盖 `snippets/` 的严格后代；`pluginPackages` 中的 ID 覆盖 `plugins/<id>/` 严格后代，但排除相对插件根 case-fold 后恰为 `data.json` 的根文件；`pluginData` 中的 ID 只覆盖精确路径 `plugins/<id>/data.json`。不满足其中恰好一个来源的 item 使整个 ConfigTree 无效。
- ConfigItem 映射到 current configDir 后，若按第 14 节 case-fold alias/段前缀规则落入某个作为 current 严格后代的 historicalConfigDir、固定本地状态根 `.obsidian-s3-sync-local` 或本同步插件目录 `plugins/obsidian-s3-sync`，整个 ConfigTree 无效；profile 不能重新纳入这些路径。Vault 根冲突区不在 Config path 命名空间内。
- `put` 必须引用 Blob；`delete` 是配置树内的显式删除意图。
- `put` 必须同时具有 blobHash 和 size；size 是 0 至 5,000,000,000 的 JSON 整数。`delete` 两者都不得具有。
- 每个 put 的 size 必须等于其 blobHash 所指原始 Blob 的实际字节数；Hash 正确但 size 不符仍使对应 ConfigTree 依赖无效，不能按声明值分配内存或写入。
- 两个 `put` item 不得具有相同 case-fold key，也不得存在严格的路径段前缀关系；`delete old + put new` 的大小写或文件/目录形状变换可以共存，并由安全批量应用器排序执行。
- 某路径不在 `items` 中表示“不由配置通道管理”，不表示删除。
- ConfigProfile 选中的目录范围会把其中所有现存普通文件构建为 put；接收端在同一范围发现远端 Tree 未提及的本地额外文件时，必须形成不同的本地 ConfigTree，而不是删除该文件或假装已采用远端 Tree。
- 用户若要移除该额外文件，合并后的新 Tree 必须包含显式 delete；若只想停止同步，则通过 profile 变更将它移出管理范围。
- 从 profile 移除某范围表示停止管理，默认保留接收端现有文件。
- 新增 delete 只能来自已建立配置基线后的确认删除，或用户在差异界面明确选择删除。
- 已有 delete item 在 profile 仍覆盖该路径且没有新 put 时必须由后继 ConfigTree 继续携带；扫描到 absent 不能自动丢掉墓碑。移除 delete item 等同显式停止管理，离线设备以后保留其本地旧文件，不再传播该删除。
- ConfigTree 对象本身不携带 parents，因此 delete 的因果合法性按引用它的 ConfigSnapshotMutation 版本判断：`parents=[]` 的根快照不得引用含任何 delete 的 Tree；parents 非空时，每个 delete path 必须在至少一个直接父版本的 Tree 中以逐字节相同 path 的 put 或 delete 被管理。任一父版本或父 Tree 未验证时该配置版本保持 pending；全部直接父依赖验证后仍没有父 Tree 管理该 path，则该配置版本无效，不能把 delete 当作首次缺失或凭空墓碑。
- 配置扫描只有在 profile 的全部范围都成功枚举、所有候选文件都完成稳定读取且 scopeRevision 未变化时才算完整；任一 unknown 都使整次候选 Tree 失效。对 projected Tree 中原有 put 的缺失还必须在防抖后直接复查，不能把扫描省略转换为 delete。
- `community-plugins.json` 不直接按原始文件同步；扫描时只提取 `portablePluginIds` 中当前启用的 ID。应用时以远端 `enabledCommunityPlugins` 替换本地便携子集，再与本地不在 `portablePluginIds` 中的 ID 和本插件 ID 合并。
- 生成启用列表或 package/data 应用计划前，若任一本地未管理插件 ID/目录与 portable ID 形成 case-fold alias，整棵配置应用进入结构冲突；不能静默去重、改大小写或选一边。
- `community-plugins.json` 的读取或 JSON/ID 校验失败会使整次配置扫描 unknown；只有 confirmed-absent 才可解释为本地启用集合为空，绝不能把解析错误当作“没有启用插件”。
- `community-plugins.json` 的本地输入和应用后合并输出都只接受最大 4 MiB 的 UTF-8 JSON 字符串数组，最多 100,000 个 ID；非法 UTF-8、BOM、重复 ID、超限、非数组/非字符串或 case-fold alias 都使扫描/计划 unknown，而不是截断。
- 不在 `portablePluginIds` 中的设备本地插件，其启用状态、包和 data 都不参与 ConfigTree Hash，也不能因为远端 Tree 未提及而形成待应用差异或删除。
- 社区插件包按目录级单元管理，包含包内静态文件和额外资源；包扫描必须排除相对插件根 case-fold 后等于 `data.json` 的路径，`data.json` 只能通过独立逐插件开关加入。
- `pluginPackages` 中某插件只要存在任一 put，就必须同时存在精确的 `plugins/<id>/manifest.json` put；接收端下载并解析该 manifest，验证 ID、version、minAppVersion 和 isDesktopOnly 后才允许应用包。仅有显式 delete 的已卸载包可以没有 manifest put。
- `enabledCommunityPlugins` 中同时属于 `pluginPackages` 的 ID 必须有上述 manifest put，不能在同一 Tree 中一边删除受管包一边要求启用。对未同步 package 的启用项或 pluginData put，目标设备必须已有兼容本地包，否则整棵 Tree 标为 incompatible，不创建半个插件目录。
- 本同步插件目录、本地状态目录、缓存、日志和恢复数据永久排除。

### 7.4 Change Chunk 与 Mutation

大型提交可以有多个内容寻址 Chunk；所有 Chunk 上传完成后仍由一个 Commit 原子发布。

```ts
interface VaultMutation {
  path: string;
  kind: "put" | "delete";
  blobHash?: string;
  size?: number;
  parents: string[];
}

interface ConfigSnapshotMutation {
  key: "portable";
  kind: "snapshot";
  treeHash: string;
  parents: string[];
}

interface ChangeChunk {
  protocol: 1;
  repositoryId: string;
  descriptorHash: string;
  channel: "vault" | "config";
  chunkIndex: number;
  chunkCount: number;
  mutations: Array<VaultMutation | ConfigSnapshotMutation>;
}
```

- `descriptorHash` 必须等于当前已验证 RepositoryDescriptor 规范字节的 Hash，并与引用它的 Commit 和同信封其他 Chunk 一致。
- `channel="vault"` 的 Chunk 只能含 VaultMutation；`channel="config"` 的 Chunk 只能含 ConfigSnapshotMutation，联合类型不能靠忽略另一分支字段来兼容。
- Vault Commit 可含多个 Chunk；同一路径在同一 Commit 中最多一次。
- 每个 Change Chunk 的 mutations 必须非空；空仓库由 RepositoryDescriptor 表示，v1 不发布空 Commit 或空 Chunk。
- `chunkCount` 是 1 至 1,024 的 JSON 整数；`chunkIndex` 是 0 至 chunkCount-1 的 JSON 整数；每个 mutations 数组含 1 至 4,096 项。parents 含 0 至 1,024 个规范 Version ID，并按规则排序、去重。
- Config Commit 必须恰有一个 Chunk，且该 Chunk 恰有一个 `ConfigSnapshotMutation`。
- Commit 的 changeChunkHashes 必须非空并按 chunkIndex 排列；所有 Chunk 的 repositoryId、channel、chunkCount 必须与 Commit 及数组长度一致，index 必须完整覆盖 `0..chunkCount-1`。
- Vault Mutation 按规范逻辑 path 全局排序后再切 Chunk，接收端验证跨 Chunk 顺序和唯一性。
- v1 的 Vault 级协议保留集合精确为 RepositoryDescriptor.configDir、全部 historicalConfigDirs 和 Vault 根 `.s3-sync-conflicts`；比较使用第 14 节固定 case-fold alias 与路径段祖先规则。VaultMutation path 等于或位于其中任一根之下时，属于该寄存器的语义完整性错误：不得创建或应用该版本；同一结构信封内其他合法寄存器仍可继续。发送端永远不得构造这类 Mutation，v1 客户端也不得自行增加会改变远端版本有效性的本机保留根。
- ConfigTree 和 Change Chunk 都以规范 JSON Hash 作为 Key。
- VaultMutation `put` 必须同时具有 blobHash 和 size，`delete` 两者都不得具有；size 是 0 至 Blob 上限的 JSON 整数。ConfigSnapshotMutation 的 key 必须精确为 `portable`，且只能具有接口列出的字段。
- Vault put 的 size 必须等于所指 Blob 的实际字节数；同一 blobHash 被不同 Mutation 声明为不同 size 时，仅实际 size 相符的引用可验证，其他寄存器保持完整性隔离。
- 首个未冻结本地 generation 的 `parents` 必须来自其固定 `basisHeads`；前一 generation 已冻结时，后续 generation 改为只引用其固定 `localPredecessorVersion`。两者都不得吸收之后观察到的远端头；冲突解决和 parent-reduction 仅使用各自显式冻结的操作头集合。
- 重命名是同一 Vault Commit 中旧路径 delete 和新路径 put；相同 Blob 不重复占空间。
- 所有对象和数组必须满足第 7.1 节固定上限；超过实现平台能力时隔离相关对象，不得误判删除。

### 7.5 Commit

```ts
interface Commit {
  protocol: 1;
  repositoryId: string;
  descriptorHash: string;
  writerId: string;
  sequence: string;
  previousCommitHash: string | null;
  createdAt: string;                 // 仅显示和诊断
  channel: "vault" | "config";
  kind: "change" | "bootstrap" | "conflict-resolution" | "parent-reduction";
  changeChunkHashes: string[];
  clientVersion: string;
}
```

- Commit ID 即其规范字节 SHA-256，不再另设随机 commitId。
- Commit Key 包含 writerId、sequence 和 Commit Hash。
- `descriptorHash` 必须等于当前已验证 RepositoryDescriptor 规范字节的 Hash，并与全部 Change Chunk 及引用的 ConfigTree 一致。
- 四种 kind 在 vault/config 两个 channel 都合法。`bootstrap` 的每个 Mutation 必须是 `parents=[]` 的根版本；`change` 允许每个 Mutation 有 0 至 1,024 个 parents；`conflict-resolution` 要求每个 Mutation 有 1 至 1,024 个 parents；`parent-reduction` 必须恰有一个 Chunk、一个 Mutation 和 2 至 1,024 个 parents。kind 不增加可用于选胜者的权限；`conflict-resolution` 只是用户操作的诊断标记，收敛仍只由显式 parents 决定。
- `changeChunkHashes` 必须含 1 至 1,024 个 Hash、不得重复；其顺序由引用 Chunk 的 chunkIndex 决定，不按 Hash 字典序重排。
- 每个安装实例生成独立 writerId；writer 链跨 Vault/Config channel 串行。
- `previousCommitHash` 必须是同 writer 上一个 sequence 的精确 Commit Hash。
- sequence 1 的 previousCommitHash 必须为 null；sequence 大于 1 时不得为 null。
- 同一 writer 同一 sequence 出现多个 Commit Hash 表示 writer 分叉；所有提交仍参与归并。本地检测后立即禁止用旧 writer 冻结任何新 Commit；已冻结且其字节、sequence、previous 链均可验证的 Outbox 只能按原 Key/原字节排空，之后生成新 writerId。若旧 Outbox 或链状态无法验证，则保持 recovery-required，不能改写 parents、跳过 sequence 或自动复制为新 Commit。
- `createdAt` 固定为 `0001` 至 `9999` 年、带三位毫秒和 `Z` 的有效 UTC RFC 3339 日历时间（`YYYY-MM-DDTHH:mm:ss.sssZ`），秒只允许 `00..59`；`clientVersion` 固定为 SemVer 2.0.0，可含合法 prerelease、禁止 build metadata。两者只用于诊断，仍受严格 Schema 和语义校验。
- `createdAt` 不参与排序、冲突或胜负判断。
- 不存在跨 writer 最大 sequence。
- 当前 writer 已发布最大合法 sequence 后必须生成新的 UUIDv4 writerId 并从 sequence 1 开始；不得溢出、回绕或复用旧 sequence。

### 7.6 发布顺序与依赖闭包

发布顺序固定为：

1. 从本地不可变暂存读取并上传缺失 Blob。
2. 上传并验证 ConfigTree（若有）。
3. 上传并验证全部 Change Chunk。
4. 上传 Commit。
5. GET Commit 并逐字节验证。
6. 只有 Commit 可读后才能确认远端发布成功。

接收方要求：

- Commit 和全部 Change Chunk 构成不可拆的结构信封：RepositoryDescriptor/descriptorHash、所有 Chunk 的 Schema/Key/Hash、index、跨 Chunk 排序和重复路径全部通过前，不创建其中任何版本，因而不会接收“半份 Mutation 清单”。
- 信封通过后，各 Mutation 独立验证内容依赖：Vault put 的 Blob；Config snapshot 的 ConfigTree 及其全部 put Blob；以及该 Mutation 的 parents。某项暂缺、损坏或超出平台能力时只让对应逻辑寄存器保持 `pending-dependency`/隔离，其他 Mutation 可以继续归并，但任何缺依赖的值都不得应用为空内容。
- parent 可以因到达乱序而暂时缺失；相关逻辑寄存器不得宣布完整或执行本地应用。
- parent 最终必须解析到同 repositoryId、同 channel、同路径或同 `config:portable` 寄存器。
- 循环、自引用、跨寄存器 parent、重复路径和重复 parent 均为完整性错误。
- 一个 writer 出现 sequence 缺口时，其缺口后的提交可以下载并隔离，但不能进入连续 frontier。

## 8. 远端归并与冲突

### 8.1 Vault 路径

对每个规范化 Vault 路径维护：

- 已验证版本。
- 被有效后继列为 parent 的版本。
- 当前头 = 已验证版本减去已被覆盖版本。

语义值：

- `put(hash)` 表示内容版本。
- `delete` 表示墓碑。
- 多个头均为相同 `put(hash)` 时语义等价，不提示冲突。
- 多个头均为 delete 时语义等价。
- 不同 Hash 或 put/delete 并存时形成显式冲突。

计算与 Commit 到达顺序无关。子版本先到时保持依赖待定；父版本验证后再完成归并。

### 8.2 配置快照

- ConfigTree Hash 是配置寄存器的语义值。
- 多个相同 Tree Hash 头等价。
- 不同 Tree Hash 的并发头形成快照级冲突，不自动逐文件合并。
- 用户可选择某个树，或在差异界面生成新的合并树；解决提交 parents 必须包含操作时已观察的全部配置头。
- 新远端头在检查后并发出现时，解决动作自然形成新的冲突，而不是静默覆盖。

### 8.3 超量头的安全归约

单个 Mutation 最多引用 1,024 个 parents。超过上限时不能截断父集合或直接拒绝永久卡死：

- 语义等价的头可自动发布 `parent-reduction`，用同一语义值覆盖最多 1,024 个头。
- 不同语义头必须先由用户选择或生成最终内容，再以该内容发布一系列 `parent-reduction`。
- 每一步只覆盖明确列出的头；未列出的头继续保持为当前头，因此中断不会丢失冲突版本。
- 归约到“归约头 + 剩余头”不超过上限后，最后一个 `conflict-resolution` 引用当时全部当前头。
- 归约期间到达的新头不会被吸收，最终仍形成冲突或要求刷新。
- 本地普通编辑若基于超过上限的等价 projectedHeads，DirtyRecord 仍保留原始 basisHeads；发布器先用相同 projectedValue 生成只覆盖这组 basisHeads 的归约链，再让编辑版本引用最终归约头。该过程不得加入编辑之后观察到的新头。

### 8.4 冲突本地物化

- 冲突身份规范对象固定为 `{protocol:1, repositoryId, channel, logicalKeys, heads}`；`logicalKeys` 使用 `vault:<path>` 或 `config:portable`，两数组均按 UTF-8 无符号字节排序、去重。`conflictId` 是该封闭对象 RFC 8785 字节的 SHA-256。
- 当前 put 头若同时要求把某路径物化为文件、又要求把它作为另一 put 路径的父目录，则形成跨寄存器结构冲突；受影响路径集合和头集合使用规范编码生成稳定 ID。
- 结构冲突的 logicalKeys 包含全部受影响寄存器，heads 包含这些寄存器的全部当前头；任何集合扩展都会得到新 conflictId，并迁移而不是丢弃旧草稿。
- 结构冲突保留各路径的全部远端头并阻止受影响子树自动应用；只有通过普通 put/delete 解决命令消除文件/目录前缀碰撞后才能继续，不得因本机文件系统恰好允许某种操作而选边。
- Vault 冲突内容保存在 `.s3-sync-conflicts/<conflict-id>/`，该目录永久排除同步。
- 冲突正文文件名只使用 `sha256(version-id)` 等安全 ASCII 标识；原逻辑路径、Version ID、语义值和可选展示扩展名写入结构化 metadata。不能把原始远端路径或含 `:` 的 Version ID 直接作为本地文件名。
- 所有 put 头都有可打开副本，delete 头有结构化删除意图说明。
- 原路径已有本机内容时不自动覆盖；新客户端可显示确定性候选，但它不是远端胜者。
- 冲突期间的原路径编辑保留为本地草稿，必须通过“用当前内容解决”显式发布。
- LocalConcurrentRecord 的 editor/磁盘候选保存在同一永久排除的本地恢复体系，但在用户选择或合并前都不是远端版本；解决后只把明确选定的最终值按记录中的原 basisHeads 发布，未选字节仍按恢复保留策略可达。
- 配置冲突只在配置差异界面展示和暂存，不把可执行插件代码放到会被自动加载的位置。

## 9. 本地持久状态与 Outbox

### 9.1 存储位置

- Obsidian 插件 `data.json` 只保存连接设置、凭证（或平台 secret provider 引用）和 UI 偏好；高频操作状态不与这些设置混写。没有可用 secret provider 时凭证属于本地明文，UI 必须明确提示；本插件保证不把它上传或写入诊断，但不能约束其他备份/同步工具。
- 操作状态、暂存 Blob、Journal 和全部非冲突恢复文件固定位于 `<vault.configDir>/.obsidian-s3-sync-local/<repository-id>/`；恢复文件必须是该 repositoryId 状态根的严格后代，不能另建未写入 descriptor 的 Vault 级排除根。
- 该状态根、本同步插件目录和 Vault 根冲突区 `.s3-sync-conflicts` 都是最高优先级永久排除规则，用户不能覆盖；前两者已包含于 configDir 的 Vault channel 排除范围，冲突区属于第 7.4 节冻结的协议保留根。
- 本地状态根和 `.s3-sync-conflicts` 必须有本插件可验证的所有权 metadata。接入时发现同名文件、symlink、未知目录或 metadata 不匹配，必须停止并要求用户先处理；不能把既有用户内容标记为插件所有、顺手排除后覆盖或删除。
- 操作状态使用 schema 版本、单调 state generation、校验和、双副本和串行写入器；不能依赖多个并发 `saveData()`。

### 9.2 必须持久化的状态

- RepositoryLocator、仓库 descriptor Hash，以及每个已知 writer 的连续 frontier 分支 tip Hash 集合作为 integrity anchors；真正空仓库使用 descriptor anchor。
- descriptor 的当前/历史 configDir、本机已知历史根、本插件目录和本地状态根组成不可覆盖的 sensitivePathExclusions；本机额外历史根会阻止加入当前 repositoryId，configDir 变化不能把旧凭证或状态重新分类为 Vault 文件。
- writerId、下一 sequence、previousCommitHash 和 writer fork 状态。
- 每个 writer 的连续 ingested frontier、分支 tip 集合、已见稀疏提交和缺口。
- 每个逻辑寄存器的 observedHeads。
- 每个本地 Vault 路径的 projectedHeads、projectedValue 和 projection generation。
- 配置寄存器的 projectedHeads、projected ConfigTree Hash、profile Hash 和 config generation。
- dirtyIntent（含 editor generation/content 标识和不可变 localCandidates）、DirtyRecord、localPredecessorVersion、DeletionEvidence 和冲突草稿。
- LocalConcurrentRecord、对应不可变暂存和本地选择/合并状态。
- OutboxCommit 的规范 Commit/Chunk/Tree 字节、staged Blob 引用和捕获的 dirty generation。
- PublishedReconcile、Inbox/pending apply、ApplyJournal、恢复记录和 Hash 缓存。
- 最近同步决策和脱敏诊断。

恢复文件不是性能缓存。v1 不自动删除任何由 ApplyJournal、LocalConcurrentRecord、冲突草稿或首次接入产生的恢复文件；即使对应 Journal 已完成，也必须持续保存路径、来源、最近验证 Hash/size 和“捕获后是否变化”。显式用户清理前重新稳定读取；恢复文件在被移入后又发生变化时更新恢复记录并突出提示，不能按最初 Hash 当作未变化副本清理。

### 9.3 编辑基线状态机

1. Markdown `editor-change`、Vault 文件事件或审计首次发现本地偏离时，立即创建 `dirtyIntent`。
2. `dirtyIntent.basisHeads` 从该路径当前 `projectedHeads` 复制，并在允许任何远端应用前持久化。
3. editor-change 创建的 intent 同时固定 `awaitingLocalWrite=true`、editor generation 和可比较的 editor 内容标识；Vault 事件本身不是解除证明。只有未变化的同 generation editor 内容与稳定落盘字节精确匹配，或编辑器适配器证明该 generation 已无待落盘内容，才能解除门闩。轮询次数、旧磁盘 Hash 和超时都不是证明。
4. 仅远端拉取可更新 observedHeads，不得修改 dirtyIntent 或 projectedHeads。
5. 稳定读取先把活动文件流式复制到临时不可变暂存并计算 size/Hash；安静窗口后再次完整读取活动路径并计算 size/Hash、确认仍是同一普通文件。两次结果完全一致且没有未解决 editor 门闩时才接纳第一份暂存并创建普通 DirtyRecord。门闩存在时：结果等于原 projectedValue 继续等待；其他结果暂存为 localCandidate；只有匹配未变化的最新 editor generation 才解除门闩，只有另有来源证据才升级 LocalConcurrentRecord，绝不凭 Hash 差异猜测来源或建立伪顺序。
6. 删除必须先满足第 11 节的 DeletionEvidence 规则，才能创建 delete DirtyRecord。
7. 同一未冻结 generation 的连续编辑只更新 generation 和待发布内容，不修改原 basisHeads。
8. 若最终字节重新等于 projectedValue、该路径没有冻结 Outbox 且 `awaitingLocalWrite` 已有有效解除证明，才可清除净变化。
9. 路径已有冻结 Outbox 时，后续变化形成下一 generation；在创建该 generation 的 dirtyIntent/DirtyRecord 时一次性固定前一 Outbox 中同路径的 `localPredecessorVersion`，当前 Outbox 和原 basisHeads 都不得改写。
10. 若该路径此前没有 projectedHeads，前一冻结 generation 是根 put，而后续观察为 confirmed-absent，则只持久化带该 `localPredecessorVersion` 的等待删除意图；该 put 验证发布前不得冻结 delete Commit，验证发布后 delete 的 parents 必须精确为该单一前驱。

### 9.4 Durable Outbox

创建 Outbox 前必须：

- 将全部 put 字节写入不可变本地暂存并重新验证 Hash。
- 固定 Mutation 顺序、parents、Chunk 字节、Commit 字节和 Commit Hash。
- 在同一持久状态事务中分配 sequence、记录 previousCommitHash 和捕获各路径 generation。

规则：

- 每个 writer 同时只允许一个正在发布的 OutboxCommit；后续提交排队。
- sequence 一旦分配，只能发布该冻结 Commit；不能用同一 sequence 生成新内容。
- v1 不定义空操作 Commit。已分配 sequence 的 Outbox 不支持取消，只能保留并继续发布原冻结 Commit；不能用 no-op 填洞或换内容。
- Commit 已发布但本地未记账时，重启用相同 Key/字节验证并完成记账。
- Commit 可读后先在一个状态事务中把冻结 Commit 作为 verified 数据纳入 writer frontier/observedHeads、推进本机 writer 链，并为每个 Mutation 持久化其精确 published Version ID 和 PublishedReconcile；这一步不以 generation 未变为由清除 DirtyRecord。
- Vault put 必须再次执行稳定 size/Hash，delete 必须再次取得 confirmed-absent；配置 Mutation 必须完成一次无 unknown 的完整逻辑 Tree 重建。结果与已发布值相同、捕获 generation 未变且没有更新的 dirtyIntent 时，才事务性更新 projectedHeads/projectedValue 并清理对应 DirtyRecord。
- 本地结果与已发布值不同时，在同一状态事务中保留或创建下一 generation，并固定该 published Version ID 为 `localPredecessorVersion`；不得加入发布期间观察到的其他远端头。若读取、缺失证明或配置重建不确定，则保持 PublishedReconcile、保留暂存引用并阻止该寄存器远端应用，直到可证明相同或形成后续本地变化。
- Outbox 冻结时已经存在的后续 generation 继续使用当时固定的 `localPredecessorVersion`；发布确认只解除其远端依赖，不得重算或替换父版本。
- 若该后续 generation 是“无 projectedHeads 的冻结根 put 随后被确认删除”，它可以持久化但不得在前驱 put 经 GET/Hash 验证发布前冻结为 delete Outbox；前驱发布后其 parents 必须精确等于该 `localPredecessorVersion`。
- 检测 writer fork 时不再为旧身份冻结新 Outbox；已经冻结的 FIFO 仍只能按原字节发布并完成 PublishedReconcile，排空后从新 writerId 的 sequence 1 继续。任何冻结项无法验证或发布时都阻断该链并保留暂存，不把它重建到新身份来伪造另一条因果链。

### 9.5 状态丢失

本地状态缺失、校验失败、未通过第 6.1 节受控重验的仓库指纹变化或 anchor 消失时：

- 停止自动发布、覆盖和删除。
- 生成新 writerId，不复用不确定 sequence。
- 将当前 Vault 与远端视为“没有共同本地基线”的已有内容接入。
- 本地缺失不生成墓碑，本地存在内容不声明最新远端头为父版本。
- 用户完成预览和确认后才建立新的 projection。

## 10. 本地安全应用器

### 10.1 Apply Plan

每个本地操作必须绑定：

```ts
interface ExpectedLocalValue {
  kind: "present" | "absent";
  hash?: string;
}

interface ApplyPlanItem {
  logicalKey: string;
  targetHeads: string[];
  targetValue: ExpectedLocalValue;
  expectedLocalValue: ExpectedLocalValue;
  expectedProjectionGeneration: number;
  expectedDirtyGeneration: number | null;
}
```

ExpectedLocalValue 的 `present` 必须具有 hash，`absent` 不得具有 hash；`absent` 与读取失败必须严格区分。预览计划执行前重新验证，不能把过期预览直接执行。

执行前还必须确认 RepositoryLocator 未变，且 `targetHeads` 仍等于该逻辑寄存器当前已验证的 observedHeads（允许先按语义等价头重建计划，但不能静默忽略已知新头）。已知头集合变化立即废弃计划；尚未被 List 发现的并发提交以后到达时仍自然形成冲突。

正常同步只能在稳定 `expectedLocalValue` 仍等于持久化 `projectedValue` 时生成破坏性 ApplyPlan；若两者不同，说明存在尚未入队的本地变化，必须先以原 projectedHeads 固定 dirtyIntent/DirtyRecord，不能把刚读到的活动字节当作可覆盖前像。唯一例外是无写入的语义采用：没有 dirtyIntent 且本地值已经等于唯一远端目标语义值时，可以只更新 projection。尚未建立 projection 的路径只能走第 13 节首次接入，不能进入普通 ApplyPlan。

### 10.2 Vault 文件应用流程

1. 获取路径级锁，并确认没有 dirtyIntent、DirtyRecord、LocalConcurrentRecord 或 generation 变化。
2. 重读正式路径；结果必须等于计划前像。
3. 当前值已经与目标 put Hash 相同，或当前和目标都为 absent 时，不执行文件写入，只事务性采用目标全部等价头。
4. 需要 put 时下载到暂存区，校验 size 和 SHA-256。
5. 持久化 ApplyJournal、预期前像、目标 Hash 和恢复路径。
6. 再次确认 generation 未变化；若目标存在，优先使用同文件系统原子 rename 将实际目标移入唯一恢复路径，再对被移走字节重新 Hash。
7. 被移走字节与计划不符时，不安装远端内容；尽力恢复原路径，固定本地 DirtyRecord，并保留所有字节。
8. 安装暂存文件必须使用 no-clobber/等价语义；若目标在间隙中重新出现，保留双方并取消应用。
9. delete 只把目标移入恢复区，不直接 unlink；确认事务完成后再按保留策略清理。
10. 安装后重新读取正式路径：put 必须得到目标 size/Hash，delete 必须得到 confirmed-absent；unknown 不能视为成功。
11. 提交 projection 前最后一次校验 RepositoryLocator、targetHeads、projection/dirty generation 和非本插件 dirtyIntent。任一变化都不得把目标标为已投影；保留 Journal/恢复字节，把实际活动值转入后续 DirtyRecord 或等待复核。
12. 只有目标后像与所有守卫仍成立时，才在同一状态事务更新 projectedHeads/projectedValue、消费精确匹配本次 operationId 的静音事件并完成 Journal。
13. 写入静音标记必须绑定 operationId 和预期结果 Hash；事件只在实际结果精确匹配时被消费，不能盲目忽略“下一次事件”。

恢复路径本身必须纳入本地观察。POSIX 等平台上外部进程可能在 rename 后继续通过旧文件句柄写入已移动文件；这不阻止目标后像在所有守卫成立时完成 projection，但恢复记录必须保留并在 Hash/size 变化时标为 post-capture edit，且 v1 不得自动清理该文件。

Obsidian DataAdapter 不提供通用内容 CAS。每个平台适配器必须通过 rename/no-clobber 契约测试；不能证明不会丢弃字节的平台不得触碰正式路径做破坏性自动替换/delete，只能无写入采用，或把已验证远端候选物化到永久排除的恢复/冲突区交给用户明确处理。一次较早的恢复复制不能替代 no-clobber，UI 必须显示该平台处于保守模式。

多路径计划在写入前必须计算最终 put 路径形状。若计划通过 `delete foo + put foo/bar` 或相反方向改变文件/目录形状，应用器把相关路径组成一个 Journal group：先按路径深度从深到浅移走受阻挡的文件，再按从浅到深安装 put。目录本身不等于 `confirmed-absent`；发现计划外子项、dirty 路径或无法证明为空的目录时整组停止，所有已移走字节保持可恢复。

### 10.3 配置批量应用

- 在任何正式写入前下载、验证完整 ConfigTree 和全部 Blob。
- 生成逐文件差异和每个本地前像，用户确认后再次完整验证。
- 当前完整逻辑 ConfigTree 必须仍等于 projected ConfigTree 才能生成破坏性批量计划；不同则先固定配置 dirtyIntent 并刷新本地候选 Tree。没有 dirtyIntent 且当前 Tree 已等于远端目标时只做无写入采用。
- 任一前像变化都中止整批应用并刷新预览，不继续应用剩余文件。
- 配置 observedHeads 或 RepositoryLocator 在确认后变化时同样中止整批应用并重新生成预览。
- 创建完整恢复快照和批量 ApplyJournal，再按安全顺序写入；插件包文件先于启用列表。
- 配置 item 同样按最终 put 路径形状排序；合法的 delete/put 形状变换使用 Journal group，计划外本地子项按“本地额外配置”处理而不是顺手删除。
- 批量中的每个文件仍执行第 10.2 节前像守卫；中途失败时停止并尝试用恢复快照回滚已写项目。
- 回滚本身也是受 Journal 保护的条件应用：只在当前值仍等于本批次写入的后像时，才用 no-clobber/Journal 恢复前像；若用户或其他进程已经改写，保持活动路径原样，停止该 Journal group 回滚并进入 recovery-required。旧前像和其他恢复字节继续可达，不能为了批次整齐而把新编辑移走。
- 回滚不能完整完成时保留 Journal 和全部恢复字节，停用配置发布/应用，直到用户完成恢复。
- 已加载插件的代码或 `data.json` 只有在用户停用对应插件或明确接受风险后才应用。
- 应用完成后提示重载；重载后重新构建逻辑 ConfigTree 验证结果。
- 只有整批写入和重建 Tree Hash 都成功后，才能事务性更新配置 projectedHeads；部分完成永远不能被记为已投影。
- 崩溃后可以续做或回滚，但由于插件加载顺序无法通用控制，v1 只承诺可恢复，不承诺运行时原子。

## 11. 删除证据

本地观察结果：

```ts
type LocalObservation =
  | { kind: "present"; hash: string; size: number }
  | { kind: "confirmed-absent" }
  | { kind: "unknown"; reason: string }
  | { kind: "out-of-scope"; scopeRevision: string };
```

文件逻辑路径上观察到目录、symlink、reparse point 或无法安全枚举的节点时返回 `unknown`，绝不能返回 `confirmed-absent`；只有形状变换的 Journal group 验证完全部受管子项后才能处理空目录。

允许生成 Vault 墓碑的情况：

- 已持久化、非本插件应用产生的 delete/rename 事件，且路径存在 projectedHeads，或已有同一本地因果队列中经验证发布的精确 `localPredecessorVersion`。
- 插件关闭期间发生删除：一次完整、无错误、未取消、范围版本未变化的审计确认缺失，并在防抖后直接复查仍不存在。
- 用户在冲突或首次接入界面明确确认删除。

没有 projectedHeads、但已有同路径冻结根 put 的 confirmed-absent 只能先形成等待删除意图；它不是首次本地缺失。根 put 发布前不得冻结或发布 delete，发布后必须只以该 put 的 Version ID 为 parent。

禁止生成墓碑的情况：

- list/read/stat 权限错误、超时、取消、磁盘临时不可用或目录扫描不完整。
- 文件超过当前平台能力、路径不兼容或 Hash 未完成。
- 忽略规则、config profile、Vault configDir 或同步范围发生变化。
- 既没有 projectedHeads，也没有同一本地因果队列中已冻结 put 前驱，且未经第 13 节首次接入界面明确确认的首次本地缺失。

忽略或 scope 变化表示停止管理，不表示删除。重新纳入范围时走逐路径非破坏性接入。

## 12. 一次同步的完整流程

### 12.1 恢复与拉取

1. 校验本地状态、RepositoryLocator、format.json 和各 writer integrity anchor。
2. 恢复未完成 Outbox 和 ApplyJournal；恢复未完成前不开始新一轮。
3. 分页发现 writer 和 Commit Key，处理重复、乱序、空页和 continuation token。
4. 验证 Commit、Chunk、Tree、Blob 和 parent 依赖；缺口和依赖缺失保持 pending。
5. 在持久状态事务中推进 ingested frontier 和 observedHeads，并生成 pending apply/conflict。
6. 对无冲突 Vault 路径执行第 10 节安全应用；失败路径保持 pending，其他路径可继续。
7. 配置新头只下载和预览，不自动应用。

只有完整分页、writer 连续链和所有依赖检查完成后，界面才显示“远端已检查完成”。

### 12.2 本地检测

1. 处理已持久化 dirtyIntent 和 Vault 事件。
2. 对事件路径执行两次完整 size/Hash 一致的稳定读取；第一次复制出的确切 put 字节进入本地内容暂存，任一次读取失败或不一致都保持 dirty/unknown。
3. 对 delete 候选执行 DeletionEvidence 检查。
4. 按 projectedValue 判断是否存在净变化。
5. 启动和低频完整审计发现插件关闭期间变化；审计失败不能产生删除。
6. ConfigTree 在安静窗口后做两次完整逻辑扫描；两次都必须无 unknown、scopeRevision 相同，并对 projected put 的缺失直接复查。第二次扫描的确切 put 字节直接进入暂存，不能之后再从活动文件重读构建 Outbox。

### 12.3 再拉取与发布

1. 发布前再拉取，减少不必要冲突，但不改变任何 DirtyRecord.basisHeads。
2. 从本地不可变暂存创建冻结 OutboxCommit。
3. 按 Blob -> Tree -> Chunk -> Commit 顺序上传并验证。
4. Commit 可读后先把本机 Commit 纳入 verified/observed 状态，持久化 writer 记账和每个版本的 PublishedReconcile，再执行本地 Hash/Tree 守卫；只有证明本地仍等于已发布值才更新 projection，否则形成后续 generation 或保持等待复核。
5. 同步期间新事件留在下一 generation，不递归启动协调器。

## 13. 首次创建、克隆和已有内容接入

### 13.1 仓库选择

向导必须：

- 测试 endpoint、Bucket、Prefix、List 分页、Put/Get/Hash；Delete 仅作为可选能力测试。
- 列出 Prefix 下所有 repositoryId，不自动选择多个仓库中的任意一个。
- 新建仓库时生成 repositoryId，并在正式对象前写入含 current/historical configDir 集合的固定 format.json。
- 持久化确切 Prefix 和 repositoryId；Vault 改名不改变连接。
- 检查旧 `.s3-sync/manifest.json`，明确标记为不兼容旧原型。
- 扫描可验证的旧本地状态/插件所有权 metadata，恢复并展示 historicalConfigDirs 候选；无法证明用途的同名目录只提示用户确认，不能自动认领或上传。
- 扫描本地范围、配置 profile、非法路径和大小写冲突，用户确认前不写正式 Commit。

### 13.2 Vault 四种组合

| 远端 | 本地 | 默认行为 |
| --- | --- | --- |
| 空 | 有内容 | 确认后发布本地 bootstrap 根版本 |
| 空 | 空 | 创建空仓库，不发布伪删除 |
| 有内容 | 空 | 预览后克隆远端 |
| 有内容 | 有内容 | 非破坏性逐路径接入 |

已有内容接入的精确因果语义：

- 远端所有当前头语义等价且与本地 Hash 相同：不上传，采用当时全部等价远端头作为 projectedHeads。
- 仅本地存在：发布 `parents=[]` 的本地根 put，不声称远端曾删除。
- 仅远端存在：下载并安全投影，本地缺失不发布墓碑。
- 同路径不同内容：本地内容以 `parents=[]` 发布，与远端头形成显式首次冲突。
- 远端墓碑、本地存在：本地根 put 与墓碑形成 put/delete 冲突。
- 远端已经冲突：新客户端继承全部头和内容；本地若匹配某个语义值，则把该值的全部等价当前头记为 projectedHeads，但仍保留其他头形成的冲突且不标记胜者、不发布新根；本地若不匹配任何头，经确认后以 `parents=[]` 增加本地根版本。

发布前再次拉取只减少根冲突；任何首次本地根版本仍不得把新远端头列为 parent。

### 13.3 并发 bootstrap

- 已共享同一 repositoryId 的两个客户端可以同时发布 bootstrap。
- 不同路径自动合并；相同 Hash 语义折叠；不同内容或 put/delete 形成冲突。
- 大型 bootstrap 的所有 Chunk 由一个 Commit 发布，其他客户端不会看到半个提交。
- 不同 repositoryId 的并发新建是两个独立仓库，之后由向导显式选择或迁移。

### 13.4 配置首次接入

- 配置不随 Vault bootstrap 自动应用。
- 本地与远端 ConfigTree 相同则采用远端快照身份。
- 两边不同且用户希望保留本地时，本地 ConfigTree 以 `parents=[]` 发布，形成快照级首次冲突；没有配置基线时本地扫描只生成现存 put，不从缺失生成 config delete。
- 用户可选择保留本地、采用远端或在差异界面生成合并树。
- “采用远端”遇到远端未提及的本地额外配置时仍需逐项确认；确认删除后发布带显式 delete 的解决 Tree，不能把省略当作删除依据。
- 任何应用都先创建本地恢复快照并提示重载。

## 14. 路径、配置目录与跨平台规则

- Vault path 使用 NFC、`/` 分隔符；必须是合法 Unicode scalar value 组成的非空相对路径，禁止首尾 `/`、空段、`.`/`..` 段、反斜杠、NUL 和 C0/DEL 控制字符。规范化后 UTF-8 bytes 不得超过第 7.1 节上限。
- 两个本地原始名称若规范化成同一 NFC path，或 NFC 后再 case-fold 成同一 alias key，都属于结构冲突；不能把后扫描到的一项覆盖前一项。远端线协议只接受已经 NFC 的 path，因此同一规范 path 的并发版本仍按普通 heads 归并。
- Config path 相对 `vault.configDir`，不得包含 configDir 自身名称。
- configDir 使用同一段规则且必须是非空目录路径；Config path 还必须至少包含一个相对 configDir 的段。协议允许某些仅在部分平台合法的普通文件段，但接收端必须隔离而不是改名或跳过这些远端路径。
- descriptor 的当前/历史 configDir、本机已知历史根、本地状态根、插件自身目录、冲突区和恢复区按规范化、大小写折叠后的路径永久排除；变更 configDir 先持久化新旧排除集合，再重新扫描，用户规则不能覆盖。
- 同一 repositoryId 的所有设备使用 RepositoryDescriptor 中相同的 configDir/historicalConfigDirs。运行时发现实际 configDir 变化或本机出现 descriptor 未列出的历史根时立即停止发布和应用；切换目录必须创建携带“旧 current + 旧 histories + 本机 histories”并集的新 repositoryId，不能在原仓库内重解释路径命名空间。
- Vault channel 无条件排除 current 和全部 histories。Config channel 只映射 current configDir；某 history 是 current 的严格后代时，该子树也从 Config channel 排除；history 是 current 的祖先时不屏蔽 current 映射本身。current 与 history case-fold 相等始终非法。
- current 或任一 historicalConfigDir 不得与 Vault 冲突区 `.s3-sync-conflicts` 相同或存在祖先/后代关系；仓库向导发现保留路径碰撞时拒绝创建或加入。
- 固定本地状态根或 `.s3-sync-conflicts` 已存在但没有可验证的本插件所有权 metadata 时同样拒绝接入；本同步插件目录必须由匹配 `obsidian-s3-sync` ID 的已安装插件拥有。排除规则本身不授予接管这些路径的权限。
- 仓库逻辑路径使用第 7.1 节固定的 Unicode case-fold key 检测大小写别名；展示名另存。
- 两台设备并发创建仅大小写不同路径时形成路径别名冲突，不允许在大小写不敏感平台静默选一项。
- 当前 put 版本的两个逻辑 path 若存在严格的段前缀关系，例如 `foo` 与 `foo/bar.md`，形成文件/目录结构冲突；delete 版本本身不占用文件形状。结构冲突解决前不得自动应用受影响子树。
- 写入前检查 Windows 保留名、尾随点/空格、目标平台非法字符和最大路径长度。
- symlink 和 Vault 外部目标默认拒绝；适配器无法可靠识别时将该能力标记为不支持。
- case-only rename 在大小写不敏感平台使用中间临时名。
- 文件夹重命名展开为已建立基线文件的批量 delete/put，并通过完整审计校验。

## 15. 配置快照范围与安全

### 15.1 默认便携配置

默认建议管理：

- `baseFiles` 默认精确为 `app.json`、`appearance.json`、`hotkeys.json`；其他 config 根级文件只在差异界面逐项加入。
- 用户声明目标设备中最低的 Obsidian `MAJOR.MINOR.PATCH`，作为便携插件兼容下限。
- 结构化的社区插件启用列表。
- `themes/**`、`snippets/**`。
- 用户选择的社区插件包目录，包含额外静态资源。
- 用户逐插件明确选择的 `plugins/<id>/data.json`。

默认排除：

- `core-plugins.json`；它是平台/版本相关的启用集合，v1 不把原始文件伪装成便携配置。未来若同步，必须使用新的结构化字段并保留设备本地核心插件。
- `workspace*.json` 和设备布局状态。
- 缓存、日志、临时文件、索引和系统垃圾。
- 本同步插件的包、data.json、启用列表身份和全部本地状态。
- 未明确选择的第三方插件 data.json。

### 15.2 插件包

- 插件包是目录级单元，不能假定只有 `manifest.json`、`main.js`、`styles.css`。
- `portablePluginIds` 是用户明确批准由 `config:portable` 管理启用状态的插件集合；包和 data 选择只能是它的子集。
- 构建 Tree 时必须读取 manifest 的 `id`、`version`、`minAppVersion` 和可选 `isDesktopOnly`。id 必须与目录/profile ID 逐字节一致；version 与 minAppVersion 都必须是无前导零、无 prerelease/build 的 `MAJOR.MINOR.PATCH`。manifest 缺失/非法、ID 不一致、isDesktopOnly=true，或 minAppVersion 高于 minimumTargetAppVersion 的插件不得加入 `portablePluginIds`。
- 第三方 `manifest.json` 只按最大 256 KiB 的 UTF-8 JSON object 有界解析，最大嵌套 16、单字符串最大 4 KiB；非法 UTF-8、BOM、重复 Key、超限或已知字段错型均为非法 manifest。未知 manifest 字段可保留给 Obsidian，但不能改变上述已知字段判断。
- 不符合便携条件的插件，其启用 ID、包和 data 保持设备本地且不参与 Tree Hash；应用远端 Tree 时也不得把这些本地项制造成永久待处理差异。
- 当前设备 Obsidian 版本低于 Tree 的 `minimumTargetAppVersion` 时，整棵配置树保持 incompatible，不得部分应用。
- 远端要求启用但目标设备既没有兼容本地包、Tree 也不提供可验证包时，整棵 Tree 保持 incompatible；不能先写启用列表或把部分文件记为已投影。
- v1 不提供 desktop/mobile 分支配置寄存器；若以后需要，使用新的独立 profile/register，不能让设备本地覆盖伪装成已投影 portable Tree。
- 插件代码变化必须单独高风险确认；未知或新增插件不得自动启用。
- 应用社区插件启用列表时始终保留本同步插件，不允许远端快照把自己禁用。

### 15.3 敏感配置

- 密钥、绝对路径和设备 ID 检测仅是启发式警告，不是泄漏防护证明。
- `data.json` 默认不选，用户启用前明确告知远端管理员可读取原文。
- 诊断包不包含配置正文、凭证或完整敏感路径。

## 16. S3 能力、一致性与权限

正常同步最低能力：

- HTTPS endpoint。
- `ListObjectsV2` 分页。
- HEAD/GET/PUT。
- PUT 支持 `If-None-Match: *` 或经过契约测试证明等价的原子“仅不存在时创建”；没有该能力只能只读诊断，不能创建或发布 v1 对象。
- 新对象可靠 read-after-write。
- 正确保留 UTF-8 Key 和对象字节。
- 可配置 region、path-style 和自定义 endpoint。

“等价原子仅创建”必须是单次服务端条件写：目标不存在时至多一个并发请求成功，目标存在时请求失败且原字节不变。供应商契约测试至少以不同正文并发创建同一 Key，验证恰好一个正文成为当前对象、所有失败请求均未产生覆盖；客户端锁、先 HEAD 后 PUT、版本回读后补偿或无条件 PUT 都不等价。

`DeleteObject` 不是正常 v1 同步的最低权限：

- 连接测试使用隔离、内容寻址 probe，Delete 仅在权限存在时清理。
- 仓库维护和旧世代删除使用单独的显式维护权限或供应商控制台。
- 推荐普通设备凭证禁止删除协议根对象，以缩小凭证泄漏的破坏范围。

对最终一致实现：

- Commit 可见而依赖暂不可见时只重试，不应用空内容。
- sequence 缺口和 parent 缺失时不宣布完成。
- 定期从头审计 Commit Key；增量 marker 只是性能缓存。
- 未发现的并发提交稍后可把当前结果变成冲突，但不能抹掉已有不可变内容。

每轮发布前直接 GET/Hash 验证 descriptor 和已知 writer branch-tip anchors 只是低成本防回滚检查，不证明全部历史正文仍可读。“完整校验”必须遍历所有已验证 Commit 及其可达 Change Chunk、ConfigTree 和 Blob，重新 GET/Hash 并报告缺失闭包；仓库世代迁移或维护前强制完成，日常按用户请求和低频计划运行。任一缺失都停止发布/迁移，但不据此删除本地内容。

建议启用 Bucket Versioning 或对象锁以应对运营误删；禁止对整个 Blob、Tree、Change 或 Commit 前缀按 LastModified 设置自动过期。

## 17. 调度、性能与资源限制

建议默认：

- editor/Vault 事件立即固定 dirtyIntent，字节读取防抖 2 至 5 秒。
- 远端轻量轮询 30 至 120 秒，可关闭。
- 启动后先恢复状态，再拉取和对账。
- 每天或每若干次启动执行一次完整内容审计。
- 始终提供“立即同步”“仅预览”“完整校验”。

性能优化不得改变正确性：

- 同路径事件合并。
- Blob 和 Hash 缓存失效时回退真实校验。
- 上传、下载和 Hash 使用有限并发，不阻塞 Obsidian 主线程。
- 大文件使用流式 Hash 和受限内存 I/O。
- 超出当前平台文件大小或 JSON 上限时隔离路径并报告，不把失败当删除。
- checkpoint 只用于提速；如果不能验证其覆盖的 writer frontier 和状态根，则新客户端不能信任它跳过历史。

## 18. 崩溃恢复与仓库维护

### 18.1 崩溃恢复

- Blob/Tree/Chunk 已上传而 Commit 未发布：远端不可见孤儿；继续同一 Outbox。
- Commit 已发布而本地未记账：按冻结 Key 和字节验证后完成记账。
- 文件下载一半：只存在暂存区。
- 目标已移入恢复区：Journal 决定恢复、继续或保留双方。
- 配置应用中断：在开始新同步前恢复或回滚整批计划。
- 已移入恢复区的文件在捕获 Hash 后又变化：保留实际文件并把新 Hash/size 标为 post-capture edit，等待用户恢复或清理，不自动删除。
- 状态双副本都损坏：停止自动同步并进入非破坏性重新接入。

### 18.2 空间与维护

- MVP 不自动删除 Blob、Tree、Change Chunk 或 Commit。
- 活跃版本、未解决冲突和待恢复对象永不自动清理。
- v1 本地恢复文件不做自动 GC；只允许用户在查看来源、当前 Hash/size 和 post-capture edit 状态后显式清理。
- 孤儿对象只统计，不自动删除。
- 压缩或 configDir 迁移使用新 repositoryId 写入完整新世代；新 descriptor 至少继承旧 historicalConfigDirs，目录迁移再加入旧 current 和所有参与设备已知历史根。验证逻辑树和 Hash 后再逐设备迁移。
- 新增 historicalConfigDir 若与源世代任何 Vault 头相同或存在祖先/后代覆盖，迁移必须列出这些版本并阻断，直到用户明确迁移/导出该普通 Vault 内容；不能借“敏感排除”在新世代静默丢路径。
- 旧世代保留回滚期，最后由用户使用维护权限删除。
- 无锁原地 GC、latest 指针和可变 manifest 不进入 v1 MVP。

同步不是独立备份。用户确认的删除会传播；仍建议使用供应商侧版本控制、备份或对象锁。

## 19. 可观测性与错误分类

主界面至少展示：

- 当前阶段：恢复、扫描、拉取、验证、上传、应用、等待重试、冲突。
- 最近成功拉取、发布、完整审计和配置验证时间。
- DirtyRecord、Outbox、pending apply、提交缺口和冲突数量。
- 逐路径/快照决策：相同、local put、remote put、墓碑、冲突、忽略、未知。
- S3 请求阶段、HTTP 状态、Request ID、重试次数和下一次重试时间。

错误分类：

- 认证/权限：停止无意义自动重试，保留队列。
- 网络/限流/5xx：指数退避。
- 完整性/依赖缺失：隔离对象，不应用相关寄存器。
- 本地路径/平台不兼容：隔离路径，其他路径继续。
- dirty/冲突：数据状态，不显示为网络失败。
- 仓库身份/anchor 不符：停止发布，进入重新接入。

诊断包包含协议版本、repositoryId 的脱敏表示、frontier、缺口、状态 generation 和最近决策，不包含 secret、正文或完整敏感路径。

## 20. 实施范围与旧原型

### 20.1 v1 发布必须完成

- RepositoryLocator、不可变 Blob/Tree/Chunk/Commit 协议和固定测试向量。
- observed/projected/dirty/outbox/apply 状态分离。
- editor-change 基线、稳定读取、删除证据和完整审计。
- Vault 多版本归并、墓碑、冲突传播和解决。
- Durable Outbox、Journal、恢复区和状态丢失重新接入。
- 四种 Vault 首次接入和并发 bootstrap。
- 手动、启动、事件和可关闭轮询调度。
- 配置完整树快照、快照级冲突、显式安全应用和插件代码警告。
- 核心 UI、错误分类和脱敏诊断。

### 20.2 v1 发布后

- 可验证 checkpoint 和快速日志重放。
- 结构化的核心插件启用寄存器；v1 不同步原始 `core-plugins.json`。
- 空间统计和新世代压缩工具。
- 提交签名和端到端加密的新协议版本。
- 人类可读 mirror、通知中继和桌面伴随程序。

### 20.3 旧原型

现有 `src/sync-engine.ts` 和 `src/s3-remote.ts` 使用共享 `.s3-sync/manifest.json` 与路径直写对象，只能作为 UI 和 API 参考：

- 不复用远端布局、同步判断、冲突逻辑或“本地重建远端”。
- 新实现只访问带 repositoryId 的新协议根。
- README 必须明确当前源码是 legacy prototype。
- 在新内核通过测试前，不把旧重建命令暴露为安全操作。

## 21. 冻结场景与发布验收

协议设计冻结时必须把以下场景固定为不可弱化的验收合同。任务 0 先把其中的线协议部分做成固定字节/Hash/Key 向量；依赖核心、文件系统或真实设备的场景由后续对应任务实现，并在任务 16 和发布前全部通过。不能反过来要求尚未实现的核心在 M0 前通过这些测试。

1. 用户产生 `editor-change`、尚未落盘时拉到远端新头；即使磁盘旧 Hash 连续稳定且等待超时，远端也不得应用到该路径；本地保存后仍使用旧 projectedHeads 并形成冲突。
2. 本地磁盘已修改但事件尚未处理时拉取；Hash 守卫固定旧 projectedHeads，不能采用新 observedHeads。
3. DirtyRecord 持久化后重启、再拉新头；basisHeads 不变。
4. Outbox 冻结后本地文件修改、删除、事件延迟或进程崩溃；仍发布冻结字节。发布后 Hash/Tree 守卫不得误清 dirty，下一 generation 只继承该 Outbox 的精确本地 Version ID，不吸收期间出现的远端头。
5. 在前像检查、目标移出、恢复 Hash、安装和记账每个边界注入本地编辑；任何字节都不被静默丢弃。
6. read/list 失败、审计取消、忽略规则变化和文件瞬时消失都不产生墓碑。
7. 同一提交集合任意乱序、重复到达，最终 heads 相同；缺 parent 时不应用。
8. 两设备并发修改、修改/delete、并发解决和 writer 分叉均保留所有语义值。
9. 同内容 `mtime` 抖动 100 次不产生 Blob 或 Commit。
10. Commit 先可见而 Blob/Tree/Chunk 暂不可见时只重试。
11. 一个多路径 Commit 中某路径本地应用失败；frontier 可前进但失败路径保持 pending 并在重启后重试。
12. 两个并发 ConfigTree 不按文件混合；第三客户端得到相同快照冲突。
13. 配置应用预览后本地变化会使整批计划失效；批量失败后的回滚遇到并发本地编辑时保留新字节，不用旧前像覆盖。
14. 自定义 `vault.configDir` 下本插件凭证、状态和包目录永不进入远端。
15. 相同 Prefix 下两个 repositoryId 完全隔离；旧设备不能污染新世代。
16. 四种首次接入、并发 bootstrap、状态丢失后重新接入均不默认覆盖或删除已有内容。
17. 删除全部本地操作状态后，空本地可仅靠远端重建；非空本地必须进入非破坏性接入。
18. 桌面和移动端适配器分别通过其声明的 rename/no-clobber、挂起和恢复契约测试。
19. Unicode case-fold、大小写别名、文件/目录前缀碰撞在所有客户端产生同一结构冲突；任何平台都不静默选边。
20. configDir 改名或切换后立即停止原仓库发布/应用并要求新 repositoryId 迁移；新 descriptor 携带旧 current/histories 并集，所有设备永久排除旧目录。本机出现 descriptor 外历史根时也不得继续加入。
21. `delete foo + put foo/bar` 及反向形状变换按 Journal group 可恢复执行；计划外子项或任一竞态不会被删除或覆盖。
22. 桌面/移动端改写 `core-plugins.json` 不改变 portable ConfigTree，也不产生待发布配置。
23. 配置目录枚举/读取失败、扫描取消或 scopeRevision 变化不会生成 config delete 或候选 Tree。
24. Vault 或配置值在 ApplyPlan 生成前已经偏离 projectedValue，但事件尚未到达；普通应用不得把该活动值采纳为“可覆盖前像”，必须按旧 projectedHeads 固定本地变化。安装后到 projection 记账前发生的变化同样不得被标为已投影。
25. `format.json` 被替换，或 Tree/Chunk/Commit 声明其他 descriptorHash；已有和全新客户端都停止该仓库发布/应用，不把旧 Vault/Config 路径按新 configDir 重解释。
26. editor generation 待落盘时出现另一稳定磁盘意图；Vault 事件不能解除门闩，候选先暂存且路径不得进 Outbox。适配器证明它来自 editor lineage 外时才形成 LocalConcurrentRecord；无法证明时继续等待用户保存/关闭或明确处理，不得凭 Hash 差异猜来源、伪造成前后继或丢弃候选。
27. 本地新建根 put 冻结后文件被删除并重启；仍先发布原 put，delete 在该 put 验证发布前不得冻结，之后只以该 put 的 Version ID 为 parent，绝不生成根墓碑或吸收新远端头。
28. `parents=[]` 的 ConfigSnapshotMutation 引用含 delete 的 Tree 时无效；非根 delete 缺任一直接父时保持 pending，全部父验证后仍没有父 Tree 管理该 path 时无效。

本文、`tasks.md` 与 README 的语义交叉复核已经完成，因此本文状态可标记为“v1 协议设计基线已冻结”。这不等于 M0 完成：机器可读 JSON Schema、规范测试向量、测试命令和支持矩阵仍属于任务 0；它们完成并进入版本控制前不得开始任务 1 的同步核心。
