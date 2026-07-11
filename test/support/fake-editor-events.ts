export interface FakeEditorChange {
  path: string;
  generation: number;
  content: string;
}

export class FakeEditorEvents {
  private readonly generations = new Map<string, number>();
  private readonly listeners = new Set<(change: FakeEditorChange) => void>();

  onChange(listener: (change: FakeEditorChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(path: string, content: string): FakeEditorChange {
    const generation = (this.generations.get(path) ?? 0) + 1;
    this.generations.set(path, generation);
    const change = { path, generation, content };
    for (const listener of this.listeners) listener(change);
    return change;
  }
}
