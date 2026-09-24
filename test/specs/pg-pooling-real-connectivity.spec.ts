import { PgPool } from '@/pg-pooling';

// 実接続テストなのでタイムアウトを延伸
jest.setTimeout(60 * 1000);

// 環境変数に実際に接続可能な接続情報を定義するか、テストコードを書き換えてテストを実施する
const buildConfig = () => ({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT),
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  max: 1
});

/**
 * PostgreSQLへの実接続テスト
 * GitHub-CI上ではPostgreSQLに接続できないのでコミット時は`skip`を付与
 */
describe.skip('pg-pooling real connectivity', () => {
  describe('Real connectivity', () => {
    let pool: PgPool;

    beforeEach(() => {
      pool = new PgPool(buildConfig(), { debug: false });
    });

    afterEach(async () => {
      await pool.end();
    });

    it('一般的な操作', async () => {
      const client = await pool.connect();
      try {
        const now = await client.query('SELECT NOW() AS now');
        expect(now.rows[0].now).toBeDefined();

        // DATE型がタイムゾーンに依存せずYYYY-MM-DD文字列で返ること(setTypeParser(1082))を確認
        const date = await client.query(`SELECT DATE '2026-09-24' AS d`);
        expect(date.rows[0].d).toBe('2026-09-24');
      } finally {
        client.release();
      }
    });

    it('トランザクション(commit/rollback)', async () => {
      const client = await pool.connect();
      try {
        await client.query('CREATE TEMP TABLE pg_pooling_test (id INT)');

        await client.begin();
        await client.query('INSERT INTO pg_pooling_test (id) VALUES ($1)', [1]);
        await client.commit();

        await client.begin();
        await client.query('INSERT INTO pg_pooling_test (id) VALUES ($1)', [2]);
        await client.rollback();

        const result = await client.query('SELECT id FROM pg_pooling_test ORDER BY id');
        expect(result.rows.map(row => row.id)).toEqual([1]);
      } finally {
        client.release();
      }
    });

    it('ホスト不正(接続不可)でPOOL CONNECT FAILEDを警告し例外を送出', async () => {
      const emitWarningSpy = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
      const badPool = new PgPool({
        ...buildConfig(),
        host: 'invalid-host'
      });
      try {
        await expect(badPool.connect()).rejects.toThrow();
        expect(emitWarningSpy).toHaveBeenCalledWith(expect.stringContaining('POOL CONNECT FAILED'));
      } finally {
        emitWarningSpy.mockRestore();
        await badPool.end();
      }
    });

    it('パスワード不正(接続不可)', async () => {
      const badPool = new PgPool({
        ...buildConfig(),
        password: 'invalid-password'
      });
      try {
        await expect(badPool.connect()).rejects.toThrow(/password|28P01/);
      } finally {
        await badPool.end();
      }
    });
  });
});
