/**
 * Where a queued job waits: the discovery line (subscription requests and check listings), or a
 * capture lane. Each check's items share one lane, named after the check; an item submitted on its
 * own has a lane of its own.
 */
export type QueuePlace = { line: 'discovery' } | { line: 'capture'; lane: string };

/**
 * The order in which queued jobs start, by job ID. It holds no jobs and runs nothing: the caller
 * adds an ID when the job joins its line and asks for the next one that may start. Discovery is
 * one line in arrival order. Captures rotate between lanes, one item per lane per turn, so one
 * large check cannot hold every capture slot; within a lane, items start in arrival order. A job
 * put back at the front of its line goes before every other job of that line.
 */
export class JobQueue {
  private readonly discovery: string[] = [];
  private readonly lanes = new Map<string, string[]>();
  /** Lanes with queued items, in the order their next item gets a turn. */
  private laneOrder: string[] = [];
  /** When each job last joined its line; a job put back at the front gets a number before all others. */
  private readonly joined = new Map<string, number>();
  private back = 0;
  private front = 0;

  /** Adds a job at the back of its line, or with `front` at the head. */
  add(id: string, place: QueuePlace, front = false): void {
    this.joined.set(id, front ? --this.front : ++this.back);
    if (place.line === 'discovery') {
      if (front) this.discovery.unshift(id);
      else this.discovery.push(id);
      return;
    }
    const queue = this.lanes.get(place.lane);
    if (queue) {
      if (front) queue.unshift(id);
      else queue.push(id);
    } else {
      this.lanes.set(place.lane, [id]);
      if (front) this.laneOrder.unshift(place.lane);
      else this.laneOrder.push(place.lane);
    }
  }

  /** Takes the first discovery job that `ready` accepts. */
  nextDiscovery(ready: (id: string) => boolean): string | undefined {
    const index = this.discovery.findIndex(ready);
    if (index < 0) return undefined;
    return this.discovery.splice(index, 1)[0];
  }

  /**
   * Takes the head of the first lane, in rotation order, whose head `ready` accepts; that lane then
   * waits behind the others. Every job of a lane is of one source type, so a head that may not
   * start holds back the rest of its lane.
   */
  nextCapture(ready: (id: string) => boolean): string | undefined {
    for (let position = 0; position < this.laneOrder.length; position += 1) {
      const lane = this.laneOrder[position]!;
      const queue = this.lanes.get(lane)!;
      if (!ready(queue[0]!)) continue;
      this.laneOrder.splice(position, 1);
      const id = queue.shift();
      if (queue.length > 0) this.laneOrder.push(lane);
      else this.lanes.delete(lane);
      return id;
    }
    return undefined;
  }

  /** Takes a job out of its line without starting it. */
  remove(id: string, place: QueuePlace): void {
    if (place.line === 'discovery') {
      const index = this.discovery.indexOf(id);
      if (index >= 0) this.discovery.splice(index, 1);
      return;
    }
    const queue = this.lanes.get(place.lane);
    if (!queue) return;
    const index = queue.indexOf(id);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) {
      this.lanes.delete(place.lane);
      this.laneOrder = this.laneOrder.filter((candidate) => candidate !== place.lane);
    }
  }

  /**
   * When the job last joined a line, comparable between jobs: lower joined earlier. It stays after
   * the job is taken, until `forget`, so a job waiting outside its line keeps its place in order.
   */
  position(id: string): number | undefined {
    return this.joined.get(id);
  }

  /** Drops a finished job's position. */
  forget(id: string): void {
    this.joined.delete(id);
  }

  /** Jobs waiting in both lines together. */
  get size(): number {
    let count = this.discovery.length;
    for (const queue of this.lanes.values()) count += queue.length;
    return count;
  }

  /** Empties both lines; positions stay until each job is forgotten. */
  clear(): void {
    this.discovery.length = 0;
    this.lanes.clear();
    this.laneOrder = [];
  }
}
