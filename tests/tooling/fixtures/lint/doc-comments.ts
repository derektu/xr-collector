/** A page of results. */
export interface Page {
  /** The items on this page. */
  items: string[];
}

/** How a check ended. */
export type CheckEnd =
  | { kind: 'listed'; count: number }
  | {
    kind: 'failed';
    /** Why the listing failed. */
    reason: string;
  };

/** Reads pages. */
export class Reader {
  /** The page size. */
  readonly size = 50;
  /** Hidden state. */
  private cursor = 0;
  /** Shared with subclasses. */
  protected offset = 0;
  /** Truly private. */
  #token = '';

  /** Reads the next page. */
  next(): Page {
    /** Not a contract. */
    const items: string[] = [];
    return { items: [...items, String(this.cursor + this.offset), this.#token] };
  }
}

/** Default limits. */
export const LIMITS = {
  /** At most this many pages. */
  pages: 10,
} as const;

/** Where results come from. */
export enum Origin {
  /** Read from disk. */
  Disk = 'disk',
}

/** Not exported. */
function helper(): number {
  return 1;
}

/** Collects pages. */
export function collect(): number {
  return helper();
}
