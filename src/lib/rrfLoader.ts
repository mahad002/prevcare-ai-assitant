/**
 * rrfLoader.ts
 * RRF File Loader → Concept[]
 * Uses RXNCONSO.RRF (and optionally TTY filter) to build concepts compatible with approxMatch.ts
 */

import { readFile } from "fs/promises";
import type { Concept, TTY } from "./approxMatch";

export interface MedicationRow {
  rxcui: string;
  tty: string;
  str: string;
  code: string;
  sab: string;
}

export function parseRrfLine(line: string): MedicationRow | null {
  const parts = line.trim().split("|");
  if (parts.length < 15) return null;

  const rxcui = parts[0].trim();
  const tty = parts[12]?.trim() || "";
  const code = parts[13]?.trim() || "";
  const str = parts[14]?.trim() || "";
  const sab = parts[11]?.trim() || "RXNORM";

  if (!rxcui || !tty || !str) return null;
  if (sab !== "RXNORM") return null;

  return { rxcui, tty, str, code, sab };
}

/**
 * Extract route and form from STR in an RxNav-like way.
 * - Injection route recognized by "Injection", "Injectable", Cartridge, Syringe, Vial, Auto-Injector, Pen Injector.
 * - Inhalation / Gas for Inhalation handled explicitly.
 */
function extractRouteAndForm(
  str: string
): { route?: string; form?: string } {
  const lower = str.toLowerCase();
  const out: { route?: string; form?: string } = {};

  // Route
  if (lower.includes("gas for inhalation")) {
    out.route = "for Inhalation";
  } else if (lower.includes("for inhalation")) {
    out.route = "for Inhalation";
  } else if (lower.includes("oral")) {
    out.route = "Oral";
  } else if (lower.includes("injection") || lower.includes("injectable")) {
    out.route = "Injection";
  } else if (lower.includes("topical")) {
    out.route = "Topical";
  } else if (lower.includes("transdermal")) {
    out.route = "Transdermal";
  } else if (lower.includes("inhalation")) {
    out.route = "Inhalation";
  }

  // Form
  if (lower.includes("gas for inhalation")) {
    out.form = "Gas for Inhalation";
  } else if (lower.includes("metered dose inhaler")) {
    out.form = "Metered Dose Inhaler";
  } else if (lower.includes("dry powder inhaler")) {
    out.form = "Dry Powder Inhaler";
  } else if (lower.includes("soft mist inhaler")) {
    out.form = "Soft Mist Inhaler";
  } else if (lower.includes("prefilled syringe")) {
    out.form = "Prefilled Syringe";
  } else if (lower.includes("auto-injector")) {
    out.form = "Auto-Injector";
  } else if (lower.includes("pen injector")) {
    out.form = "Pen Injector";
  } else if (lower.includes("cartridge")) {
    out.form = "Cartridge";
  } else if (lower.includes("injectable solution")) {
    out.form = "Injectable Solution";
  } else if (lower.includes("injection") && !lower.includes("solution")) {
    out.form = "Injection";
  } else if (lower.includes("oral tablet") || lower.endsWith(" tablet")) {
    out.form = "Oral Tablet";
  } else if (lower.includes("tablet")) {
    out.form = "Tablet";
  } else if (lower.includes("capsule")) {
    out.form = "Capsule";
  } else if (lower.includes("suspension")) {
    out.form = "Suspension";
  } else if (lower.includes("solution")) {
    out.form = "Solution";
  } else if (lower.includes("cream")) {
    out.form = "Cream";
  } else if (lower.includes("gel")) {
    out.form = "Gel";
  } else if (lower.includes("lotion")) {
    out.form = "Lotion";
  } else if (lower.includes("ointment")) {
    out.form = "Ointment";
  } else if (lower.includes("system")) {
    out.form = "System";
  }

  // If form implies injection but route missing, assume Injection route
  if (
    !out.route &&
    out.form &&
    [
      "Cartridge",
      "Prefilled Syringe",
      "Vial",
      "Auto-Injector",
      "Pen Injector",
      "Injectable Solution",
      "Injection",
    ].includes(out.form)
  ) {
    out.route = "Injection";
  }

  return out;
}

/**
 * Very light ingredient extraction – approxTerm-style: treat "drug words"
 * as tokens that are not units, not dosage forms, not numbers.
 */
function extractIngredientsFromStr(str: string): string[] {
  let working = str.replace(/\[[^\]]*]/g, " ");
  working = working.replace(/\([^)]*\)/g, " ");
  working = working.replace(/[\/,+]/g, " ");
  const toks = working
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  const stop = new Set([
    "tablet",
    "tablets",
    "capsule",
    "capsules",
    "solution",
    "suspension",
    "cream",
    "gel",
    "lotion",
    "ointment",
    "oral",
    "injection",
    "injectable",
    "inhalation",
    "for",
    "topical",
    "transdermal",
    "system",
    "gas",
    "dose",
    "mg",
    "ml",
    "g",
    "unit",
    "units",
    "%",
    "hr",
    "actuat",
    "syringe",
    "cartridge",
    "vial",
    "auto-injector",
    "pen",
  ]);

  const ingredients: string[] = [];
  let current: string[] = [];

  for (const tok of toks) {
    if (stop.has(tok) || /^[0-9]/.test(tok)) {
      if (current.length) {
        ingredients.push(current.join(" "));
        current = [];
      }
      continue;
    }
    current.push(tok);
  }

  if (current.length) ingredients.push(current.join(" "));

  return Array.from(new Set(ingredients));
}

/**
 * Extract brand name from STR, if represented as [Brand].
 * If no brackets, returns undefined. approxMatch will still parse [Brand] for queries.
 */
function extractBrandFromStr(str: string, tty: string): string | undefined {
  if (tty !== 'SBD') {
    return undefined;
  }
  const m = str.match(/\[([^\]]+)\]/);
  if (m) return m[1].trim();
  return undefined;
}

/**
 * Convert parsed rows → Concept[]
 * Prefer SCD/SBD over other TTYs when multiple STR share the same RXCUI.
 */
export function rowsToConcepts(rows: MedicationRow[]): Concept[] {
  const map = new Map<string, Concept>();

  for (const row of rows) {
    const existing = map.get(row.rxcui);

    // prefer SCD/SBD over others
    if (existing) {
      const existingIsPreferred =
        existing.tty === "SCD" || existing.tty === "SBD";
      const newIsPreferred = row.tty === "SCD" || row.tty === "SBD";

      if (!existingIsPreferred && newIsPreferred) {
        const { route, form } = extractRouteAndForm(row.str);
        const ingredients = extractIngredientsFromStr(row.str);
        const brand = extractBrandFromStr(row.str, row.tty);
        map.set(row.rxcui, {
          rxcui: row.rxcui,
          name: row.str,
          tty: row.tty as TTY,
          route,
          form,
          ingredients,
          brand,
        });
      }

      continue;
    }

    const { route, form } = extractRouteAndForm(row.str);
    const ingredients = extractIngredientsFromStr(row.str);
    const brand = extractBrandFromStr(row.str, row.tty);

    map.set(row.rxcui, {
      rxcui: row.rxcui,
      name: row.str,
      tty: row.tty as TTY,
      route,
      form,
      ingredients,
      brand,
    });
  }

  return Array.from(map.values());
}

/**
 * Load RXNCONSO.RRF → Concept[]
 * @param filePath path to RXNCONSO.RRF
 * @param filterTty optional set of TTYs to keep (e.g., new Set(['SCD','SBD','SCDC','SBDC']))
 */
export async function loadRrfFileToConcepts(
  filePath: string,
  filterTty?: Set<string>
): Promise<Concept[]> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split(/\r?\n/);
  const rows: MedicationRow[] = [];
  const seenStrs = new Set<string>();

  for (const line of lines) {
    if (!line.trim()) continue;
    const row = parseRrfLine(line);
    if (!row) continue;

    if (filterTty && !filterTty.has(row.tty)) continue;

    // dedup by STR
    if (seenStrs.has(row.str)) continue;
    seenStrs.add(row.str);

    rows.push(row);
  }

  return rowsToConcepts(rows);
}
