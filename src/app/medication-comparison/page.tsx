"use client";

import type { ChangeEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

type QueryExecResult = {
  columns: string[];
  values: unknown[][];
};

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

type MedicationRow = {
  medicationid: string;
  rxcui: string;
  tty: string | null;
  code: string | null;
  str: string;
  atn: string | null;
  atv: string | null;
};

type MedicationFeatures = {
  canonical: string;
  tokens: Set<string>;
  ingredients: Set<string>;
  strengths: Set<string>;
  forms: Set<string>;
  routes: Set<string>;
  brands: Set<string>;
  numbers: Set<string>;
};

type MedicationRecord = MedicationRow & {
  features: MedicationFeatures;
};

type ScoredMedication = {
  record: MedicationRecord;
  score: number;
  lexicalScore: number;
  ingredientScore: number;
  strengthScore: number;
  formScore: number;
  routeScore: number;
  brandScore: number;
  numberScore: number;
  reason: string;
};

const SQL_DUMP_PATH = "/Medication%201.sql";
const SQL_WASM_JS_PATH = "/sql-wasm.js";
const SQL_WASM_PATH = "/sql-wasm.wasm";
const DEFAULT_TOP_K = 10;

const FORM_TOKENS = new Set([
  "TABLET",
  "CAPSULE",
  "CAP",
  "TAB",
  "INHALER",
  "INHAL",
  "SUSP",
  "SUSPENSION",
  "SOL",
  "SOLUTION",
  "CREAM",
  "GEL",
  "OINTMENT",
  "PATCH",
  "LOTION",
  "SPRAY",
  "GRANULES",
  "GRANULE",
  "LOZENGE",
  "MOUTHWASH",
  "SYRINGE",
  "INJECTION",
  "GRANULE",
  "GRANULES",
  "POWDER",
  "POWDERED",
  "SHAMPOO",
  "FOAM",
  "PASTE",
  "DROPS",
  "SOLUTION",
  "SUPPOSITORY",
  "AEROSOL",
  "TOOTHPASTE",
  "ELIXIR",
  "SACHET",
  "DISINTEGRATING",
  "ELIXIR",
  "DRIP",
]);

const ROUTE_TOKENS = new Set([
  "ORAL",
  "TOPICAL",
  "OPHTHALMIC",
  "INTRAMUSCULAR",
  "SUBCUTANEOUS",
  "SUBLINGUAL",
  "RECTAL",
  "NASAL",
  "INTRAVENOUS",
  "VAGINAL",
  "INHALATION",
  "AURICULAR",
  "DERMAL",
  "INTRADERMAL",
  "BUCCAL",
  "OTIC",
  "GASTRIC",
  "TRANSDERMAL",
]);

const UNIT_TOKENS = new Set([
  "MG",
  "MCG",
  "G",
  "ML",
  "UNT",
  "UNIT",
  "UNITS",
  "ACTUAT",
  "%",
  "HR",
  "HOUR",
]);

const STOP_TOKENS = new Set([
  "AND",
  "WITH",
  "WITHOUT",
  "FOR",
  "THE",
  "OF",
  "IN",
  "TO",
  "ML",
  "MG",
  "MCG",
  "HR",
  "HOUR",
  "ACTUAT",
  "UNT",
  "UNIT",
  "UNITS",
  "MG/ML",
  "MG/MG",
  "MG/HR",
  "MCG/ACTUAT",
  "MG/ACTUAT",
  "ML/ML",
  "MG/L",
  "GM",
  "G",
  "METERED",
  "DOSE",
  "EXTENDED",
  "RELEASE",
  "IMMEDIATE",
  "DELIVERED",
  "SYSTEM",
  "PER",
  "DAY",
  "DAYS",
  "HOURS",
  "HR",
  "SLOW",
  "FAST",
  "LONG",
  "SHORT",
  "CHEWABLE",
  "DISPERSIBLE",
  "COATED",
  "ENTERIC",
  "SUGAR",
  "FREE",
  "FREEZER",
  "PREFILLED",
  "PREFIL",
  "PEN",
  "PREFILLED",
  "DOSE",
  "METERED",
  "DOSED",
  "MULTIDOSE",
  "SINGLE",
  "COMPRESSED",
  "TRANSDERMAL",
  "EXT",
  "REL",
  "XR",
  "ER",
  "SR",
]);

const CANONICAL_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bMILLIGRAMS?\b/gi, "MG"],
  [/\bMICROGRAMS?\b/gi, "MCG"],
  [/\bGRAMS?\b/gi, "G"],
  [/\bUNITS?\b/gi, "UNIT"],
  [/\bHOURS?\b/gi, "HR"],
  [/\bACTUATIONS?\b/gi, "ACTUAT"],
  [/\bACTUATE\b/gi, "ACTUAT"],
  [/\bMILLILITERS?\b/gi, "ML"],
  [/\bSUSPENSION\b/gi, "SUSP"],
  [/\bSOLUTIONS?\b/gi, "SOL"],
  [/\bAEROSOL(S)?\b/gi, "AEROSOL"],
  [/\bCAPSULES?\b/gi, "CAPSULE"],
  [/\bTABLETS?\b/gi, "TABLET"],
  [/\bPOWDER FOR ORAL SUSPENSION\b/gi, "POWDER SUSP"],
  [/\bORAL POWDER FOR SUSPENSION\b/gi, "POWDER SUSP"],
  [/\bPOWDER FOR SUSPENSION\b/gi, "POWDER SUSP"],
  [/\bTOPICAL CREAM\b/gi, "CREAM"],
  [/\bTOPICAL GEL\b/gi, "GEL"],
  [/\bTOPICAL SOLUTION\b/gi, "SOL"],
  [/\bINHALATION\b/gi, "INHAL"],
  [/\bMETERED DOSE\b/gi, "METERED DOSE"],
  [/\bEXTENDED RELEASE\b/gi, "EXTENDED RELEASE"],
  [/\bDELAYED RELEASE\b/gi, "DELAYED RELEASE"],
  [/\bIMMEDIATE RELEASE\b/gi, "IMMEDIATE RELEASE"],
  [/\bPOWDER\b/gi, "POWDER"],
  [/\bCAPS\b/gi, "CAPSULE"],
];

let sqlJsInstance: Promise<SqlJsStatic> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new Error("Document is not available."));
      return;
    }
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
        throw new Error("sql.js requires a browser environment.");
      }
      await loadScript(SQL_WASM_JS_PATH);
      if (typeof window.initSqlJs !== "function") {
        throw new Error("initSqlJs is not available after loading sql.js script.");
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

function canonicalizeMedicationName(name: string): string {
  let canonical = name.toUpperCase();
  canonical = canonical.replace(/[^A-Z0-9\s/\[\]]/g, " ");
  for (const [pattern, replacement] of CANONICAL_REPLACEMENTS) {
    canonical = canonical.replace(pattern, replacement);
  }
  canonical = canonical.replace(/\s+/g, " ").trim();
  return canonical;
}

function tokenize(canonical: string): string[] {
  return canonical
    .replace(/\[/g, " [")
    .replace(/\]/g, "] ")
    .split(/[\s/]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function extractBrands(canonical: string): Set<string> {
  const brands = new Set<string>();
  const matches = canonical.match(/\[[^\]]+\]/g);
  if (matches) {
    for (const match of matches) {
      const cleaned = match.replace(/[[\]]/g, "").trim();
      if (cleaned) {
        brands.add(cleaned);
      }
    }
  }
  return brands;
}

const STRENGTH_REGEX =
  /\d+(?:\.\d+)?\s?(?:MG|MCG|G|ML|UNIT|UNT|ACTUAT|%)(?:\s*\/\s*\d+(?:\.\d+)?\s?(?:MG|MCG|G|ML|UNIT|UNT|ACTUAT|%))?/g;

function extractStrengths(canonical: string): Set<string> {
  const matches = canonical.match(STRENGTH_REGEX);
  if (!matches) return new Set();
  return new Set(matches.map((value) => value.replace(/\s+/g, " ").trim()));
}

function extractNumbers(canonical: string): Set<string> {
  const matches = canonical.match(/\b\d+(?:\.\d+)?\b/g);
  if (!matches) return new Set();
  return new Set(matches);
}

function isIngredientToken(token: string): boolean {
  if (!token || /\d/.test(token)) return false;
  if (token.startsWith("[")) return false;
  if (UNIT_TOKENS.has(token) || FORM_TOKENS.has(token) || ROUTE_TOKENS.has(token)) return false;
  if (STOP_TOKENS.has(token)) return false;
  if (token.length < 3) return false;
  return /^[A-Z]+(?:[A-Z]+)?$/.test(token);
}

function extractFeatures(canonical: string): MedicationFeatures {
  const tokens = tokenize(canonical);
  const brands = extractBrands(canonical);
  const strengths = extractStrengths(canonical);
  const numbers = extractNumbers(canonical);

  const tokenSet = new Set(tokens.filter((token) => !token.startsWith("[")));
  const ingredientSet = new Set(Array.from(tokenSet).filter(isIngredientToken));
  const formSet = new Set(Array.from(tokenSet).filter((token) => FORM_TOKENS.has(token)));
  const routeSet = new Set(Array.from(tokenSet).filter((token) => ROUTE_TOKENS.has(token)));

  return {
    canonical,
    tokens: tokenSet,
    ingredients: ingredientSet,
    strengths,
    forms: formSet,
    routes: routeSet,
    brands,
    numbers,
  };
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) {
    if (b.has(value)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) {
    if (b.has(value)) {
      intersection += 1;
    }
  }
  return intersection / Math.max(a.size, b.size);
}

function singleOverlapScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  for (const value of a) {
    if (b.has(value)) {
      return 1;
    }
  }
  return 0;
}

function computeSimilarity(
  query: MedicationFeatures,
  candidate: MedicationFeatures
): Omit<ScoredMedication, "record" | "score" | "reason"> & { baseScore: number } {
  const lexical = jaccardSimilarity(query.tokens, candidate.tokens);
  const ingredient = overlapScore(query.ingredients, candidate.ingredients);
  const strength = overlapScore(query.strengths, candidate.strengths);
  const form = overlapScore(query.forms, candidate.forms);
  const route = overlapScore(query.routes, candidate.routes);
  const brand = singleOverlapScore(query.brands, candidate.brands);
  const number = overlapScore(query.numbers, candidate.numbers);

  const baseScore =
    0.45 * lexical +
    0.25 * ingredient +
    0.12 * strength +
    0.07 * form +
    0.05 * route +
    0.03 * brand +
    0.03 * number;

  let adjusted = baseScore;

  const canonicalCandidate = candidate.canonical;
  const canonicalQuery = query.canonical;

  if (canonicalCandidate.includes(canonicalQuery) || canonicalQuery.includes(canonicalCandidate)) {
    adjusted += 0.05;
  }

  if (strength === 1 && strength > 0) {
    adjusted += 0.02;
  } else if (strength === 0 && query.strengths.size > 0) {
    adjusted -= 0.02;
  }

  const ingredientPenalty =
    query.ingredients.size > 0 && candidate.ingredients.size > 0 && ingredient === 0 ? 0.05 : 0;
  if (ingredientPenalty > 0) {
    adjusted -= ingredientPenalty;
  }

  adjusted = Math.max(0, Math.min(1, adjusted));

  return {
    lexicalScore: lexical,
    ingredientScore: ingredient,
    strengthScore: strength,
    formScore: form,
    routeScore: route,
    brandScore: brand,
    numberScore: number,
    baseScore: adjusted,
  };
}

function describeReason(match: Omit<ScoredMedication, "record" | "reason" | "score">): string {
  const parts: string[] = [];
  if (match.ingredientScore > 0) {
    parts.push(
      match.ingredientScore === 1
        ? "ingredient tokens match exactly"
        : `ingredient overlap ${(match.ingredientScore * 100).toFixed(0)}%`
    );
  }
  if (match.strengthScore > 0) {
    parts.push(
      match.strengthScore === 1
        ? "strength matches"
        : `strength overlap ${(match.strengthScore * 100).toFixed(0)}%`
    );
  }
  if (match.formScore > 0) {
    parts.push("same dosage form");
  }
  if (match.routeScore > 0) {
    parts.push("same route");
  }
  if (match.brandScore > 0) {
    parts.push("brand matches");
  }
  if (!parts.length) {
    parts.push("lexical similarity only");
  }
  return parts.join("; ");
}

async function loadMedicationRows(): Promise<MedicationRow[]> {
  const SQL = await getSqlJs();
  const response = await fetch(SQL_DUMP_PATH);
  if (!response.ok) {
    throw new Error(`Failed to fetch SQL dump (status ${response.status}).`);
  }
  const rawSql = await response.text();
  const sanitized = sanitizeSqlDump(rawSql);
  const database = new SQL.Database();
  execAllStatements(database, sanitized);

  const result = database.exec(
    'SELECT "medicationid", "rxcui", "tty", "code", "str", "atn", "atv" FROM "Medication" WHERE "str" IS NOT NULL AND TRIM("str") <> "";'
  );

  const rows: MedicationRow[] = [];
  if (result.length > 0) {
    const [first] = result;
    const { columns, values } = first;
    for (const valueRow of values) {
      const row: Record<string, unknown> = {};
      columns.forEach((column, index) => {
        row[column] = valueRow[index];
      });
      rows.push({
        medicationid: String(row.medicationid ?? ""),
        rxcui: String(row.rxcui ?? ""),
        tty: row.tty == null ? null : String(row.tty),
        code: row.code == null ? null : String(row.code),
        str: String(row.str ?? ""),
        atn: row.atn == null ? null : String(row.atn),
        atv: row.atv == null ? null : String(row.atv),
      });
    }
  }

  database.close();
  return rows;
}

function buildMedicationIndex(rows: MedicationRow[]): MedicationRecord[] {
  return rows.map((row) => {
    const canonical = canonicalizeMedicationName(row.str);
    const features = extractFeatures(canonical);
    return {
      ...row,
      features,
    };
  });
}

function formatScore(value: number): string {
  return value.toFixed(3);
}

export default function MedicationComparisonPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rowsCount, setRowsCount] = useState(0);
  const [index, setIndex] = useState<MedicationRecord[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [topK, setTopK] = useState(DEFAULT_TOP_K);

  useEffect(() => {
    let isMounted = true;
    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        const rows = await loadMedicationRows();
        if (!isMounted) return;
        const indexed = buildMedicationIndex(rows);
        setIndex(indexed);
        setRowsCount(indexed.length);
        if (!searchTerm && indexed.length > 0) {
          setSearchTerm(indexed[0].str);
        }
      } catch (err) {
        console.error(err);
        if (isMounted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    load();
    return () => {
      isMounted = false;
    };
  }, []);

  const handleSearchChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setSearchTerm(event.target.value);
  }, []);

  const handleTopKChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const value = Number.parseInt(event.target.value, 10);
    if (!Number.isNaN(value)) {
      setTopK(Math.min(50, Math.max(1, value)));
    }
  }, []);

  const handleSampleClick = useCallback(() => {
    if (index.length === 0) return;
    const random = index[Math.floor(Math.random() * index.length)];
    setSearchTerm(random.str);
  }, [index]);

  const queryFeatures = useMemo(() => {
    const trimmed = searchTerm.trim();
    if (!trimmed) return null;
    const canonical = canonicalizeMedicationName(trimmed);
    return extractFeatures(canonical);
  }, [searchTerm]);

  const matches: ScoredMedication[] = useMemo(() => {
    if (!queryFeatures || index.length === 0) return [];
    const scored = index.map((record): ScoredMedication => {
      const similarity = computeSimilarity(queryFeatures, record.features);
      const reason = describeReason(similarity);
      return {
        record,
        score: similarity.baseScore,
        lexicalScore: similarity.lexicalScore,
        ingredientScore: similarity.ingredientScore,
        strengthScore: similarity.strengthScore,
        formScore: similarity.formScore,
        routeScore: similarity.routeScore,
        brandScore: similarity.brandScore,
        numberScore: similarity.numberScore,
        reason,
      };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }, [index, queryFeatures, topK]);

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold text-slate-900">Medication Comparison</h1>
        <p className="text-sm text-slate-600">
          Deterministic similarity search over the <code>public/Medication 1.sql</code> dump. The
          matcher normalizes drug strings, extracts ingredient, strength, route, form, and brand
          tokens, then ranks the closest canonical RxNorm-style entries.
        </p>
      </header>

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold text-slate-900">Dataset status</h2>
          {loading ? (
            <p className="text-sm text-slate-600">Loading medication index…</p>
          ) : error ? (
            <p className="text-sm text-red-600">Failed to load data: {error}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-4 text-sm text-slate-600">
              <span>
                Indexed <span className="font-semibold text-slate-900">{rowsCount}</span> medication
                rows
              </span>
              <span className="text-xs text-slate-400">Source: Medication.str column</span>
            </div>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-2">
          <label htmlFor="search" className="text-sm font-medium text-slate-800">
            Input medication string
          </label>
          <textarea
            id="search"
            value={searchTerm}
            onChange={handleSearchChange}
            placeholder='e.g. "60 ACTUATE albuterol 90 MCG/ACTUATE Inhalation Aerosol [Ventolin]"'
            className="min-h-[100px] w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 shadow-sm focus:border-slate-500 focus:outline-none"
          />
          <p className="text-xs text-slate-500">
            The matcher uppercases, canonically normalizes units/routes, and prioritizes ingredient
            and strength matches.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-700">
          <label className="flex items-center gap-2">
            <span>Top results</span>
            <input
              type="number"
              min={1}
              max={50}
              value={topK}
              onChange={handleTopKChange}
              className="w-20 rounded border border-slate-300 px-2 py-1 text-sm"
            />
          </label>
          <button
            type="button"
            onClick={handleSampleClick}
            className="inline-flex items-center rounded border border-slate-300 bg-slate-50 px-3 py-1 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-100"
          >
            Use random dataset example
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <header className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-slate-900">Top candidates</h2>
          <p className="text-sm text-slate-600">
            Scores combine lexical overlap, ingredient alignment, shared strengths, dosage form, and
            route compatibility.
          </p>
        </header>

        {!queryFeatures ? (
          <p className="text-sm text-slate-500">
            Enter a medication description above to generate ranked matches.
          </p>
        ) : matches.length === 0 ? (
          <p className="text-sm text-slate-500">
            No matches found. Try adjusting the input or verifying the spelling.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {matches.map((match, index) => (
              <article
                key={match.record.medicationid}
                className="flex flex-col gap-3 rounded border border-slate-200 p-4 transition hover:border-slate-300"
              >
                <header className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">
                      {index + 1}
                    </span>
                    <h3 className="text-sm font-semibold text-slate-900">
                      {match.record.str}
                    </h3>
                  </div>
                  <span className="text-sm font-semibold text-slate-900">
                    Score {formatScore(match.score)}
                  </span>
                </header>
                <dl className="grid gap-x-4 gap-y-1 text-xs text-slate-600 sm:grid-cols-2">
                  <div className="flex gap-2">
                    <dt className="font-semibold text-slate-500">RxCUI</dt>
                    <dd>{match.record.rxcui}</dd>
                  </div>
                  {match.record.code ? (
                    <div className="flex gap-2">
                      <dt className="font-semibold text-slate-500">Code</dt>
                      <dd>{match.record.code}</dd>
                    </div>
                  ) : null}
                  {match.record.tty ? (
                    <div className="flex gap-2">
                      <dt className="font-semibold text-slate-500">TTY</dt>
                      <dd>{match.record.tty}</dd>
                    </div>
                  ) : null}
                  {match.record.atn ? (
                    <div className="flex gap-2">
                      <dt className="font-semibold text-slate-500">ATN</dt>
                      <dd>{match.record.atn}</dd>
                    </div>
                  ) : null}
                  {match.record.atv ? (
                    <div className="flex gap-2">
                      <dt className="font-semibold text-slate-500">ATV</dt>
                      <dd>{match.record.atv}</dd>
                    </div>
                  ) : null}
                </dl>
                <div className="grid gap-2 rounded border border-slate-100 bg-slate-50 p-3 text-xs text-slate-600 sm:grid-cols-2 md:grid-cols-3">
                  <span>Lexical {formatScore(match.lexicalScore)}</span>
                  <span>Ingredient {formatScore(match.ingredientScore)}</span>
                  <span>Strength {formatScore(match.strengthScore)}</span>
                  <span>Form {formatScore(match.formScore)}</span>
                  <span>Route {formatScore(match.routeScore)}</span>
                  <span>Brand {formatScore(match.brandScore)}</span>
                  <span>Numbers {formatScore(match.numberScore)}</span>
                </div>
                <p className="text-xs text-slate-500">Reason: {match.reason}</p>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

