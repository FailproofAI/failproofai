/**
 * Minimal ambient types for the pure-JS (asm.js) build of sql.js, which we
 * import by subpath (`sql.js/dist/sql-asm.js`) so there is no `.wasm` to ship or
 * locate. We only use a small read-only slice of the API.
 */
declare module "sql.js/dist/sql-asm.js" {
  export interface SqlJsStatement {
    bind(params?: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): boolean;
  }
  export interface SqlJsDatabase {
    prepare(sql: string): SqlJsStatement;
    run(sql: string, params?: unknown[]): void;
    export(): Uint8Array;
    close(): void;
  }
  export interface SqlJsStatic {
    Database: new (data?: Uint8Array | null) => SqlJsDatabase;
  }
  export interface InitSqlJsConfig {
    locateFile?: (file: string) => string;
  }
  export default function initSqlJs(config?: InitSqlJsConfig): Promise<SqlJsStatic>;
}
