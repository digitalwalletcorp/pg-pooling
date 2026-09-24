import { PgPool, PgClient } from '@/pg-pooling';

jest.mock('pg', () => {
  const { EventEmitter } = require('events');

  class FakePoolClient extends EventEmitter {
    public static instances: FakePoolClient[] = [];
    public queryMock = jest.fn(async (_text: string, _values?: any[]) => ({
      command: 'SELECT',
      rowCount: 0,
      rows: [],
      oid: 0,
      fields: []
    }));
    public releaseMock = jest.fn();

    constructor() {
      super();
      FakePoolClient.instances.push(this);
    }

    public query(text: string, values?: any[]): Promise<any> {
      return this.queryMock(text, values);
    }

    public release(): void {
      this.releaseMock();
    }
  }

  class FakePool extends EventEmitter {
    public static instances: FakePool[] = [];
    public config: any;
    public totalCount = 0;
    public idleCount = 0;
    public waitingCount = 0;
    public connectImpl: () => Promise<any>;
    public endMock = jest.fn(async () => undefined);

    constructor(config: any) {
      super();
      this.config = config;
      this.connectImpl = async () => new FakePoolClient();
      FakePool.instances.push(this);
    }

    public connect(): Promise<any> {
      return this.connectImpl();
    }

    public end(): Promise<void> {
      return this.endMock();
    }
  }

  const types = { setTypeParser: jest.fn() };
  return {
    __esModule: true,
    default: {
      Pool: FakePool,
      types
    },
    Pool: FakePool,
    types
  };
});

const pgMock: any = require('pg');

const baseConfig = {
  host: 'localhost',
  port: 5432,
  database: 'app',
  user: 'app',
  password: 'secret',
  max: 5
};

/**
 * pgをモックしたpg-poolingの単体テスト
 */
describe('pg-pooling', () => {
  let emitWarningSpy: jest.SpyInstance;

  beforeEach(() => {
    pgMock.default.Pool.instances.length = 0;
    emitWarningSpy = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
  });

  afterEach(() => {
    emitWarningSpy.mockRestore();
    jest.clearAllMocks();
  });

  describe('PgPool', () => {
    it('registers the DATE type parser on import', () => {
      expect(pgMock.default.types.setTypeParser).toHaveBeenCalledWith(1082, expect.any(Function));
      const parser = pgMock.default.types.setTypeParser.mock.calls[0][1];
      expect(parser('2026-09-24')).toBe('2026-09-24');
    });

    it('applies default timeouts when they are not provided', () => {
      new PgPool(baseConfig);
      const config = pgMock.default.Pool.instances[0].config;
      expect(config.connectionTimeoutMillis).toBe(10 * 1000);
      expect(config.statement_timeout).toBe(30 * 1000);
      expect(config.query_timeout).toBe(35 * 1000);
      expect(config.idle_in_transaction_session_timeout).toBe(60 * 1000);
      expect(config.keepAlive).toBe(true);
      expect(config.keepAliveInitialDelayMillis).toBe(10 * 1000);
      expect(config.host).toBe('localhost');
      expect(config.max).toBe(5);
    });

    it('lets config override the default timeouts', () => {
      new PgPool({
        ...baseConfig,
        statement_timeout: 1000,
        keepAlive: false
      });
      const config = pgMock.default.Pool.instances[0].config;
      expect(config.statement_timeout).toBe(1000);
      expect(config.keepAlive).toBe(false);
    });

    it('connect returns a PgClient that can query', async () => {
      const pool = new PgPool(baseConfig);
      const client = await pool.connect();
      expect(client).toBeInstanceOf(PgClient);
      const result = await client.query('SELECT 1');
      expect(result.command).toBe('SELECT');
      client.release();
    });

    it('warns POOL ACQUIRE SLOW when requests are waiting', async () => {
      const pool = new PgPool(baseConfig);
      pgMock.default.Pool.instances[0].waitingCount = 1;
      const client = await pool.connect();
      expect(emitWarningSpy).toHaveBeenCalledWith(expect.stringContaining('POOL ACQUIRE SLOW'));
      client.release();
    });

    it('warns POOL CONNECT FAILED and rethrows when acquiring fails', async () => {
      const pool = new PgPool(baseConfig);
      pgMock.default.Pool.instances[0].connectImpl = async () => {
        throw new Error('pool exhausted');
      };
      await expect(pool.connect()).rejects.toThrow('pool exhausted');
      expect(emitWarningSpy).toHaveBeenCalledWith(expect.stringContaining('POOL CONNECT FAILED'));
    });

    it('exposes pool counts', () => {
      const pool = new PgPool(baseConfig);
      const instance = pgMock.default.Pool.instances[0];
      instance.totalCount = 3;
      instance.idleCount = 2;
      instance.waitingCount = 1;
      expect(pool.totalCount).toBe(3);
      expect(pool.idleCount).toBe(2);
      expect(pool.waitingCount).toBe(1);
    });

    it('end closes the underlying pool', async () => {
      const pool = new PgPool(baseConfig);
      await pool.end();
      expect(pgMock.default.Pool.instances[0].endMock).toHaveBeenCalledTimes(1);
    });

    it('warns on idle client error', () => {
      new PgPool(baseConfig);
      pgMock.default.Pool.instances[0].emit('error', new Error('idle boom'));
      expect(emitWarningSpy).toHaveBeenCalledWith(expect.stringContaining('Idle client error'));
    });
  });

  describe('PgClient', () => {
    it('query passes text and values through and returns the result', async () => {
      const pool = new PgPool(baseConfig);
      const client = await pool.connect();
      const result = await client.query('SELECT * FROM t WHERE id = $1', [7]);
      expect(result.command).toBe('SELECT');
      client.release();
    });

    it('begin/commit/rollback issue the matching SQL', async () => {
      const captured: any[] = [];
      const pool = new PgPool(baseConfig);
      pgMock.default.Pool.instances[0].connectImpl = async () => {
        const { EventEmitter } = require('events');
        const raw: any = new EventEmitter();
        raw.query = jest.fn(async (text: string) => {
          captured.push(text);
          return { command: text, rowCount: 0, rows: [] };
        });
        raw.release = jest.fn();
        return raw;
      };
      const client = await pool.connect();
      await client.begin();
      await client.commit();
      await client.rollback();
      expect(captured).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK']);
      client.release();
    });

    it('release removes the error listener and releases the client', async () => {
      const pool = new PgPool(baseConfig);
      let raw: any;
      pgMock.default.Pool.instances[0].connectImpl = async () => {
        const { EventEmitter } = require('events');
        raw = new EventEmitter();
        raw.query = jest.fn();
        raw.release = jest.fn();
        return raw;
      };
      const client = await pool.connect();
      expect(raw.listenerCount('error')).toBe(1);
      client.release();
      expect(raw.listenerCount('error')).toBe(0);
      expect(raw.release).toHaveBeenCalledTimes(1);
    });

    it('warns on checked-out client error', async () => {
      const pool = new PgPool(baseConfig);
      let raw: any;
      pgMock.default.Pool.instances[0].connectImpl = async () => {
        const { EventEmitter } = require('events');
        raw = new EventEmitter();
        raw.query = jest.fn();
        raw.release = jest.fn();
        return raw;
      };
      const client = await pool.connect();
      raw.emit('error', new Error('mid-query boom'));
      expect(emitWarningSpy).toHaveBeenCalledWith(expect.stringContaining('Checked-out client error'));
      client.release();
    });

    it('warns POOL LEAK SUSPECT after the leak threshold, and POOL RELEASE after a leak suspect', async () => {
      jest.useFakeTimers();
      try {
        const pool = new PgPool(baseConfig);
        let raw: any;
        pgMock.default.Pool.instances[0].connectImpl = async () => {
          const { EventEmitter } = require('events');
          raw = new EventEmitter();
          raw.query = jest.fn();
          raw.release = jest.fn();
          return raw;
        };
        const client = await pool.connect();
        jest.advanceTimersByTime(60 * 1000);
        expect(emitWarningSpy).toHaveBeenCalledWith(expect.stringContaining('POOL LEAK SUSPECT'));
        client.release();
        expect(emitWarningSpy).toHaveBeenCalledWith(expect.stringContaining('POOL RELEASE (after leak suspect)'));
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
