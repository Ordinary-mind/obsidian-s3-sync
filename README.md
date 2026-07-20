# Obsidian S3 Sync

面向桌面版 Obsidian 的 S3 多设备同步插件。它按原始字节 SHA-256 判断变化，使用不可变对象、提交日志和持久 Outbox，避免按 `mtime` 猜测新旧或用共享 manifest 相互覆盖。

当前版本是 `0.1.10` 预发布构建，只支持桌面端。请先在可丢弃 Vault 和专用测试 Prefix 中完成[人工验收](docs/manual-acceptance.md)，不要直接拿唯一一份真实资料试用。

## 用户操作

插件只暴露三个命令：

- `S3 Sync：同步`：先检查并拉取，再发布所有已记录的本地变化。
- `S3 Sync：检查并拉取`：只读取远端并安全应用；遇到冲突会自动打开候选窗口。
- `S3 Sync：状态与检查`：查看状态、预览、完整校验和复制脱敏诊断包。

左侧栏的同步图标等同于“同步”。普通使用不需要分别理解 Push、Pull、Outbox 或仓库选择。

普通使用可以按 SVN 的方式理解：当前 Vault 是本地工作副本，Bucket + Prefix 中的 S3 仓库是中央远端；“同步”负责先拉取、自动合并无冲突路径，再把本地结果发布到远端。底层仍保留不可变提交和并发头，目的是在两台离线设备同时发布时不丢数据，而不是要求用户手工操作提交图。

同步按以下规则自动协调：

| 本地 | 远端 | 结果 |
| --- | --- | --- |
| 空 | 空 | 无操作 |
| 有文件 | 空 | 上传本地文件 |
| 空 | 有文件 | 下载远端文件 |
| 双方都有且内容相同 | 双方都有且内容相同 | 直接确认一致 |
| 不同路径分别变化 | 不同路径分别变化 | 自动合并后上传 |
| 同一路径仅一侧偏离共同基线 | 另一侧仍是共同基线 | 自动采用变化侧 |
| 同一路径双方都偏离共同基线，或首次连接时内容不同 | 内容不同 | 打开冲突窗口，由用户比较并选择；解决后自动继续同步 |

同步不会用远端内容静默覆盖无法确认的本地修改，也不会把读取失败当成删除。

冲突窗口每个文件只占一行：左侧是文件名，右侧固定提供“左右对照”“使用本地版本”“使用远端版本”三个文字按钮，并带悬停说明。有效 UTF-8 文本在 1 MiB、20,000 行以内时显示完整正文；二进制、编码无效或超限文件只显示状态和大小。当前只选择整个本地版本或整个远端版本，不提供行级合并。

正常情况下，一个文件在远端只有一个活动头。只有多台设备离线并发发布时，才可能暂时出现多个活动头；远端历史中的旧版本不算活动冲突。若多个活动头内容相同，窗口会合并显示；只有存在多个不同内容时才出现远端版本下拉框。

选择远端版本后，本机原内容会保留在受保护恢复区；若需要核对，可在折叠的“技术详情与诊断”中使用“打开原本机副本”。窗口底部的“清理已解决副本”会二次确认，只删除已解决、未被 journal/冲突引用且未被修改的本地恢复文件和可见冲突目录，不会删除当前 Vault 文件或 S3 历史。关闭冲突窗口后，也可从“状态与检查”中的“本地安全副本”或高级操作“管理本地副本”重新进入。

`<Vault>/<configDir>/.obsidian-s3-sync-local/<repository-id>/` 是持久的本地仓库管理目录，作用类似工作副本中的 `.svn` 或 `.git`：保存仓库身份、因果状态、Outbox、journal、暂存和恢复记录。只要仍连接该仓库，目录本身就必须保留；完成冲突并同步不会删除它，显式清理也只移除符合条件的副本内容。

## 连接设置

填写 Endpoint、Region、Bucket、Access Key ID 和 Secret Access Key，然后点击一次“检测并应用”。Prefix 与 Path-style 位于高级设置。

“检测并应用”会依次完成：

1. 严格校验字段；
2. LIST 当前 Prefix，并要求其中恰好没有仓库或只有一个仓库；
3. 验证已有仓库身份，或在空范围中自动创建仓库；
4. 用并发条件 PUT、GET、HEAD 和 LIST 验证对象存储能力；
5. 全部通过后才保存设置并接入仓库。

失败不会覆盖当前有效设置。错误通知带复制图标，复制内容包含稳定错误码、失败阶段、S3 operation、HTTP status、Request ID 和脱敏 cause 链，不包含凭证、正文、Endpoint、对象 Key 或明文 Vault 路径。

常用配置：

| 服务 | Endpoint | Region | Path-style |
| --- | --- | --- | --- |
| 本机 MinIO | `http://127.0.0.1:9000` | `us-east-1` | 开启 |
| 百度 BOS 广州 | `https://s3.gz.bcebos.com` | `gz` | 开启 |
| AWS S3 | 对应区域的官方 Endpoint | Bucket 所在区域 | 关闭 |

除 `localhost` 和 `127.0.0.1` 外，Endpoint 必须使用 HTTPS，且只能填写 origin，不能带 Bucket、路径、查询参数或末尾 `/`。

## 配置中心与忽略规则

配置中心始终可用，不再有重复的“配置同步”总开关。默认只管理 `app.json`、`appearance.json` 和 `hotkeys.json`；远端配置只会被验证和预览，发布或应用都需要明确确认。

- “同步的根级配置文件”是配置通道的允许列表，只接受直接位于 Obsidian `configDir` 下的文件名。
- “Vault 文件忽略规则”是普通笔记/附件通道的排除列表，不控制配置中心。
- 整个当前及历史 `configDir`、本插件目录、本地状态和冲突目录始终排除，避免重复同步或上传凭证。

主题、CSS snippets、社区插件包和插件 `data.json` 都默认关闭。插件代码与 `data.json` 分别需要风险确认；本插件自身永远不能进入配置快照。

## 数据安全模型

- 远端 Blob、ConfigTree、Change Chunk 和 Commit 都是不可变对象；Commit 最后写入。
- 每个 Vault 路径是一个多版本寄存器；通常只有一个活动头，离线并发时暂存多个活动头并等待合并，不静默选胜者。不可变旧版本属于历史，不会都显示为冲突候选。
- 本地变化第一次被观察时固定父版本；发布前新看到的远端头不会被错误吸收。
- 待发布字节先进入磁盘暂存，再和 writer sequence 一起事务性冻结到 durable Outbox。
- 重启后只重放同一份已验证字节，不生成替代 sequence。
- 拉取写本地前后都校验本地前像、远端头、编辑 generation 和安装后像；恢复副本不会自动删除，只能通过明确确认清理安全且已解决的副本。
- 确认删除以墓碑发布；读取失败、扫描不完整和超出范围不会伪装成删除。

远端物理布局位于：

```text
<prefix>/.obsidian-s3-sync/v1/repositories/<repository-id>/
  format.json
  blobs/sha256/...
  config-trees/sha256/...
  changes/sha256/...
  commits/<writer-id>/...
```

这是对象协议，不是可在 S3 控制台直接编辑的 Vault 镜像。一个 Bucket + Prefix 只能有零或一个仓库；发现多个 descriptor 会直接阻断。`configDir` 身份改变时必须使用新 Prefix。

## 安装与打包

运行：

```powershell
npm install
npm run test:ci
```

Obsidian 插件目录中只需要下面三个文件，并且必须直接放在该插件目录根部：

```text
<Vault>/<configDir>/plugins/obsidian-s3-sync/
  main.js
  manifest.json
  styles.css
```

不需要发布 `dist/`，也不要把源码、测试、`node_modules` 或 `data.json` 打进用户安装包。仓库根目录的 `main.js` 就是构建产物。

## 测试

本地门禁：

```powershell
npm test
npm run test:types
npm run build
npm run test:ci
```

对象存储合同：

```powershell
npm run test:s3-minio
npm run test:s3-baidu
npm run test:s3-aws
```

云端合同测试必须使用专用 Bucket 或唯一 `contract/*` Prefix 和受限临时凭证。不要把任何密钥写入仓库文件。

## 安全边界

当前协议没有端到端加密和作者签名，假设 Bucket 管理员及所有持有写凭证的设备可信。S3 服务端可读取 Vault 路径、正文和被选择同步的配置。凭证在当前平台会以明文保存在本机插件 `data.json`，但不会上传或进入诊断报告。

普通同步只需要 List、Get/Head 和 Put；不需要 `DeleteObject`。同步不能替代独立备份，确认删除会传播到其他设备。

## 文档

- [design.md](design.md)：当前唯一实现的架构与冻结安全场景。
- [tasks.md](tasks.md)：已完成内容和剩余发布门禁。
- [docs/manual-acceptance.md](docs/manual-acceptance.md)：逐项人工验收与连接排障。
- [docs/support-boundaries.md](docs/support-boundaries.md)：协议、运行时和供应商支持边界。
- [docs/release.md](docs/release.md)：构建、证据和发布清单。
- [SECURITY.md](SECURITY.md)：信任、明文和权限边界。
