# PG Pooling

[![NPM Version](https://img.shields.io/npm/v/%40digitalwalletcorp%2Fpg-pooling)](https://www.npmjs.com/package/@digitalwalletcorp/pg-pooling) [![License](https://img.shields.io/npm/l/%40digitalwalletcorp%2Fpg-pooling)](https://opensource.org/licenses/MIT) [![Build Status](https://img.shields.io/github/actions/workflow/status/digitalwalletcorp/pg-pooling/ci.yml?branch=main)](https://github.com/digitalwalletcorp/pg-pooling/actions) [![Test Coverage](https://img.shields.io/codecov/c/github/digitalwalletcorp/pg-pooling.svg)](https://codecov.io/gh/digitalwalletcorp/pg-pooling)

A lightweight TypeScript/JavaScript library for managing PostgreSQL connections with pooling support.
Designed for both server-side Node.js applications and cron-style background jobs, it wraps the `pg` `Pool` with safe connect/release handling, transaction helpers, slow-acquire and leak detection, and optional SQL logging.

#### ✨ Features

* **Connection Pooling**: Thin wrapper around the `pg` `Pool` with sensible timeout defaults.
* **Safe Acquire/Release**: Each checked-out client gets its own error listener and a leak-detection timer, so a forgotten `release()` is surfaced instead of silently exhausting the pool.
* **Pool Exhaustion Diagnostics**: Warns on slow acquires (`POOL ACQUIRE SLOW`), failed acquires (`POOL CONNECT FAILED`) and suspected leaks (`POOL LEAK SUSPECT`).
* **Transaction Helpers**: `begin()` / `commit()` / `rollback()` convenience methods.
* **Optional SQL Logging**: Emits the executed SQL and a truncated result set to `console.debug` when `debug` is enabled.
* **DATE Type Parsing**: PostgreSQL `DATE` (OID 1082) is returned as a `YYYY-MM-DD` string instead of a timezone-dependent `Date`.

#### 📦 Installation

`pg` is a **peer dependency**. Install it alongside this library so the application and the pool share a single `pg` instance.

```bash
npm install @digitalwalletcorp/pg-pooling pg
# or
yarn add @digitalwalletcorp/pg-pooling pg
```

#### 📖 Usage

Environment variables and SSL are the responsibility of the application. This library only consumes the `config` object it is given.

##### Example 1: Pure NodeJS Style Instantiation

This pattern is ideal for short-lived Node.js scripts, such as cron jobs, where a pool is created, used, and destroyed within a single run.

```typescript
import { PgPool } from '@digitalwalletcorp/pg-pooling';

const pool = new PgPool({
  host: 'localhost',
  port: 5432,
  database: 'app',
  user: 'app',
  password: 'secret',
  max: 10
});

async function main() {
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT * FROM users WHERE id = $1', [1]);
    console.log(res.rows);
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch(console.error);
```

##### Example 2: Singleton Pool Instantiation using a Web-App

For long-running web applications, a singleton pool ensures efficient reuse of connections across requests.
The application reads its own environment variables and builds the `config` (including `application_name` and `ssl`).

`@/server/singleton/connection-pooling`
```typescript
import { PgPool } from '@digitalwalletcorp/pg-pooling';

let pool: PgPool | undefined;

export function connectionPooling(): PgPool {
  if (!pool) {
    pool = new PgPool({
      host: process.env.PG_HOST,
      port: Number(process.env.PG_PORT),
      database: process.env.PG_DATABASE,
      user: process.env.PG_USER,
      password: process.env.PG_PASSWORD,
      max: Number(process.env.PG_POOL_SIZE),
      application_name: `myapp-${process.env.APP_ENV}`,
      ssl: process.env.APP_ENV === 'production' ? { rejectUnauthorized: false } : false
    }, {
      debug: process.env.NODE_ENV !== 'production'
    });
  }
  return pool;
}
```

`@/server/api/some-rest-api`
```typescript
import { connectionPooling } from '@/server/singleton/connection-pooling';

async function handleRequest() {
  const pool = connectionPooling();
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT * FROM sessions WHERE token = $1', ['abc']);
    return res.rows;
  } finally {
    client.release();
  }
}
```

##### Example 3: Transactions

```typescript
const client = await pool.connect();
try {
  await client.begin();
  await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [100, 1]);
  await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [100, 2]);
  await client.commit();
} catch (error) {
  await client.rollback();
  throw error;
} finally {
  client.release();
}
```

#### 📚 API Reference

##### `new PgPool(config: pg.PoolConfig, options?: PgPoolOptions)`

Creates a PostgreSQL connection pool. `config` is passed through to the underlying `pg` `Pool`. The following timeout-related properties fall back to the library defaults when they are not provided in `config`.

| Property                              | Type              | Default   | Description                                                                 |
| ------------------------------------- | ----------------- | --------- | --------------------------------------------------------------------------- |
| `connectionTimeoutMillis`             | number            | 10000     | Fail instead of waiting forever when the pool is exhausted.                 |
| `statement_timeout`                   | number            | 30000     | Server-side statement timeout.                                              |
| `query_timeout`                       | number            | 35000     | Client-side query timeout. Longer than the server-side one.                 |
| `idle_in_transaction_session_timeout` | number            | 60000     | Server-side timeout for sessions left idle inside a transaction.            |
| `keepAlive`                           | boolean           | true      | Enable TCP keep-alive.                                                      |
| `keepAliveInitialDelayMillis`         | number            | 10000     | Initial delay before the first keep-alive probe.                           |

All other `pg.PoolConfig` properties (`host`, `port`, `database`, `user`, `password`, `max`, `application_name`, `ssl`, ...) are passed through unchanged.

`PgPoolOptions`:

| Property | Type    | Default | Description                                                        |
| -------- | ------- | ------- | ------------------------------------------------------------------ |
| `debug`  | boolean | false   | When `true`, executed SQL and results are logged to `console.debug`. |

##### `PgPool` Methods

| Method              | Signature                       | Description                                                       |
| ------------------- | ------------------------------- | ----------------------------------------------------------------- |
| `connect()`         | `Promise<PgClient>`    | Acquire a client from the pool.                                   |
| `end()`             | `Promise<void>`                 | Drain and close the pool.                                         |
| `getOriginalPool()` | `pg.Pool`                       | Access the underlying `pg` `Pool`.                                |
| `totalCount`        | `number`                        | Number of connections the pool is holding.                       |
| `idleCount`         | `number`                        | Number of idle connections available to borrow.                  |
| `waitingCount`      | `number`                        | Number of requests waiting for a connection.                     |

##### `PgClient` Methods

| Method                                  | Signature              | Description                                                        |
| --------------------------------------- | ---------------------- | ------------------------------------------------------------------ |
| `query(text, values?, options?)`        | `Promise<pg.QueryResult>` | Run a query. Pass `{ suppressLog: true }` to skip SQL logging.  |
| `begin()` / `commit()` / `rollback()`   | `Promise<pg.QueryResult>` | Transaction control statements.                                 |
| `release()`                             | `void`                 | Return the client to the pool.                                    |

#### 💡 Notes

* Always release clients back to the pool using `release()` to avoid connection leaks.
* Use `connect()` and `release()` inside `try/finally` blocks for safe resource management.
* Warnings (slow acquire, connect failure, leak suspect, idle/checked-out client errors) are emitted via `process.emitWarning`. To suppress them, run Node with the `--no-warnings` flag (e.g. `node --no-warnings app.js`, or `NODE_OPTIONS=--no-warnings`).

#### 📜 License

This project is licensed under the MIT License. See the [LICENSE](https://opensource.org/licenses/MIT) file for details.
