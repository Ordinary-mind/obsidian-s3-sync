export interface SecurityBoundaryDisclosure {
  id: "trusted-writers" | "plaintext" | "unsigned" | "no-e2ee" | "plugin-code";
  label: string;
  detail: string;
}

export const v1SecurityBoundaryDisclosures: readonly SecurityBoundaryDisclosure[] = Object.freeze([
  Object.freeze({
    id: "trusted-writers",
    label: "可信写入者",
    detail: "当前协议假设所有持有写凭证的设备和用户可信；恶意写入者不在协议防护范围内。",
  }),
  Object.freeze({
    id: "plaintext",
    label: "应用层明文",
    detail: "对象 Key 中的路径信息和对象字节对 Bucket 管理员可见；HTTPS 只保护传输过程。",
  }),
  Object.freeze({
    id: "unsigned",
    label: "无提交签名",
    detail: "Commit、Chunk、Tree 和 Blob 使用 Hash 校验完整性，但不验证作者签名。",
  }),
  Object.freeze({
    id: "no-e2ee",
    label: "无端到端加密",
    detail: "当前协议不提供 E2EE；需要服务端不可读内容时不得使用它存放该内容。",
  }),
  Object.freeze({
    id: "plugin-code",
    label: "插件代码执行",
    detail: "远端插件包应用后可在 Obsidian 中执行；发布和应用均需要独立显式确认。",
  }),
]);
