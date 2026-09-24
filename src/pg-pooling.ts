import pg from 'pg';
import util from 'util';

// PostgreSQLのDATE型をYYYY-MM-DD文字列に変換して返却する設定
// PGドライバーのデフォルトの挙動だとprocess.env.TZに依存したJSDateオブジェクトに変換されてしまうため、DATE型なのに予期しないゾーン情報が含まれてしまうことがある
// SQLの段階でカラムを指定してセレクトできる場合は`SELECT xx_date::TEXT`のように記述すればSQLレベルでYYYY-MM-DD文字列に変換される
pg.types.setTypeParser(1082, (v) => v);

export interface PgPoolOptions {
  debug?: boolean;
}

const logHeader = '[PgPooling]';

// 各種タイムアウトの既定値。configで未指定の項目にだけ適用する
const DEFAULT_CONNECTION_TIMEOUT_MS = 10 * 1000; // プールが枯渇したときに無限待ちせず失敗させる
const DEFAULT_STATEMENT_TIMEOUT_MS = 30 * 1000; // サーバ側でクエリを打ち切る
const DEFAULT_QUERY_TIMEOUT_MS = 35 * 1000; // 応答が返らない(ソケットが死んでいる)場合。サーバ側より長くする
const DEFAULT_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS = 60 * 1000; // トランザクションを開いたまま放置されたセッションをサーバ側で終了させる
const DEFAULT_KEEP_ALIVE = true;
const DEFAULT_KEEP_ALIVE_INITIAL_DELAY_MS = 10 * 1000;

// 接続の取得がこの時間を超えた場合に警告する。正常時の取得は新規接続の確立を含めても数百msで収まる
const ACQUIRE_WARN_MS = 1000;
// 接続の保持がこの時間を超えた場合にリーク疑いとして警告する。
// 1クエリの上限(statement_timeout/query_timeout)より長く、サーバ側が放置セッションを切断するidle_in_transaction_session_timeoutと同じ長さ
const LEAK_WARN_MS = 60 * 1000;

export class PgPool {
  private pool: pg.Pool;
  private readonly debug: boolean;

  constructor(config: pg.PoolConfig, options?: PgPoolOptions) {
    this.debug = options?.debug ?? false;
    // 各種タイムアウトの既定値を適用する。configで指定された項目はそのまま優先する
    const mergedConfig: pg.PoolConfig = {
      connectionTimeoutMillis: DEFAULT_CONNECTION_TIMEOUT_MS,
      statement_timeout: DEFAULT_STATEMENT_TIMEOUT_MS,
      query_timeout: DEFAULT_QUERY_TIMEOUT_MS,
      idle_in_transaction_session_timeout: DEFAULT_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS,
      keepAlive: DEFAULT_KEEP_ALIVE,
      keepAliveInitialDelayMillis: DEFAULT_KEEP_ALIVE_INITIAL_DELAY_MS,
      ...config
    };
    this.pool = new pg.Pool(mergedConfig);
    this.pool.on('error', (error: Error) => {
      // アイドル接続のエラーはプールに通知する
      // リスナーが無いとプロセスが落ちるため必ず登録する
      process.emitWarning(`${logHeader} Idle client error. ${error.message}`);
    });
  }

  public getOriginalPool(): pg.Pool {
    return this.pool;
  }

  public async connect(): Promise<PgClient> {
    const start = Date.now();
    try {
      const client = await this.pool.connect();
      const elapsedMs = Date.now() - start;
      const stats = this.poolStats();
      // 取得に時間がかかった、あるいは取得待ちの要求が滞留している場合はプール枯渇の前兆として警告する
      if (ACQUIRE_WARN_MS <= elapsedMs || 0 < stats.waiting) {
        process.emitWarning(`${logHeader} POOL ACQUIRE SLOW. ${JSON.stringify({ elapsedMs, ...stats })}`);
      }
      return new PgClient(client, this.debug);
    } catch (error) {
      // connectionTimeoutMillisによる取得失敗を無言にしない
      process.emitWarning(`${logHeader} POOL CONNECT FAILED. ${JSON.stringify({ elapsedMs: Date.now() - start, ...this.poolStats() })} ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * プールの利用状況
   *
   * @returns {{ total: number; idle: number; waiting: number; }}
   */
  private poolStats(): { total: number; idle: number; waiting: number; } {
    return {
      total: this.pool.totalCount, // プールが保持している接続数
      idle: this.pool.idleCount, // うち貸出可能な接続数
      waiting: this.pool.waitingCount // 接続を取得できずに待機している要求数
    };
  }

  public async end(): Promise<void> {
    return this.pool.end();
  }

  public get totalCount(): number {
    return this.pool.totalCount;
  }

  public get idleCount(): number {
    return this.pool.idleCount;
  }

  public get waitingCount(): number {
    return this.pool.waitingCount;
  }
}

export class PgClient {
  private client: pg.PoolClient;
  private readonly debug: boolean;
  private acquiredAt = Date.now();
  private leakTimer: ReturnType<typeof setTimeout>;
  private leakWarned = false;
  // 貸出中のクライアントに個別のエラーリスナーを設定
  // これが無いとDB側の瞬断でリスナー不在のerrorイベントが発生し、プロセスが落ちる
  private errorListener = (error: Error) => {
    process.emitWarning(`${logHeader} Checked-out client error. ${error.message}`);
  };

  constructor(client: pg.PoolClient, debug = false) {
    this.client = client;
    this.debug = debug;
    this.client.on('error', this.errorListener);
    // リークした接続の取得元を特定できるように、取得時点のスタックトレースを保持する
    const acquireStack = new Error('acquired here').stack;
    this.leakTimer = setTimeout(() => {
      this.leakWarned = true;
      process.emitWarning(`${logHeader} POOL LEAK SUSPECT. ${JSON.stringify({ heldMs: Date.now() - this.acquiredAt })}\n${acquireStack}`);
    }, LEAK_WARN_MS);
    // タイマーが残っていてもプロセスの終了を妨げないようにする
    this.leakTimer.unref();
  }

  public async query<R extends pg.QueryResult = pg.QueryResult>(text: string, values?: any[], options?: {
    suppressLog?: boolean
  }): Promise<R> {
    if (!options?.suppressLog) {
      this.debugLog(logHeader, 'SQL', text, values);
    }
    const result = await this.client.query(text, values);
    if (!options?.suppressLog) {
      this.debugLog(logHeader, 'SQL RESULT', {
        command: result.command,
        rowCount: result.rowCount,
        rows: Array.isArray(result.rows)
          ? util.inspect(result.rows.slice(0, 3), false, null)
          : util.inspect(result.rows, false, null)
      });
    }
    return result as unknown as R;
  }

  public release(): void {
    clearTimeout(this.leakTimer);
    if (this.leakWarned) {
      // リーク疑い警告後に返却されたことを記録する。警告後にこのログが無ければ本物のリークと判断できる
      process.emitWarning(`${logHeader} POOL RELEASE (after leak suspect). ${JSON.stringify({ heldMs: Date.now() - this.acquiredAt })}`);
    }
    // 返却後はプール側のリスナー(pool.on('error'))が受け持つ
    this.client.removeListener('error', this.errorListener);
    this.client.release();
  }

  public async begin(): Promise<pg.QueryResult> {
    this.debugLog(logHeader, 'BEGIN');
    return this.client.query('BEGIN');
  }

  public async commit(): Promise<pg.QueryResult> {
    this.debugLog(logHeader, 'COMMIT');
    return this.client.query('COMMIT');
  }

  public async rollback(): Promise<pg.QueryResult> {
    this.debugLog(logHeader, 'ROLLBACK');
    return this.client.query('ROLLBACK');
  }

  private debugLog(...args: any[]): void {
    if (this.debug) {
      console.debug(...args);
    }
  }
}
