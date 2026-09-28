import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeTask, type TaskObservationSource } from '../../apps/chatgpt-app/src/task-observation.ts';
import type { DetailedTaskV2 } from '@modelcontextprotocol/ext-tasks/core/v2';

const timestamp = new Date().toISOString();
const working: DetailedTaskV2 = { taskId: 'probe-task', status: 'working',
  createdAt: timestamp, lastUpdatedAt: timestamp, ttlMs: 60000 };
const completed: DetailedTaskV2 = { ...working, status: 'completed',
  result: { content: [{ type: 'text', text: 'OBSERVATION_OK' }] } };

function fixture(initial: DetailedTaskV2 = working) {
  let snapshot = initial;
  let reads = 0;
  const listeners = new Set<() => void>();
  const source: TaskObservationSource = {
    subscribe(changed) { listeners.add(changed); return () => { listeners.delete(changed); }; },
    async read() { reads++; return snapshot; },
  };
  return { source, listeners, get reads() { return reads; },
    publish(next: DetailedTaskV2) {
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}

test('completed before subscribe and completion during disconnect are read on reconnect', async () => {
  const state = fixture(completed);
  const first = observeTask(state.source, new AbortController().signal);
  assert.deepEqual((await first.next()).value, completed);
  await first.return(undefined);
  assert.equal(state.listeners.size, 0);
  const resumed = observeTask(state.source, new AbortController().signal);
  assert.deepEqual((await resumed.next()).value, completed);
  await resumed.return(undefined);
  assert.equal(state.listeners.size, 0);

  const disconnected = fixture();
  const session = observeTask(disconnected.source, new AbortController().signal);
  assert.deepEqual((await session.next()).value, working);
  await session.return(undefined);
  disconnected.publish(completed);
  const reconnect = observeTask(disconnected.source, new AbortController().signal);
  assert.deepEqual((await reconnect.next()).value, completed);
  await reconnect.return(undefined);
});

test('change during a pending read causes one subsequent read, with no lost wake or reordering', async () => {
  const state = fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<unknown>();
  const read = state.source.read;
  let first = true;
  state.source.read = async signal => {
    if (!first) return read(signal);
    first = false;
    assert.equal(state.listeners.size, 1);
    entered.resolve();
    return release.promise;
  };
  const controller = new AbortController();
  const events = observeTask(state.source, controller.signal);
  try {
    const initial = events.next();
    await entered.promise;
    state.publish(completed);
    state.publish(completed);
    release.resolve(working);
    assert.deepEqual((await initial).value, working);
    assert.deepEqual((await events.next()).value, completed);
    assert.equal(state.reads, 1); // Duplicate invalidations coalesce.
    const idle = events.next();
    controller.abort();
    assert.equal((await idle).done, true);
    assert.equal(state.reads, 1); // Abort does not start another read.
    assert.equal(state.listeners.size, 0);
  } finally {
    release.resolve(working);
    controller.abort();
    await events.return(undefined);
  }
});

test('waiting subscription wakes on a change and releases its observer on abort', async () => {
  const state = fixture();
  const controller = new AbortController();
  const events = observeTask(state.source, controller.signal);
  try {
    await events.next();
    const next = events.next();
    state.publish(completed);
    assert.deepEqual((await next).value, completed);
    controller.abort();
    assert.equal(state.listeners.size, 0);
    assert.equal((await events.next()).done, true);
  } finally {
    controller.abort();
    await events.return(undefined);
  }
});

test('authority read rejection closes observation without exposing another snapshot', async () => {
  const state = fixture();
  const events = observeTask(state.source, new AbortController().signal);
  await events.next();
  state.source.read = async () => { throw new Error('AUTHORITY_DENIED'); };
  state.publish(completed);
  await assert.rejects(events.next(), /AUTHORITY_DENIED/);
  assert.equal(state.listeners.size, 0);
});

test('abort detaches immediately while the authority read is still pending', async () => {
  const state = fixture();
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  state.source.read = signal => new Promise((_resolve, reject) => {
    assert.equal(signal, controller.signal);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    entered.resolve();
  });
  const events = observeTask(state.source, controller.signal);
  const pending = events.next();
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise;
  controller.abort();
  assert.equal(state.listeners.size, 0);
  await rejected;

  const neverStarted = observeTask(state.source, controller.signal);
  assert.equal((await neverStarted.next()).done, true);
  assert.equal(state.listeners.size, 0);
});
