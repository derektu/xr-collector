export type QueuePlace = { line: 'discovery' } | { line: 'capture'; lane: string };

export class JobQueue {
  private readonly discovery: string[] = [];
  private readonly lanes = new Map<string, string[]>();
  private laneOrder: string[] = [];
  private readonly joinOrders = new Map<string, number>();
  private backJoins = 0;
  private frontJoins = 0;

  add(id: string, place: QueuePlace, front = false): void {
    this.joinOrders.set(id, front ? --this.frontJoins : ++this.backJoins);
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

  nextDiscovery(ready: (id: string) => boolean): string | undefined {
    const index = this.discovery.findIndex(ready);
    if (index < 0) return undefined;
    return this.discovery.splice(index, 1)[0];
  }

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

  joinOrder(id: string): number | undefined {
    return this.joinOrders.get(id);
  }

  forget(id: string): void {
    this.joinOrders.delete(id);
  }

  get size(): number {
    let count = this.discovery.length;
    for (const queue of this.lanes.values()) count += queue.length;
    return count;
  }

  clear(): void {
    this.discovery.length = 0;
    this.lanes.clear();
    this.laneOrder = [];
  }
}
