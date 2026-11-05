// The order in which queued jobs start. Broken, a large subscription holds every capture slot while
// other subscriptions and single items wait, a step a pause or cooldown stopped loses its turn, or a
// job that may not start yet (cooling down, waiting for a retry) blocks unrelated work behind it.
import { describe, expect, it } from 'vitest';
import { JobQueue, type QueuePlace } from '../../src/jobs/job-queue.js';

const DISCOVERY: QueuePlace = { line: 'discovery' };
const lane = (name: string): QueuePlace => ({ line: 'capture', lane: name });
const always = () => true;

/** Every capture, in the order the queue gives them while all may start. */
function drainCaptures(queue: JobQueue, ready: (id: string) => boolean = always): string[] {
  const order: string[] = [];
  for (let id = queue.nextCapture(ready); id; id = queue.nextCapture(ready)) order.push(id);
  return order;
}

describe('the job queue', () => {
  it('starts discovery in arrival order, a job put back at the front first', () => {
    const queue = new JobQueue();
    queue.add('a', DISCOVERY);
    queue.add('b', DISCOVERY);
    queue.add('stopped', DISCOVERY, true);
    queue.add('c', DISCOVERY);
    expect([queue.nextDiscovery(always), queue.nextDiscovery(always), queue.nextDiscovery(always), queue.nextDiscovery(always)])
      .toEqual(['stopped', 'a', 'b', 'c']);
    expect(queue.nextDiscovery(always)).toBeUndefined();
  });

  it('skips discovery jobs that may not start and keeps them in place', () => {
    const queue = new JobQueue();
    queue.add('cooling', DISCOVERY);
    queue.add('free', DISCOVERY);
    expect(queue.nextDiscovery((id) => id !== 'cooling')).toBe('free');
    expect(queue.nextDiscovery((id) => id !== 'cooling')).toBeUndefined();
    expect(queue.nextDiscovery(always)).toBe('cooling');
  });

  it('starts the items of one lane in arrival order, a step put back at the front first', () => {
    const queue = new JobQueue();
    for (const id of ['a1', 'a2', 'a3']) queue.add(id, lane('a'));
    queue.add('a0', lane('a'), true);
    expect(drainCaptures(queue)).toEqual(['a0', 'a1', 'a2', 'a3']);
  });

  it('rotates captures between lanes, one item per lane per turn', () => {
    const queue = new JobQueue();
    for (const id of ['a1', 'a2', 'a3', 'a4']) queue.add(id, lane('a'));
    queue.add('b1', lane('b'));
    queue.add('b2', lane('b'));
    queue.add('single', lane('single'));
    expect(drainCaptures(queue)).toEqual(['a1', 'b1', 'single', 'a2', 'b2', 'a3', 'a4']);
  });

  it('gives a lane that joins mid-rotation its turn after the lanes already waiting', () => {
    const queue = new JobQueue();
    for (const id of ['a1', 'a2', 'a3']) queue.add(id, lane('a'));
    queue.add('b1', lane('b'));
    expect(queue.nextCapture(always)).toBe('a1');
    queue.add('c1', lane('c'));
    expect(drainCaptures(queue)).toEqual(['b1', 'a2', 'c1', 'a3']);
  });

  it('puts a new lane put back at the front before every other lane', () => {
    const queue = new JobQueue();
    queue.add('a1', lane('a'));
    queue.add('b1', lane('b'));
    queue.add('stopped', lane('s'), true);
    expect(drainCaptures(queue)).toEqual(['stopped', 'a1', 'b1']);
  });

  it('holds back a lane whose head may not start, and only that lane', () => {
    const queue = new JobQueue();
    queue.add('a1', lane('a'));
    queue.add('a2', lane('a'));
    queue.add('b1', lane('b'));
    queue.add('b2', lane('b'));
    expect(drainCaptures(queue, (id) => id !== 'a1')).toEqual(['b1', 'b2']);
    expect(drainCaptures(queue)).toEqual(['a1', 'a2']);
  });

  it('removes a job from its line, and an emptied lane from the rotation', () => {
    const queue = new JobQueue();
    queue.add('d1', DISCOVERY);
    queue.add('d2', DISCOVERY);
    queue.add('a1', lane('a'));
    queue.add('b1', lane('b'));
    queue.add('b2', lane('b'));
    queue.remove('d1', DISCOVERY);
    queue.remove('a1', lane('a'));
    queue.remove('b1', lane('b'));
    queue.remove('missing', lane('none'));
    expect(queue.size).toBe(2);
    expect(queue.nextDiscovery(always)).toBe('d2');
    expect(drainCaptures(queue)).toEqual(['b2']);
  });

  it('counts the jobs waiting in both lines together', () => {
    const queue = new JobQueue();
    queue.add('d1', DISCOVERY);
    queue.add('a1', lane('a'));
    queue.add('a2', lane('a'));
    queue.add('b1', lane('b'));
    expect(queue.size).toBe(4);
    queue.nextCapture(always);
    expect(queue.size).toBe(3);
    queue.clear();
    expect(queue.size).toBe(0);
    expect(queue.nextDiscovery(always)).toBeUndefined();
    expect(queue.nextCapture(always)).toBeUndefined();
  });

  it('orders positions by when each job last joined, until the job is forgotten', () => {
    const queue = new JobQueue();
    queue.add('first', DISCOVERY);
    queue.add('item', lane('a'));
    queue.add('stopped', lane('a'), true);
    queue.nextCapture(always);
    queue.nextCapture(always);
    const positions = ['stopped', 'first', 'item'].map((id) => queue.position(id)!);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    // A job that joins again moves behind every job that joined before.
    queue.add('first', DISCOVERY);
    expect(queue.position('first')!).toBeGreaterThan(queue.position('item')!);
    queue.forget('item');
    expect(queue.position('item')).toBeUndefined();
  });
});
