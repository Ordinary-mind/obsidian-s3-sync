# 安全边界

v1 假定 Bucket 和所有写入者可信。协议对象没有数字签名，也没有端到端加密；S3 服务端加密不改变应用层明文边界。Vault 路径、文件字节、选中的配置与插件包都会以可被存储服务读取的形式保存。

插件代码属于高风险可执行内容。远端 JavaScript、CSS、新插件和 `data.json` 只有在完整下载、Hash 校验、兼容性检查与用户显式确认后才能写入配置目录；未知插件不会自动启用。

普通同步使用 [最小权限 Policy](docs/s3-policy-minimal.json)，不需要 `DeleteObject`。探测清理或旧世代维护使用 [独立维护 Policy](docs/s3-policy-maintenance.json)、完整源/目标审计和二次确认。

本地没有 secret provider 时，凭证会以明文保存在 Obsidian 插件 `data.json`。插件不会上传凭证、正文或未脱敏诊断；其他备份工具仍可能读取该文件。

安全问题请提供脱敏诊断包，不要附带 Vault 正文、插件 `data.json`、Access Key 或 Secret Key。
