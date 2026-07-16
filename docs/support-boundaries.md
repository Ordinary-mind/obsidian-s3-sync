# 支持边界

本文件描述当前构建明确支持和明确拒绝的范围。拒绝项必须 fail closed，不是隐藏的导入或兼容入口。

## 运行时

| 项目 | 状态 | 要求 |
| --- | --- | --- |
| Obsidian 桌面版 | 目标平台 | 精确 Bundle 必须通过运行环境合同和人工生命周期验收 |
| Obsidian 移动端 | 不支持 | `manifest.json` 保持 `isDesktopOnly: true` |
| Node.js 22.x | 自动化测试基线 | 协议生成、类型检查、单元测试和 CI 使用该主版本 |

## 数据格式

| 项目 | 状态 | 行为 |
| --- | --- | --- |
| 远端不可变仓库协议 1 | 当前协议 | 严格验证规范 JSON、Hash、对象 Key、descriptor、大小限制和语义 |
| 插件 data.json schema 4 | 唯一支持结构 | 必须字段完整；未知字段、部分连接和身份不一致全部拒绝 |
| 仓库运行状态 schema 1 | 唯一支持结构 | 双副本校验；不合法副本先归档，普通 I/O 错误不归档 |
| 未知远端 protocol/schema | 不支持 | 停止读取、发布和应用，不猜测字段含义 |
| 旧共享 manifest | 不支持 | 不读取、不原地升级、不用它推断因果关系 |

一个 Bucket + Prefix 只能有零或一个仓库 descriptor。多个 descriptor、descriptor Hash 改变或 `configDir` 身份不匹配都会阻断。当前项目不包含仓库复制、多仓库管理、外部格式导入或自动远端维护删除。

## 对象存储

插件要求：

- ListObjectsV2 分页；
- GetObject 与 HeadObject；
- PutObject；
- `If-None-Match: *` 或等价的原子“仅不存在时创建”；
- 条件冲突后能够回读并验证已有正文；
- 合理一致的 GET、HEAD 和 LIST 可见性。

| 服务 | 当前声明 | 发布要求 |
| --- | --- | --- |
| MinIO | 已有真实合同证据 | 每个候选 Bundle 仍需运行 `npm run test:s3-minio` |
| 百度 BOS S3 接口 | 已有真实合同证据 | 每个候选 Bundle 仍需运行 `npm run test:s3-baidu` |
| AWS S3 | 暂不声明 | 先运行 `npm run test:s3-aws` 并保存本次 Bundle 的证据 |
| 其他 S3 兼容服务 | 未验证 | 必须新增或复用供应商合同测试，不能仅凭“能上传文件”声明支持 |

正常同步不需要 `DeleteObject`。合同测试应使用专用 Bucket 或唯一 `contract/*` Prefix，凭证只授予所需范围。

## 内容与安全

- 最大 Blob 为 5 GiB；超出时停止并显示可复制错误。
- 路径使用 Unicode 15.1 NFC、默认大小写折叠和 UTF-8 字节序。
- Windows 保留名、绝对路径、路径穿越、控制字符和超长对象 Key 全部拒绝。
- 当前协议不提供端到端加密或作者签名。
- Bucket 管理员可读取路径、正文和选中的配置内容。
- 社区插件 JavaScript 与插件 `data.json` 只有在明确确认后才能应用。
- 同步插件自身、凭证、本地状态、恢复区和当前/历史 `configDir` 永久排除。

机器可读声明位于 [protocol/support-matrix.json](../protocol/support-matrix.json)。冻结安全场景与测试证据位于 [protocol/frozen-scenarios.json](../protocol/frozen-scenarios.json)。
