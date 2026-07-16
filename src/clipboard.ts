import { DiagnosticError } from "../core/diagnostics";

export async function writeClipboardText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (cause) {
    throw new DiagnosticError(
      "CLIPBOARD_WRITE_FAILED",
      "local-path",
      "the runtime rejected the clipboard write request",
      cause,
    );
  }
}
