# S3 Sync 桌面人工验收

只在可丢弃 Vault 和专用测试 Bucket/Prefix 上执行。每完成一节再进入下一节；失败时复制错误报告并停止，不要靠删除 `data.json`、状态目录或远端对象“试到能用”。

## 0. 记录与备份

- [ ] 记录日期、操作系统、Obsidian 版本、插件版本和 S3 供应商。
- [ ] 新建两个可丢弃 Vault：A 与 B；不要复制真实 Vault。
- [ ] 关闭 Obsidian 后分别备份两个 Vault。
- [ ] 准备唯一 Prefix，例如 `acceptance/<date>/run-01`。
- [ ] 准备只允许该测试 Bucket/Prefix 执行 List、Get/Head、Put 的凭证。
- [ ] 不给普通同步凭证授予 `DeleteObject`。
- [ ] 不在验收记录中保存 Access Key、Secret、正文或明文笔记路径。

若从插件数据 schema 3 的预发布构建升级到当前 schema 4：

- [ ] 先备份整个插件目录和 `.obsidian-s3-sync-local`。
- [ ] 覆盖构建后保留旧 `data.json` 备份，不删除本地状态目录。
- [ ] 新构建会拒绝旧结构并回到未连接状态；重新填写凭证并执行一次“检测并应用”。
- [ ] 接入同一仓库后核对 Outbox、冲突和恢复记录，再继续测试。

## 1. 自动化构建门禁

在仓库根目录执行：

```powershell
npm install
npm run test:ci
Get-FileHash -Algorithm SHA256 main.js
```

- [ ] 命令全部成功。
- [ ] 记录 `main.js` SHA-256。
- [ ] 根目录存在 `main.js`、`manifest.json`、`styles.css`。
- [ ] `manifest.json` 的 `isDesktopOnly` 为 `true`。

任一命令失败时停止；不要打包失败构建。

## 2. 安装构建

在 A、B 的下列目录中直接放三个文件：

```text
<Vault>/<configDir>/plugins/obsidian-s3-sync/
  main.js
  manifest.json
  styles.css
```

- [ ] 不创建 `dist/` 子目录。
- [ ] 不复制源码、测试、`node_modules` 或开发机 `data.json`。
- [ ] 两个 Vault 的三个发布文件完全相同。
- [ ] 两端都能启用插件，开发者控制台没有加载错误。

## 3. Vault A 连接

先保持自动同步关闭。填写：

| 字段 | 规则 |
| --- | --- |
| Endpoint | 只填协议、主机和可选端口；不能带末尾 `/`、Bucket、路径或查询参数 |
| Region | S3 签名使用的真实区域，例如百度广州为 `gz` |
| Bucket | 只填 Bucket 名称 |
| Access Key ID | 测试凭证 ID |
| Secret Access Key | 测试凭证 Secret；不是 Session Token |
| Prefix | 在高级设置中填写本次唯一 Prefix |
| Path-style | MinIO/百度 BOS 开启，AWS 通常关闭 |

- [ ] 百度 BOS、AWS 或本机 Endpoint 能自动填入已识别的 Region/Path-style；手动修改 Region 仍然有效。
- [ ] 点击一次“检测并应用”，检测期间不重复点击。
- [ ] 空 Prefix 自动显示“已自动创建并接入仓库”；已有唯一仓库显示“已接入/验证当前仓库”。
- [ ] 设置页显示的当前实际 Prefix 与记录一致。
- [ ] 连接成功后凭证表单自动折叠，只显示连接摘要、“修改连接”、自动同步和折叠的可选功能。
- [ ] 打开“状态与检查”并展开“诊断与高级功能”，仓库身份有效、Outbox 为 0、没有恢复阻断。

连接检测会留下不可变 probe 对象，这是预期行为。

### 连接失败时怎么测网络

先点击错误通知后的复制图标。报告应至少包含：

```json
{
  "schemaVersion": 3,
  "code": "S3SYNC_...",
  "category": "...",
  "connectionStage": "...",
  "causes": []
}
```

- [ ] 报告不含 Secret、Access Key、完整 Endpoint、Bucket、Prefix、对象 Key 或正文。
- [ ] 有 `operation` 时按 operation 排查：`list` 查 ListBucket；`put` 查 PutObject/条件写；`get`/`head` 查回读权限。
- [ ] 有 HTTP status 时优先判断：301/307 通常是 Endpoint/Region；401/403 是凭证、时间或权限；404 是 Bucket/Path-style；429/503 是限流。
- [ ] `outboxStage`、`preflightBlocker` 或 `persistenceStep` 存在时，问题不应再被当作笼统“网络请求失败”。

不带凭证的连通检查：

```powershell
Resolve-DnsName s3.gz.bcebos.com
Test-NetConnection s3.gz.bcebos.com -Port 443
```

网络可达不代表 S3 签名、Region、Path-style、IAM 或 `If-None-Match: *` 条件创建正确。仍失败时只发送复制的脱敏 JSON。

## 4. Vault B 接入同一仓库

- [ ] B 填写相同 Endpoint、Region、Bucket、Prefix 和 Path-style。
- [ ] 点击“检测并应用”。
- [ ] B 自动发现并接入唯一仓库，不出现仓库选择器。
- [ ] 两端 `configDir` 规范值相同；不相同时必须停止并改用新 Prefix。
- [ ] 再次在 A 执行“检测并应用”，只验证当前仓库，不创建第二个 descriptor。

## 5. 基本同步

在 A：

- [ ] 新建 `acceptance/basic.md`，写入 `A-basic-1`。
- [ ] 执行 `S3 Sync：同步` 或点击同步栏图标。
- [ ] 通知显示同步完成，状态页 Outbox 回到 0。

在 B：

- [ ] 执行 `S3 Sync：检查并拉取`。
- [ ] 文件出现，字节内容精确等于 `A-basic-1`。
- [ ] 修改为 `B-basic-2` 并执行“同步”。

回到 A：

- [ ] 执行“同步”，最终内容等于 `B-basic-2`。
- [ ] 状态页没有冲突、待应用或提交缺口。

## 6. 删除与重命名

- [ ] A 新建并同步 `acceptance/delete-me.md`，B 拉取确认存在。
- [ ] A 在 Obsidian 中删除文件后执行“同步”。
- [ ] B 执行“检查并拉取”，文件进入删除结果，不被重新上传。
- [ ] A 新建并同步 `acceptance/old-name.md`。
- [ ] A 在 Obsidian 中改名为 `acceptance/new-name.md` 并同步。
- [ ] B 拉取后只保留新路径。

若删除只在本机发生、旧路径重新出现或只上传新路径，本节失败。

## 7. 双端离线冲突

- [ ] 两端先同步相同的 `acceptance/conflict.md`，内容为 `base`。
- [ ] 两端断网；A 改为 `from-A`，B 改为 `from-B`。
- [ ] A 恢复网络并同步。
- [ ] B 恢复网络并执行“同步”。
- [ ] B 先拉取并停止发布，自动打开冲突窗口。
- [ ] 默认只显示“这台设备的版本”和“其他设备的版本”，Hash 与远端头位于折叠的技术详情。
- [ ] 内容相同的远端 put 候选合并为一项，但仍可打开对应候选副本。
- [ ] 删除候选没有伪造正文。
- [ ] 选择删除结果必须经过二次确认；取消确认后文件和冲突状态不变。
- [ ] 本机已删除、云端已修改时，可以选择“保留本机删除结果”。
- [ ] 选择本地版本或某个远端版本后，冲突变为已解决。
- [ ] A、B 再同步，最终只剩一个解析头。

整个过程中任何一方内容都不能被静默覆盖。

## 8. Outbox 与重启恢复

- [ ] A 修改一个文件后开始同步，在可控测试环境中于发布阶段关闭 Obsidian。
- [ ] 重启后状态页仍显示原 Outbox 或已经完成的远端证明结果。
- [ ] 再执行“同步”，不能分配替代 sequence，也不能丢失冻结字节。
- [ ] 若本地暂存缺失但远端对象完整，报告/状态显示通过远端证明完成。
- [ ] 若证明失败，错误报告包含具体 `outboxStage`，Outbox 仍保留。
- [ ] 不删除 `data.json`、状态目录或 Outbox 来让测试通过。

## 9. 自动同步

- [ ] 开启自动同步，修改一个文件并等待防抖，确认执行同一套先拉后发流程。
- [ ] 关闭自动同步，再修改文件；状态记录变化，但不自动联网。
- [ ] 关闭状态下手动“同步”仍可用。
- [ ] 重启 Obsidian 后开关状态保持一致，不出现重复并行同步。

## 10. 配置中心

- [ ] 设置页“可选功能”中只有“同步 Obsidian 设置”入口，没有第二个配置同步总开关。
- [ ] 默认只显示“同步内容”和“检查更改”；只有发生设置冲突时才显示“解决设置冲突”。
- [ ] Hash、writer、版本 ID、自定义根级文件和社区插件矩阵默认折叠，但展开后能力完整。
- [ ] 默认同步范围恰好为 `app.json`、`appearance.json`、`hotkeys.json`。
- [ ] “Vault 文件忽略规则”明确不控制配置通道。
- [ ] 远端 ConfigTree 只预览，不自动应用。
- [ ] 任何正式写入前都显示逐文件差异和恢复位置。
- [ ] 插件代码、插件 data、新插件和已加载插件按风险分别确认。
- [ ] 故意让批次中途失败，确认回滚或“需要恢复”状态可继续处理。
- [ ] 两端并发发布不同 ConfigTree 时显示整树冲突，不静默逐文件拼接。

只在测试插件和无敏感配置上执行本节。

## 11. 错误复制覆盖

分别制造或模拟以下错误并确认都有复制按钮：

- [ ] 连接字段错误；
- [ ] S3 权限或网络错误；
- [ ] 仓库操作忙；
- [ ] 同步前置恢复阻断；
- [ ] Outbox 重放错误；
- [ ] 冲突解决失败；
- [ ] 配置扫描/合并/应用失败；
- [ ] 状态页操作失败；
- [ ] 后台 Vault 事件处理失败。

状态页“复制脱敏诊断包”也必须成功，且路径只以 Hash 表示。

## 12. 完整校验与签字

- [ ] 两端在“诊断与高级功能”中运行“完整校验”，完成对象数等于总对象数，缺失闭包为 0。
- [ ] 正常退出/重启、禁用/启用插件后重复基本同步。
- [ ] 覆盖安装同一构建后 Bundle Hash 不变，状态可恢复。
- [ ] 开发者控制台没有未处理 Promise 或包含密钥的日志。
- [ ] 保存 Bundle Hash、系统、Obsidian、供应商和每节结果到仓库外。

只有 1–12 节全部通过，才能把当前 Bundle 标记为桌面候选。移动端不在支持范围内；同步也不能替代独立备份。
