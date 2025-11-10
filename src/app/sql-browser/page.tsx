"use client";

import type { ChangeEvent } from "react";
import { useEffect, useMemo, useState, useCallback } from "react";

type QueryExecResult = {
  columns: string[];
  values: unknown[][];
};

type TableColumn = {
  name: string;
  type: string;
};

type TableData = {
  columns: TableColumn[];
  rows: Array<Record<string, unknown>>;
};

type QueryResult = {
  result: QueryExecResult | null;
  rows: Array<Record<string, unknown>>;
};

const SQL_DUMP_PATH = "/Medication%201.sql";
const SQL_WASM_JS_PATH = "/sql-wasm.js";
const SQL_WASM_PATH = "/sql-wasm.wasm";
const PAGE_SIZE = 50;

type Statement = {
  bind(values?: unknown[] | Record<string, unknown>): void;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  free(): void;
};

type Database = {
  run(sql: string): void;
  exec(sql: string): QueryExecResult[];
  prepare(sql: string): Statement;
  close(): void;
};

type SqlJsStatic = {
  Database: {
    new (data?: Uint8Array): Database;
  };
};

declare global {
  interface Window {
    initSqlJs?: (config?: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>;
  }
}

let sqlJsInstance: Promise<SqlJsStatic> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load script ${src}`));
    document.body.appendChild(script);
  });
}

async function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsInstance) {
    sqlJsInstance = (async () => {
      if (typeof window === "undefined") {
        throw new Error("sql.js must be loaded in the browser");
      }
      await loadScript(SQL_WASM_JS_PATH);
      if (typeof window.initSqlJs !== "function") {
        throw new Error("initSqlJs was not found after loading script");
      }
      return window.initSqlJs({ locateFile: () => SQL_WASM_PATH });
    })();
  }
  return sqlJsInstance;
}

function sanitizeSqlDump(rawSql: string): string {
  const normalized = rawSql.replace(/\r\n/g, "\n");
  return normalized
    .replace(/\/\*![\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "")
    .replace(/^SET\s+[^;]+;$/gim, "")
    .replace(/^START\s+TRANSACTION;$/gim, "")
    .replace(/^COMMIT;$/gim, "")
    .replace(/^LOCK\s+TABLES\s+[^;]+;$/gim, "")
    .replace(/^UNLOCK\s+TABLES;$/gim, "")
    .replace(/\)\s*ENGINE=[^;]+;/g, ");")
    .replace(/DEFAULT\s+CHARSET=[^;]+/gi, "")
    .replace(/COLLATE=[^;]+/gi, "")
    .replace(/`/g, '"')
    .replace(/\s+AUTO_INCREMENT=\d+/gi, "");
}

function execAllStatements(db: Database, sql: string): void {
  const statements = sql
    .split(/;\s*(?=\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    try {
      const finalStatement = statement.endsWith(";") ? statement : `${statement};`;
      db.run(finalStatement);
    } catch (err) {
      console.warn("Failed to execute statement", statement, err);
    }
  }
}

function getTables(db: Database): string[] {
  const result = db.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"
  );
  if (!result.length) return [];
  const [tableResult] = result;
  return tableResult.values.map((row: QueryExecResult["values"][number]) => String(row[0]));
}

function getTableColumns(db: Database, tableName: string): TableColumn[] {
  const stmt = db.prepare(`PRAGMA table_info("${tableName}");`);
  const columns: TableColumn[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as Record<string, unknown>;
    columns.push({
      name: String(row.name ?? ""),
      type: String(row.type ?? ""),
    });
  }
  stmt.free();
  return columns;
}

function loadTableData(
  db: Database,
  tableName: string,
  columns: TableColumn[],
  searchTerm: string,
  page: number
): TableData {
  const searchable = columns.filter((column) =>
    /CHAR|CLOB|TEXT|BLOB|VARCHAR|STRING|DATE/i.test(column.type)
  );
  const activeColumns = searchable.length > 0 ? searchable : columns;

  const filters = searchTerm.trim()
    ? `WHERE ${activeColumns
        .map((column) => `"${column.name}" LIKE ?`)
        .join(" OR ")}`
    : "";

  const sql = `SELECT * FROM "${tableName}" ${filters} LIMIT ${PAGE_SIZE} OFFSET ${
    page * PAGE_SIZE
  };`;
  const stmt = db.prepare(sql);
  if (filters) {
    const params = Array(activeColumns.length).fill(`%${searchTerm.trim()}%`);
    stmt.bind(params);
  }

  const rows: Array<Record<string, unknown>> = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();

  return {
    columns,
    rows,
  };
}

function runArbitraryQuery(db: Database, sql: string): QueryResult {
  try {
    const result = db.exec(sql);
    if (!result.length) {
      return { result: null, rows: [] };
    }
    const [first] = result;
    const rows = first.values.map((valueRow: QueryExecResult["values"][number]) => {
      return first.columns.reduce<Record<string, unknown>>((acc, column: string, columnIndex: number) => {
        acc[column] = valueRow[columnIndex];
        return acc;
      }, {});
    });
    return { result: first, rows };
  } catch (error) {
    throw error;
  }
}

export default function SqlBrowserPage() {
  const [db, setDb] = useState<Database | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tables, setTables] = useState<string[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [page, setPage] = useState(0);
  const [tableData, setTableData] = useState<TableData | null>(null);
  const [customSql, setCustomSql] = useState("SELECT * FROM \"Medication\" LIMIT 50;");
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);

  useEffect(() => {
    const loadDatabase = async () => {
      try {
        setLoading(true);
        const SQL = await getSqlJs();
        const response = await fetch(SQL_DUMP_PATH);
        if (!response.ok) {
          throw new Error(`Unable to fetch SQL dump (status ${response.status})`);
        }
        const rawSql = await response.text();
        const sanitizedSql = sanitizeSqlDump(rawSql);
        const database = new SQL.Database();
        execAllStatements(database, sanitizedSql);
        const tableNames = getTables(database);
        setDb(database);
        setTables(tableNames);
        setSelectedTable((current) => current ?? tableNames[0] ?? null);
        setError(null);
      } catch (err) {
        console.error(err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };

    loadDatabase();
  }, []);

  const selectedTableColumns = useMemo(() => {
    if (!db || !selectedTable) return [];
    return getTableColumns(db, selectedTable);
  }, [db, selectedTable]);

  useEffect(() => {
    if (!db || !selectedTable || selectedTableColumns.length === 0) return;
    try {
      const data = loadTableData(db, selectedTable, selectedTableColumns, searchTerm, page);
      setTableData(data);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [db, selectedTable, selectedTableColumns, searchTerm, page]);

  const handleTableChange = useCallback((tableName: string) => {
    setSelectedTable(tableName);
    setPage(0);
    setTableData(null);
  }, []);

  const handleSearchChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(event.target.value);
    setPage(0);
    setTableData(null);
  }, []);

  const handleRefresh = useCallback(() => {
    if (!db || !selectedTable || selectedTableColumns.length === 0) return;
    try {
      const data = loadTableData(db, selectedTable, selectedTableColumns, searchTerm, page);
      setTableData(data);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [db, selectedTable, selectedTableColumns, searchTerm, page]);

  const handleRunQuery = useCallback(() => {
    if (!db) return;
    try {
      setQueryError(null);
      const trimmed = customSql.trim();
      if (!trimmed) {
        setQueryResult(null);
        return;
      }
      const result = runArbitraryQuery(db, trimmed);
      setQueryResult(result);
    } catch (err) {
      setQueryResult(null);
      setQueryError(err instanceof Error ? err.message : String(err));
    }
  }, [db, customSql]);

  useEffect(() => {
    return () => {
      db?.close();
    };
  }, [db]);

  if (loading) {
    return (
      <div className="mx-auto mt-10 max-w-5xl">
        <h1 className="text-2xl font-semibold">Medication SQL Browser</h1>
        <p className="mt-4 text-gray-600">Loading SQL dump…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto mt-10 max-w-5xl">
        <h1 className="text-2xl font-semibold">Medication SQL Browser</h1>
        <p className="mt-4 text-red-600">Failed to load SQL data: {error}</p>
      </div>
    );
  }

  if (!db) {
    return null;
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold">Medication SQL Browser</h1>
        <p className="text-sm text-gray-600">
          Loaded from <code>public/Medication 1.sql</code>. Use the controls below to browse tables,
          search records, or run ad-hoc SQL queries.
        </p>
      </header>

      <section className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium" htmlFor="table">
              Table
            </label>
            <select
              id="table"
              value={selectedTable ?? ""}
              onChange={(event) => handleTableChange(event.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm md:w-64"
            >
              {tables.map((table) => (
                <option key={table} value={table}>
                  {table}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-1 flex-col gap-1 md:max-w-sm">
            <label className="text-sm font-medium" htmlFor="search">
              Search
            </label>
            <input
              id="search"
              type="text"
              placeholder="Search across visible columns"
              value={searchTerm}
              onChange={handleSearchChange}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            className="mt-2 inline-flex items-center justify-center rounded border border-gray-300 px-4 py-2 text-sm font-medium shadow-sm transition hover:bg-gray-50 md:mt-6"
          >
            Refresh
          </button>
        </div>

        <div className="overflow-x-auto">
          {tableData && tableData.rows.length > 0 ? (
            <table className="min-w-full divide-y divide-gray-200 text-left text-xs">
              <thead className="bg-gray-50">
                <tr>
                  {tableData.columns.map((column) => (
                    <th key={column.name} className="px-3 py-2 font-semibold text-gray-700">
                      {column.name}
                      <span className="ml-1 text-[10px] uppercase text-gray-400">{column.type}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {tableData.rows.map((row, rowIndex) => (
                  <tr key={rowIndex} className="hover:bg-gray-50">
                    {tableData.columns.map((column) => (
                      <td key={column.name} className="whitespace-pre-wrap px-3 py-2 font-mono text-[11px] text-gray-700">
                        {String(row[column.name] ?? "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-gray-500">No rows found for this table.</p>
          )}
        </div>
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>
            Showing up to {PAGE_SIZE} rows per page. {searchTerm ? "Search term applied." : ""}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page === 0}
              onClick={() => setPage((prev) => Math.max(prev - 1, 0))}
              className="rounded border border-gray-300 px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
            >
              Previous
            </button>
            <span>Page {page + 1}</span>
            <button
              type="button"
              onClick={() => setPage((prev) => prev + 1)}
              className="rounded border border-gray-300 px-2 py-1 text-xs"
            >
              Next
            </button>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Ad-hoc SQL</h2>
          <button
            type="button"
            onClick={handleRunQuery}
            className="inline-flex items-center justify-center rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700"
          >
            Run query
          </button>
        </header>
        <textarea
          value={customSql}
          onChange={(event) => setCustomSql(event.target.value)}
          rows={5}
          className="w-full rounded border border-gray-300 px-3 py-2 font-mono text-sm"
          placeholder="Write your SQL here"
        />
        {queryError ? (
          <p className="text-sm text-red-600">{queryError}</p>
        ) : null}
        {queryResult ? (
          <div className="overflow-x-auto">
            {queryResult.rows.length > 0 ? (
              <table className="min-w-full divide-y divide-gray-200 text-left text-xs">
                <thead className="bg-gray-50">
                  <tr>
                    {queryResult.result?.columns.map((column: string) => (
                      <th key={column} className="px-3 py-2 font-semibold text-gray-700">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {queryResult.rows.map((row, rowIndex) => (
                    <tr key={rowIndex} className="hover:bg-gray-50">
                      {queryResult.result?.columns.map((column: string) => (
                        <td key={column} className="whitespace-pre-wrap px-3 py-2 font-mono text-[11px] text-gray-700">
                          {String((row as Record<string, unknown>)[column] ?? "")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-gray-500">Query executed. No rows returned.</p>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}

