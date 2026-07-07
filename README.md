# Obsidian S3 Sync

一个面向 Obsidian 的 S3 Compatible Storage 同步插件实验项目。

## 设计目标

- 不使用 mtime 判断真实修改。
- 使用 SHA-256 内容 Hash 识别文件变化。
- 每个设备维护自己的本地同步基线，不上传本地 `data.json`。
- 远端使用 S3 对象存储保存文件内容和同步操作日志。
- 冲突默认保留双方版本，不自动覆盖。
- Prefix 可留空，插件会自动使用当前 Vault 名称生成远端前缀。

## 为什么忽略插件自身目录

`.obsidian/plugins/obsidian-s3-sync/` 里包含插件自己的 `data.json`。这个文件保存本机设备 ID、同步基线、冲突记录和 S3 配置，不应该参与同步。否则不同设备会共享同一份本地状态，容易造成误删、误判冲突或同步循环。

## 当前状态

这是第一版最小可用实现，重点是验证同步模型和插件工程结构。

## S3 目录布局

远端默认使用当前 Vault 名称作为 Prefix。Prefix 下包含：

- 源文件路径：远端文件结构与本地 Vault 保持一致，例如 `notes/a.md`、`.obsidian/community-plugins.json`。
- `.s3-sync/manifest.json`：记录全局版本号和每个文件的 Hash，是同步判断依据。

如果测试时远端状态混乱，可以在高级设置里使用“用本地重建远端”。这个操作会删除当前 Prefix 下的远端同步数据，再以本地 Vault 为准重新上传。
