import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareUtcConnection, runTransaction } from '../src/database/mysql.js';
import { assertAdvisoryLockAcquired } from '../src/database/locks.js';

test('advisory locks accept numeric and BIGINT-string success results', () => {
  assert.doesNotThrow(() => assertAdvisoryLockAcquired(1, 'lock is busy'));
  assert.doesNotThrow(() => assertAdvisoryLockAcquired('1', 'lock is busy'));
});

test('advisory lock timeouts still prevent protected work for both result formats', () => {
  for (const value of [0, '0']) {
    assert.throws(() => assertAdvisoryLockAcquired(value, 'lock is busy'), { message: 'lock is busy' });
  }
});

test('missing or invalid lock results are errors rather than lock contention or success', () => {
  for (const value of [null, undefined, true, false, '', 'unexpected', 2]) {
    assert.throws(() => assertAdvisoryLockAcquired(value, 'lock is busy'), /MySQL could not acquire the advisory lock/);
  }
});

function connection(rollbackFails = false) {
  const events: string[] = [];
  return {
    events,
    async beginTransaction() { events.push('begin'); },
    async commit() { events.push('commit'); },
    async rollback() { events.push('rollback'); if (rollbackFails) throw new Error('connection lost'); },
    release() { events.push('release'); },
    destroy() { events.push('destroy'); },
  };
}

test('a successful transaction commits and releases its connection', async () => {
  const conn = connection();
  const result = await runTransaction(conn, async () => 'saved');
  assert.equal(result, 'saved');
  assert.deepEqual(conn.events, ['begin', 'commit', 'release']);
});

test('failed work rolls back, releases the connection, and preserves the original error', async () => {
  const conn = connection();
  const original = new Error('operation failed');
  await assert.rejects(runTransaction(conn, async () => { throw original; }), (error) => error === original);
  assert.deepEqual(conn.events, ['begin', 'rollback', 'release']);
});

test('a failed rollback destroys the connection instead of returning it to the pool', async () => {
  const conn = connection(true);
  await assert.rejects(runTransaction(conn, async () => { throw new Error('original failure'); }), /original failure/);
  assert.deepEqual(conn.events, ['begin', 'rollback', 'destroy']);
});

test('UTC session initialization finishes before the connection is handed to application code', async () => {
  const events: string[] = [];
  let finish: () => void = () => assert.fail('initialization did not start');
  const conn = {
    async query(options: { sql: string; timeout: number }) {
      assert.equal(options.sql, "SET SESSION time_zone = '+00:00'");
      assert.equal(options.timeout, 2000);
      events.push('initializing');
      await new Promise<void>((resolve) => { finish = resolve; });
      events.push('initialized');
    },
    destroy() { events.push('destroyed'); },
  };
  const initialized = prepareUtcConnection(conn).then((result) => {
    events.push('application query');
    return result;
  });
  assert.deepEqual(events, ['initializing']);
  finish();
  assert.equal(await initialized, conn);
  assert.deepEqual(events, ['initializing', 'initialized', 'application query']);
});

test('a connection whose UTC initialization fails is destroyed and never handed out', async () => {
  let destroyed = false;
  const original = new Error('session setup failed');
  await assert.rejects(prepareUtcConnection({
    query: async () => { throw original; },
    destroy() { destroyed = true; },
  }), (error) => error === original);
  assert.equal(destroyed, true);
});
