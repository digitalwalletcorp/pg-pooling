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

  describe('logging', () => {
    const createLogger = () => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    });

    it('default logger does not output SQL to console when debug is false', async () => {
      const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => undefined);
      try {
        const pool = new PgPool(baseConfig);
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release();
        expect(debugSpy).not.toHaveBeenCalled();
      } finally {
        debugSpy.mockRestore();
      }
    });

    it('default logger outputs SQL to console.debug when debug is true', async () => {
      const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => undefined);
      try {
        const pool = new PgPool(baseConfig, { debug: true });
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release();
        expect(debugSpy).toHaveBeenCalledWith('[PgPooling]', 'SQL', 'SELECT 1', undefined);
      } finally {
        debugSpy.mockRestore();
      }
    });

    it('default logger outputs SQL to console.info when sqlLogLevel is info', async () => {
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
      try {
        const pool = new PgPool(baseConfig, { debug: true, sqlLogLevel: 'info' });
        const client = await pool.connect();
        await client.begin();
        client.release();
        expect(infoSpy).toHaveBeenCalledWith('[PgPooling]', 'BEGIN');
      } finally {
        infoSpy.mockRestore();
      }
    });

    it('injected logger receives SQL at debug level regardless of the debug flag', async () => {
      const logger = createLogger();
      const pool = new PgPool(baseConfig, { logger });
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      expect(logger.debug).toHaveBeenCalledWith('[PgPooling]', 'SQL', 'SELECT 1', undefined);
      expect(logger.debug).toHaveBeenCalledWith('[PgPooling]', 'SQL RESULT', expect.objectContaining({ command: 'SELECT' }));
      expect(logger.info).not.toHaveBeenCalled();
    });

    it('injected logger receives SQL at info level when sqlLogLevel is info', async () => {
      const logger = createLogger();
      const pool = new PgPool(baseConfig, { logger, sqlLogLevel: 'info' });
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      expect(logger.info).toHaveBeenCalledWith('[PgPooling]', 'SQL', 'SELECT 1', undefined);
      expect(logger.debug).not.toHaveBeenCalled();
    });

    it('suppressLog skips SQL logging', async () => {
      const logger = createLogger();
      const pool = new PgPool(baseConfig, { logger });
      const client = await pool.connect();
      await client.query('SELECT 1', [], { suppressLog: true });
      client.release();
      expect(logger.debug).not.toHaveBeenCalled();
    });

    it('injected logger receives warnings and errors instead of process.emitWarning', async () => {
      const logger = createLogger();
      const pool = new PgPool(baseConfig, { logger });
      const instance = pgMock.default.Pool.instances[0];
      instance.waitingCount = 1;
      const client = await pool.connect();
      client.release();
      expect(logger.warn).toHaveBeenCalledWith('[PgPooling]', 'POOL ACQUIRE SLOW', expect.objectContaining({ waiting: 1 }));

      const error = new Error('pool exhausted');
      instance.connectImpl = async () => {
        throw error;
      };
      await expect(pool.connect()).rejects.toThrow('pool exhausted');
      expect(logger.error).toHaveBeenCalledWith('[PgPooling]', 'POOL CONNECT FAILED', expect.any(Object), error);

      const idleError = new Error('idle boom');
      instance.emit('error', idleError);
      expect(logger.error).toHaveBeenCalledWith('[PgPooling]', 'Idle client error', idleError);
      expect(emitWarningSpy).not.toHaveBeenCalled();
    });
  });

  describe('thresholds', () => {
    const useRawClient = () => {
      let raw: any;
      pgMock.default.Pool.instances[0].connectImpl = async () => {
        const { EventEmitter } = require('events');
        raw = new EventEmitter();
        raw.query = jest.fn();
        raw.release = jest.fn();
        return raw;
      };
    };

    it('leakWarnMs overrides the leak threshold', async () => {
      jest.useFakeTimers();
      try {
        const pool = new PgPool(baseConfig, { leakWarnMs: 1000 });
        useRawClient();
        const client = await pool.connect();
        jest.advanceTimersByTime(999);
        expect(emitWarningSpy).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        expect(emitWarningSpy).toHaveBeenCalledWith(expect.stringContaining('POOL LEAK SUSPECT'));
        client.release();
      } finally {
        jest.useRealTimers();
      }
    });

    it('leakWarnMs 0 disables leak detection', async () => {
      jest.useFakeTimers();
      try {
        const pool = new PgPool(baseConfig, { leakWarnMs: 0 });
        useRawClient();
        const client = await pool.connect();
        jest.advanceTimersByTime(60 * 60 * 1000);
        client.release();
        expect(emitWarningSpy).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('acquireWarnMs 0 disables the slow acquire warning', async () => {
      const pool = new PgPool(baseConfig, { acquireWarnMs: 0 });
      pgMock.default.Pool.instances[0].waitingCount = 1;
      const client = await pool.connect();
      client.release();
      expect(emitWarningSpy).not.toHaveBeenCalled();
    });
  });
});
