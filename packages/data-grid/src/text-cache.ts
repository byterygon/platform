// The formatted strings of the cells in and near view (DBee spec §6: "formatted strings are cached
// per visible cell in a small LRU and dropped on scroll"). Keys are `row * columns + column`; a
// Map keeps insertion order, so the first key is the least recently used.

/** `null` is a cached NULL. */
export type CellText = string | null;

export class TextCache {
  readonly #map = new Map<number, CellText>();
  readonly #capacity: number;

  constructor(capacity: number) {
    this.#capacity = Math.max(1, capacity);
  }

  get size(): number {
    return this.#map.size;
  }

  /** The cached text, or `undefined` (not cached). A hit becomes the most recently used. */
  get(key: number): CellText | undefined {
    const map = this.#map;
    const text = map.get(key);
    if (text === undefined) return undefined;
    map.delete(key);
    map.set(key, text);
    return text;
  }

  set(key: number, text: CellText): void {
    const map = this.#map;
    map.delete(key);
    map.set(key, text);
    if (map.size > this.#capacity) map.delete(map.keys().next().value!);
  }

  clear(): void {
    this.#map.clear();
  }
}
