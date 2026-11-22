export type ShownRevision = string | null;
export type CatchUpDone = () => ShownRevision;

export function createCatchUp() {
  let behind = 0;
  let latest: string | null = null;
  const shown = (): ShownRevision => (behind === 0 ? latest : null);
  return {
    fallBehind(): CatchUpDone {
      behind += 1;
      let done = false;
      return () => {
        if (!done) { done = true; behind -= 1; }
        return shown();
      };
    },
    receive(revision: string | null): ShownRevision {
      latest = revision;
      return shown();
    },
  };
}
