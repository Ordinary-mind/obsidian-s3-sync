export class ObjectNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`object not found: ${key}`);
    this.name = "ObjectNotFoundError";
  }
}

export class LostResponseError extends Error {
  constructor(readonly key: string) {
    super(`response lost after storing object: ${key}`);
    this.name = "LostResponseError";
  }
}

interface StoredObject {
  body: Uint8Array;
  visibleAt: number;
  temporary404s: number;
  tamperedBody: Uint8Array | undefined;
}

export class FakeObjectStore {
  private readonly objects = new Map<string, StoredObject>();
  private listPages: string[][] | undefined;
  private now = 0;

  advance(ticks = 1): void {
    this.now += ticks;
  }

  putImmutable(key: string, body: Uint8Array, options: { visibleAfter?: number; loseResponse?: boolean } = {}): void {
    if (this.objects.has(key)) throw new Error(`immutable object already exists: ${key}`);
    this.objects.set(key, {
      body: copy(body),
      visibleAt: this.now + (options.visibleAfter ?? 0),
      temporary404s: 0,
      tamperedBody: undefined,
    });
    if (options.loseResponse) throw new LostResponseError(key);
  }

  get(key: string): Uint8Array {
    const object = this.objects.get(key);
    if (!object || object.visibleAt > this.now || object.temporary404s > 0) {
      if (object?.temporary404s) object.temporary404s -= 1;
      throw new ObjectNotFoundError(key);
    }
    return copy(object.tamperedBody ?? object.body);
  }

  list(prefix = ""): string[] {
    if (this.listPages?.length) return [...this.listPages.shift()!];
    return [...this.objects]
      .filter(([key, object]) => key.startsWith(prefix) && object.visibleAt <= this.now)
      .map(([key]) => key)
      .sort();
  }

  setListPages(pages: string[][]): void {
    this.listPages = pages.map((page) => [...page]);
  }

  injectTemporary404(key: string, count = 1): void {
    const object = this.requireObject(key);
    object.temporary404s += count;
  }

  tamper(key: string, body: Uint8Array): void {
    this.requireObject(key).tamperedBody = copy(body);
  }

  private requireObject(key: string): StoredObject {
    const object = this.objects.get(key);
    if (!object) throw new ObjectNotFoundError(key);
    return object;
  }
}

function copy(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}
