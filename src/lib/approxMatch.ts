/* approxMatch.ts
 * RxNorm-style Approximate Match (TypeScript)
 * Target: Behave like RxNav approximateTerm for drug name queries.
 * - Token-based similarity with stemming & abbreviations
 * - Ingredient / "drug word" requirement
 * - Numeric similarity (strengths)
 * - Route + form aware (e.g., Injection vs Oral)
 * - Brand-aware post-sorting if query includes [Brand]
 */

export type TTY =
  | "IN"
  | "BN"
  | "SCD"
  | "SBD"
  | "SCDC"
  | "SBDC"
  | "DF"
  | "MIN"
  | "PIN"
  | "GPCK"
  | "BPCK"
  | string;

export interface Concept {
  rxcui: string;
  name: string;            // canonical display string
  tty: TTY;
  route?: string;          // e.g., "Oral", "Injection", "Topical", "for Inhalation"
  form?: string;           // e.g., "Oral Solution", "Injectable Solution", "Cartridge"
  volume?: string;         // optional, for your own use
  brand?: string;          // Brand name, if known (SBD or from [Brand] in STR)
  ingredients?: string[];  // optional, from RRF/pre-computed
  strengths?: string[];
  tokens?: string[];       // normalized tokens cached after load
}

export interface MatchResult {
  rxcui: string;
  name: string;
  score: number; // 0–1 relative score
  tty: TTY;
}

/////////////////////// Config ///////////////////////

const CFG = {
  wOverlap: 0.25,
  wJaccard: 0.10,
  wEditSim: 0.10,
  wOrder: 0.05,
  wNumeric: 0.35,
  wTTY: 0.10,
  wBrand: 0.02,
  wPenalty: 0.35,
};

/////////////////////// Lexical Tables ///////////////////////

const ABBREV: Record<string, string> = {
  tab: "tablet",
  tabs: "tablet",
  cap: "capsule",
  caps: "capsule",
  inj: "injection",
  inject: "injection",
  soln: "solution",
  sol: "solution",
  susp: "suspension",
  sr: "extended release",
  er: "extended release",
  dr: "delayed release",
  mdi: "metered dose inhaler",
  dpi: "dry powder inhaler",
  hctz: "hydrochlorothiazide",
};

const UNIT_CANON: Record<string, string> = {
  mg: "MG",
  mcg: "MCG",
  "µg": "MCG",
  ug: "MCG",
  g: "G",
  ml: "ML",
  l: "L",
  liter: "L",
  "mg/ml": "MG/ML",
  "mcg/ml": "MCG/ML",
  "mg/g": "MG/G",
  "mg/hr": "MG/HR",
  "mcg/hr": "MCG/HR",
  "unit/ml": "UNIT/ML",
  "%": "%",
  hr: "HR",
  actuat: "ACTUAT",
};

const LOW_SIGNAL = new Set([
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
  "topical",
  "transdermal",
  "system",
  "for",
  "gas",
  "inhaler",
  "release",
  "extended",
  "delayed",
  "chewable",
  "mg",
  "ml",
  "g",
  "unit",
  "units",
  "%",
  "hr",
  "actuat",
  "cartridge",
  "cartridges",
  "syringe",
  "syringes",
  "prefilled",
  "vial",
  "vials",
  "auto-injector",
  "pen",
]);

/////////////////////// Catalog & Indexes ///////////////////////

const CATALOG = new Map<string, Concept>();
const POSTINGS = new Map<string, Array<{ rxcui: string; tf: number }>>();
const NUM_INDEX = new Map<string, Set<string>>();
const TOKEN_IDF = new Map<string, number>();

/////////////////////// Normalization ///////////////////////

function toASCII(s: string): string {
  return s.normalize("NFKD");
}

function simpleStem(tok: string): string {
  if (tok.length < 4) return tok;
  return tok.replace(/(ing|ed|ly|es|s)$/i, "");
}

function canonicalUnit(tok: string): string {
  const t = tok.toLowerCase();
  if (UNIT_CANON[t]) return UNIT_CANON[t];
  return tok.toUpperCase();
}

function normalize(text: string): string[] {
  let t = toASCII(text).toLowerCase();
  // Keep /, %, [, ] and . as meaningful; other punctuation → space
  t = t.replace(/[^a-z0-9\/\[\]%\.]+/g, " ").replace(/\s+/g, " ").trim();
  let tokens = t.split(" ").filter(Boolean);

  // Expand abbreviations
  tokens = tokens.map((x) => ABBREV[x] ?? x);

  // Canonicalize simple units
  tokens = tokens.map((x) => canonicalUnit(x));

  // Split bracketed brand segments into separate tokens
  tokens = tokens
    .flatMap((x) => x.replace("[", " ").replace("]", " ").split(" "))
    .filter(Boolean);

  // Stem non-numeric, non-unit alpha tokens
  tokens = tokens.map((tok) =>
    /^[A-Z0-9%\/\.]+$/.test(tok) ? tok : simpleStem(tok)
  );

  // De-duplicate like RxNav does
  return Array.from(new Set(tokens));
}

/////////////////////// Numeric Features ///////////////////////

type NumFeat = { value: number; unitKind: string };

function parseNumeric(tokens: string[]): NumFeat[] {
  const feats: NumFeat[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    const b = tokens[i + 1]?.toUpperCase();

    // value + unit patterns: 2 MG/ML, 10 MG, 5000 UNIT/ML, etc.
    if (/^\d+(\.\d+)?$/.test(a) && b) {
      if (
        /^(MG|MCG|G|MG\/ML|MCG\/ML|MG\/G|MG\/HR|MCG\/HR|UNIT\/ML|%)$/.test(b)
      ) {
        feats.push({ value: parseFloat(a), unitKind: b });
        i++;
        continue;
      }
    }
  }

  return feats;
}

function strengthSimilarity(a: number, b: number): number {
  if (a === 0 && b === 0) return 1.0;
  if (a === 0 || b === 0) return 0.0;
  const ratio = Math.min(a, b) / Math.max(a, b);

  if (ratio >= 0.95) return 1.0;         // nearly identical
  if (ratio >= 0.5) return 0.6 * ratio;  // similar strength family
  return 0.2 * ratio;                    // weak but non-zero
}

/////////////////////// Edit distance ///////////////////////

function levenshtein(a: string, b: string): number {
  const m = a.length,
    n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  );
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function tokenEditSim(q: string[], c: string[]): number {
  const sims = q.map((qt) => {
    let best = 0;
    for (const ct of c) {
      const dist = levenshtein(qt, ct);
      const sim = 1 - dist / Math.max(qt.length, ct.length, 1);
      if (sim > best) best = sim;
    }
    return best;
  });
  return sims.length ? sims.reduce((a, b) => a + b, 0) / sims.length : 0;
}

function orderBonus(q: string[], c: string[]): number {
  let i = 0,
    j = 0,
    matches = 0;
  while (i < q.length && j < c.length) {
    if (q[i] === c[j]) {
      matches++;
      i++;
      j++;
    } else {
      j++;
    }
  }
  return Math.min(matches / Math.max(1, q.length), 0.2);
}

/////////////////////// Helpers ///////////////////////

function extractDrugWords(tokens: string[]): string[] {
  return tokens.filter((t) => {
    const lower = t.toLowerCase();
    return !LOW_SIGNAL.has(lower) && !/^[0-9\.%\/]+$/.test(t);
  });
}

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a),
    B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const uni = A.size + B.size - inter;
  return uni ? inter / uni : 0;
}

function weightedOverlap(q: string[], c: string[]): number {
  const cSet = new Set(c);
  let num = 0;
  let den = 0;
  const qSet = new Set(q);
  for (const qt of qSet) {
    const idf = TOKEN_IDF.get(qt) ?? 1;
    if (cSet.has(qt)) num += idf;
    den += idf;
  }
  return den > 0 ? num / den : 0;
}

/////////////////////// Hints ///////////////////////

function detectHints(tokens: string[]): {
  routeHint?: string;
  formHint?: string;
} {
  const set = new Set(tokens.map((t) => t.toLowerCase()));

  const routeHints = ["oral", "injection", "inhalation", "topical", "transdermal"];
  const formHints = [
    "tablet",
    "capsule",
    "solution",
    "suspension",
    "cream",
    "gel",
    "lotion",
    "inhaler",
    "system",
    "gas",
    "cartridge",
    "syringe",
    "vial",
  ];

  let routeHint: string | undefined;
  if (set.has("for") && set.has("inhalation")) {
    routeHint = "for inhalation";
  } else {
    routeHint = routeHints.find((h) => set.has(h));
  }

  const formHint = formHints.find((h) => set.has(h));

  return { routeHint, formHint };
}

/////////////////////// Candidate Store ///////////////////////

export function loadCatalog(concepts: Concept[]) {
  CATALOG.clear();
  POSTINGS.clear();
  NUM_INDEX.clear();
  TOKEN_IDF.clear();

  for (const c of concepts) {
    const toks = normalize(c.name);
    c.tokens = toks;

    // If brand not set but name has [Brand], parse it
    if (!c.brand) {
      const m = c.name.match(/\[([^\]]+)\]/);
      if (m) c.brand = m[1].trim();
    }

    CATALOG.set(c.rxcui, c);

    // postings
    for (const t of toks) {
      const arr = POSTINGS.get(t) ?? [];
      arr.push({ rxcui: c.rxcui, tf: 1 });
      POSTINGS.set(t, arr);
    }

    // numeric index
    const nf = parseNumeric(toks);
    for (const f of nf) {
      const key = `${f.value}|${f.unitKind}`;
      const set = NUM_INDEX.get(key) ?? new Set<string>();
      set.add(c.rxcui);
      NUM_INDEX.set(key, set);
    }
  }

  // IDF
  const N = CATALOG.size || 1;
  for (const [tok, arr] of POSTINGS.entries()) {
    const df = new Set(arr.map((x) => x.rxcui)).size || 1;
    const idf = Math.log((N + 1) / (df + 1)) + 1;
    TOKEN_IDF.set(tok, idf);
  }
}

/////////////////////// Candidate Recall ///////////////////////

function recallCandidates(qTokens: string[], qNums: NumFeat[]): Set<string> {
  const cset = new Set<string>();

  // lexical recall
  for (const t of qTokens) {
    const hits = POSTINGS.get(t);
    if (hits) for (const h of hits) cset.add(h.rxcui);
  }

  // numeric recall
  for (const f of qNums) {
    const key = `${f.value}|${f.unitKind}`;
    const s = NUM_INDEX.get(key);
    if (s) for (const r of s) cset.add(r);
  }

  return cset;
}

/////////////////////// TTY Weight ///////////////////////

function ttyWeight(tty: TTY): number {
  if (tty === "SCD" || tty === "SBD") return 1.0;
  if (tty === "SCDC" || tty === "SBDC") return 0.7;
  if (tty === "IN" || tty === "BN") return 0.5;
  if (tty === "DF") return 0.1;
  return 0.4;
}

function ttyWeightOrder(tty: TTY): number {
  if (tty === "SCD" || tty === "SBD") return 3;
  if (tty === "SCDC" || tty === "SBDC") return 2;
  if (tty === "IN" || tty === "BN") return 1;
  return 0;
}

/////////////////////// Scoring ///////////////////////

function numericAlignment(qNums: NumFeat[], cNums: NumFeat[]): number {
  if (qNums.length === 0) return 0;

  let total = 0;
  let matched = 0;

  for (const q of qNums) {
    let best = 0;
    for (const c of cNums) {
      if (q.unitKind === c.unitKind) {
        const sim = strengthSimilarity(q.value, c.value);
        if (sim > best) best = sim;
      }
    }
    if (best > 0) {
      total += best;
      matched++;
    }
  }

  if (matched === 0) return -0.3; // modest penalty if no strength family match
  const avg = total / qNums.length;
  return Math.min(0.6, avg * 0.6);
}

function routeCompatible(queryRoute: string | undefined, c: Concept): boolean {
  if (!queryRoute) return true;
  if (!c.route) return true; // RxNav can still show route-less strings

  const rh = queryRoute.toLowerCase();
  const cr = c.route.toLowerCase();

  if (rh === "for inhalation") {
    return cr.includes("inhalation");
  }
  return cr.includes(rh);
}

function scoreCandidate(
  qTokens: string[],
  qNums: NumFeat[],
  c: Concept,
  hints: { routeHint?: string; formHint?: string },
  qDrugWords: string[]
): number {
  const cToks = c.tokens ?? normalize(c.name);

  // Drug-word requirement (RxNav: at least one IN/BN-like word must appear)
  if (qDrugWords.length > 0) {
    const cDrugWords = extractDrugWords(cToks);
    const cSet = new Set(cDrugWords);
    const hasAny = qDrugWords.some((dw) => cSet.has(dw));
    if (!hasAny) return 0;
  }

  // Route compatibility: if query has "Injection", prefer injection-like candidates
  if (hints.routeHint && !routeCompatible(hints.routeHint, c)) {
    return 0;
  }

  const overlapW = weightedOverlap(qTokens, cToks);
  const jac = jaccard(qTokens, cToks);
  const ed = tokenEditSim(qTokens, cToks);
  const ord = orderBonus(qTokens, cToks);
  const cNums = parseNumeric(cToks);
  const numB = numericAlignment(qNums, cNums);
  const ttw = ttyWeight(c.tty);
  const brandB = c.tty === "SBD" ? 0.02 : 0;

  // Form bonus for injection-like queries
  let formB = 0;
  if (hints.routeHint && hints.routeHint.toLowerCase() === "injection") {
    const f = (c.form || "").toLowerCase();
    if (f.includes("injection")) formB += 0.25;
    else if (f.includes("injectable solution")) formB += 0.20;
    else if (
      f.includes("cartridge") ||
      f.includes("syringe") ||
      f.includes("vial") ||
      f.includes("auto-injector") ||
      f.includes("pen injector")
    ) {
      formB += 0.15;
    }
  }

  let s =
    CFG.wOverlap * overlapW +
    CFG.wJaccard * jac +
    CFG.wEditSim * ed +
    CFG.wOrder * ord +
    CFG.wNumeric * numB +
    CFG.wTTY * ttw +
    CFG.wBrand * brandB +
    formB;

  // modest penalties if numerics are way off
  if (numB < -0.1) s += numB * CFG.wPenalty;

  if (s < 0) s = 0;
  if (s > 1) s = 1;
  return s;
}

/////////////////////// Brand-Priority Post-Sort ///////////////////////

/**
 * Brand-aware post-sorting:
 * - Only applied if query contains [Brand]
 * - Does NOT change scores, only reorders final list logically:
 *   1. SBD with exact brand name match
 *   2. Any concept whose name contains the brand string
 *   3. Others (keep previous score order)
 */
function applyBrandPrioritySort(
  results: MatchResult[],
  brandToken: string
): MatchResult[] {
  const brandLC = brandToken.toLowerCase().trim();

  // Preserve original order for tie-breaking
  const indexMap = new Map<string, number>();
  results.forEach((r, i) => indexMap.set(r.rxcui, i));

  return results.slice().sort((a, b) => {
    const ca = CATALOG.get(a.rxcui);
    const cb = CATALOG.get(b.rxcui);

    const aBrandName = (ca?.brand ?? "").toLowerCase();
    const bBrandName = (cb?.brand ?? "").toLowerCase();

    const aNameLC = (ca?.name ?? "").toLowerCase();
    const bNameLC = (cb?.name ?? "").toLowerCase();

    const aExactBrand = aBrandName === brandLC;
    const bExactBrand = bBrandName === brandLC;

    if (aExactBrand && !bExactBrand) return -1;
    if (bExactBrand && !aExactBrand) return 1;

    const aContains = aNameLC.includes(brandLC);
    const bContains = bNameLC.includes(brandLC);

    if (aContains && !bContains) return -1;
    if (bContains && !aContains) return 1;

    // If both equal in brand relevance, keep original score-based order
    const idxA = indexMap.get(a.rxcui)!;
    const idxB = indexMap.get(b.rxcui)!;
    return idxA - idxB;
  });
}

/////////////////////// Public API ///////////////////////

export function approximateMatch(query: string, k = 10): MatchResult[] {
  const qTokens = normalize(query);
  const qNums = parseNumeric(qTokens);
  const qDrugWords = extractDrugWords(qTokens);
  const hints = detectHints(qTokens);

  // Extract brand token from query, if any
  const brandMatch = query.match(/\[([^\]]+)\]/);
  const brandToken = brandMatch ? brandMatch[1].trim() : undefined;

  // Exact normalized match override
  for (const [, c] of CATALOG) {
    const toks = c.tokens ?? normalize(c.name);
    if (toks.join(" ") === qTokens.join(" ")) {
      const single: MatchResult = {
        rxcui: c.rxcui,
        name: c.name,
        score: 1.0,
        tty: c.tty,
      };
      // If brandToken provided, no need to re-sort a single result
      return [single];
    }
  }

  const candSet = recallCandidates(qTokens, qNums);
  if (candSet.size === 0) return [];

  const scored: MatchResult[] = [];
  for (const rxcui of candSet) {
    const c = CATALOG.get(rxcui)!;
    const s = scoreCandidate(qTokens, qNums, c, hints, qDrugWords);
    if (s <= 0) continue;
    scored.push({
      rxcui: c.rxcui,
      name: c.name,
      score: parseFloat(s.toFixed(3)),
      tty: c.tty,
    });
  }

  // Base sort: score, then TTY, then name length, then rxcui
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const wa = ttyWeightOrder(a.tty);
    const wb = ttyWeightOrder(b.tty);
    if (wb !== wa) return wb - wa;
    if (a.name.length !== b.name.length) return a.name.length - b.name.length;
    return a.rxcui.localeCompare(b.rxcui);
  });

  // Brand-priority post-sort (if query contained brand in [Brand])
  const finalResults =
    brandToken && scored.length > 1
      ? applyBrandPrioritySort(scored, brandToken)
      : scored;

  return finalResults.slice(0, k);
}
