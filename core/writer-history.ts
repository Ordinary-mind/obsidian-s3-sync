import { inspectWriterChain, type WriterChainIssue, type WriterCommit } from "./writer-chain";

export class WriterHistory {
  private readonly commits: WriterCommit[] = [];
  private rotationRequired = false;
  ingest(commit: WriterCommit): WriterChainIssue[] {
    this.commits.push({ ...commit });
    const issues = inspectWriterChain(this.commits);
    if (issues.includes("sequence-fork")) this.rotationRequired = true;
    return issues;
  }
  snapshot(): WriterCommit[] { return this.commits.map((commit) => ({ ...commit })); }
  requiresRotation(): boolean { return this.rotationRequired; }
}
