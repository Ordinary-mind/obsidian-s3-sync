import { Notice, setIcon } from "obsidian";
import { safeErrorMessage, safeGenericErrorReport } from "../core/safe-error";
import { writeClipboardText } from "./clipboard";

const COPYABLE_NOTICE_DURATION_MS = 5_000;

export function showCopyableNotice(message: string, report: string): void {
  const fragment = document.createDocumentFragment();
  const row = document.createElement("span");
  row.className = "s3-sync-notice-with-action";
  const text = document.createElement("span");
  text.className = "s3-sync-notice-message";
  text.textContent = message;
  const copyButton = createCopyButton(report, "s3-sync-notice-copy-button");
  row.append(text, copyButton);
  fragment.append(row);

  const notice = new Notice(fragment, COPYABLE_NOTICE_DURATION_MS);
  copyButton.addEventListener("pointerdown", (event) => event.stopPropagation());
  copyButton.addEventListener("s3-sync-report-copied", () => window.setTimeout(() => notice.hide(), 800));
}

export function showCopyableErrorNotice(label: string, error: unknown, context = "runtime"): void {
  showCopyableNotice(`${label}：${safeErrorMessage(error)}`, safeGenericErrorReport(error, context));
}

export function appendCopyableReportButton(container: HTMLElement, report: string): HTMLButtonElement {
  const button = createCopyButton(report, "s3-sync-inline-copy-button");
  container.append(button);
  return button;
}

function createCopyButton(report: string, className: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.setAttribute("aria-label", "复制脱敏错误信息");
  button.title = "复制脱敏错误信息";
  setIcon(button, "copy");
  button.addEventListener("pointerdown", (event) => event.stopPropagation());
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await writeClipboardText(report);
      setIcon(button, "check");
      button.setAttribute("aria-label", "已复制");
      button.title = "已复制";
      button.dispatchEvent(new CustomEvent("s3-sync-report-copied"));
    } catch {
      setIcon(button, "circle-x");
      button.setAttribute("aria-label", "复制失败");
      button.title = "复制失败";
    }
  });
  return button;
}
