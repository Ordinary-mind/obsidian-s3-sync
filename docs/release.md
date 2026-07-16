# 发布与恢复

## 候选版本门禁

在 Node.js 22.x 上执行：

```powershell
npm run test:ci
```

然后对本次精确 Bundle 执行：

```powershell
npm run test:s3-minio
npm run test:s3-baidu
# 只有计划声明 AWS 支持时才运行：
npm run test:s3-aws
```

最后按 [manual-acceptance.md](manual-acceptance.md) 完成两个可丢弃桌面 Vault 的逐项验收。

发布证据必须记录：

- `main.js` SHA-256；
- Git commit；
- Node.js、Obsidian 和操作系统版本；
- 对象存储供应商及合同命令；
- 两个 Vault 的人工验收结果；
- 已知缺陷与是否阻断发布。

不得记录凭证、正文、完整对象 Key或明文 Vault 路径。

## 发布文件

用户安装包只包含：

```text
main.js
manifest.json
styles.css
```

三者直接位于插件目录根部，不发布 `dist/`。发布前确认 `main.js` 是 `npm run build` 产生的最新文件，并且 `git diff --exit-code -- main.js` 成功。

## 本地恢复行为

| 状态 | 当前行为 |
| --- | --- |
| 重启时存在 frozen/publishing Outbox | 按原 writer sequence 和原冻结对象 FIFO 重放 |
| 本地暂存缺失但远端对象完整 | 用全部对象 Hash/大小和接受前沿的只读证明完成 Outbox |
| 本地和远端都不能证明 Outbox | 保留 Outbox，停止写入，报告确切 `outboxStage` |
| 未完成 Vault Apply Journal | 保留 before-image，重新验证 guard 后继续或进入恢复 |
| 未完成配置批次 | 在配置中心继续或回滚同一个 Journal |
| 双状态副本内容不合法 | 归档状态副本，保留 staging/recovery/S3，建立新 writer 并提示 |
| 状态读取或权限失败 | 进入只读阻断，不把错误当成内容损坏 |
| descriptor 或仓库身份不符 | 停止远端读取/写入并提供可复制身份错误 |

不要通过删除 `data.json`、Outbox、Journal、恢复目录或远端对象来“修复”候选构建。先复制诊断包并备份现场。

## 预发布 schema 4

当前构建的插件 `data.json` 使用严格 schema 4。较早预发布结构不会自动迁移。升级测试构建前备份插件目录和本地仓库状态；新构建回到未连接状态后，重新填写凭证并执行“检测并应用”接入同一唯一仓库。该过程不会删除远端对象或本地状态目录。

## 发布结论

自动化、真实对象存储合同或人工验收任一项缺少证据时，只能标记为预发布构建。移动端不得包含在当前发布声明中。
