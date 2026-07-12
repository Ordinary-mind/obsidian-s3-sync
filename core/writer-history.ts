import { inspectWriterChain, type WriterChainIssue, type WriterCommit } from "./writer-chain";

export class WriterHistory {
  private readonly commits: WriterCommit[] = [];
  ingest(commit: WriterCommit): WriterChainIssue[] {
    this.commits.push({ ...commit });
    return inspectWriterChain(this.commits);
  }
  snapshot(): WriterCommit[] { return this.commits.map((commit) => ({ ...commit })); }
}
