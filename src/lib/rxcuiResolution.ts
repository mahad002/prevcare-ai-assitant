/**
 * Production-ready RxCUI resolution flow
 * Implements: parse → multi-pass search → hydrate → filter → score → verify → return
 */

export type ParsedMedication = {
  ingredient: string;
  strength?: string; // e.g., "250 MG"
  concentration?: string; // e.g., "125 MG/5 ML"
  isConcentration: boolean;
  doseForm?: string; // tablet, capsule, suspension, etc.
  route?: string; // oral, topical, etc.
  brand?: string;
  original: string;
};

export type Candidate = {
  rxcui: string;
  rxaui?: string;
  name: string;
  source?: string;
  tty?: "SCD" | "SBD" | "GPCK" | "BPCK" | "IN" | "MIN" | "PIN" | string;
  approxScore?: number;
  ndcCount?: number;
  status?: "Active" | "Remapped" | "NotFound";
  compositeScore?: number;
  synonyms?: string[];
};

export type Resolution = {
  input: string;
  normalized: string;
  final: {
    rxcui: string;
    tty: string;
    name: string;
    status: string;
    verification: {
      statusChecked: boolean;
      propertiesChecked: boolean;
      ndcFound: boolean;
    };
  } | null;
  groupRxCui: {
    ingredientRxcui?: string;
    ingredientName?: string;
  };
  differences: string[];
  candidates: Candidate[];
  attemptsLog: string[];
};

/**
 * Parse medication input into structured components
 */
function parseInput(input: string): ParsedMedication {
  const original = input.trim();
  let normalized = original;
  
  // Extract brand from brackets
  const brandMatch = normalized.match(/\[([^\]]+)\]/);
  const brand = brandMatch ? brandMatch[1] : undefined;
  normalized = normalized.replace(/\s*\[[^\]]+\]\s*$/, '').trim();
  
  // Normalize units and separators
  normalized = normalized
    .replace(/\b(mg|MG)\s*\/\s*(ml|ML)\b/gi, 'MG/ML')
    .replace(/\s+per\s+/gi, '/')
    .replace(/\s+in\s+/gi, '/')
    .replace(/\b(mL|ml)\b/g, 'ML')
    .replace(/\b(mg|MG)\b/g, 'MG')
    .replace(/\s+/g, ' ')
    .trim();
  
  // Extract strength or concentration
  const concentrationMatch = normalized.match(/(\d+(?:\.\d+)?)\s*MG\s*\/\s*(\d+(?:\.\d+)?)\s*ML/i);
  const strengthMatch = normalized.match(/(\d+(?:\.\d+)?)\s*MG\b/i);
  
  let strength: string | undefined;
  let concentration: string | undefined;
  let isConcentration = false;
  
  if (concentrationMatch) {
    concentration = `${concentrationMatch[1]} MG/${concentrationMatch[2]} ML`;
    isConcentration = true;
  } else if (strengthMatch) {
    strength = `${strengthMatch[1]} MG`;
  }
  
  // Extract dose form
  const formPatterns = [
    { pattern: /\b(tablet|tab)\b/i, canonical: 'tablet' },
    { pattern: /\b(capsule|cap)\b/i, canonical: 'capsule' },
    { pattern: /\b(suspension|susp|oral\s+suspension)\b/i, canonical: 'suspension' },
    { pattern: /\b(solution|oral\s+solution)\b/i, canonical: 'solution' },
    { pattern: /\b(injection|inject)\b/i, canonical: 'injection' },
    { pattern: /\b(patch)\b/i, canonical: 'patch' },
    { pattern: /\b(inhalation|inhaler)\b/i, canonical: 'inhalation' },
  ];
  
  let doseForm: string | undefined;
  for (const { pattern, canonical } of formPatterns) {
    if (pattern.test(normalized)) {
      doseForm = canonical;
      break;
    }
  }
  
  // If concentration exists but no form specified, infer suspension
  if (isConcentration && !doseForm) {
    doseForm = 'suspension';
  }
  
  // Extract route
  const routePatterns = [
    { pattern: /\boral\b/i, canonical: 'oral' },
    { pattern: /\btopical\b/i, canonical: 'topical' },
    { pattern: /\binjection\b/i, canonical: 'injection' },
  ];
  
  let route: string | undefined;
  for (const { pattern, canonical } of routePatterns) {
    if (pattern.test(normalized)) {
      route = canonical;
      break;
    }
  }
  
  // Default route to oral if form suggests it
  if (!route && (doseForm === 'tablet' || doseForm === 'capsule' || doseForm === 'suspension' || doseForm === 'solution')) {
    route = 'oral';
  }
  
  // Extract ingredient (everything before first number, excluding brand)
  const beforeNumber = normalized.split(/\d/)[0].trim();
  const ingredient = beforeNumber
    .replace(/\b(MG|ML|MG\/ML)\b/gi, '')
    .replace(/\b(tablet|tab|capsule|cap|suspension|susp|solution|injection|oral|topical)\b/gi, '')
    .trim()
    .split(/\s+/)[0] || beforeNumber.split(/\s+/)[0] || '';
  
  return {
    ingredient: ingredient || normalized.split(/\d/)[0].trim(),
    strength,
    concentration,
    isConcentration,
    doseForm,
    route,
    brand,
    original,
  };
}

/**
 * Build ordered search terms from parsed medication
 */
function buildSearchTerms(parsed: ParsedMedication): string[] {
  const terms: string[] = [];
  const { ingredient, strength, concentration, doseForm, route, brand } = parsed;
  
  const strengthOrConc = concentration || strength || '';
  const form = doseForm ? (doseForm === 'tablet' ? 'Oral Tablet' : 
                           doseForm === 'capsule' ? 'Oral Capsule' :
                           doseForm === 'suspension' ? 'Oral Suspension' :
                           doseForm === 'solution' ? 'Oral Solution' :
                           doseForm) : '';
  
  // 1. Exact reconstructed with brand
  if (brand && strengthOrConc && form) {
    terms.push(`${ingredient} ${strengthOrConc} ${form} [${brand}]`);
  }
  
  // 2. Exact without brand
  if (strengthOrConc && form) {
    terms.push(`${ingredient} ${strengthOrConc} ${form}`);
  }
  
  // 3. Concentration canonical variants
  if (parsed.isConcentration && concentration) {
    const [mg, ml] = concentration.split('/');
    terms.push(`${ingredient} ${mg}/${ml}`);
    terms.push(`${ingredient} ${mg} per ${ml}`);
  }
  
  // 4. Route variants
  if (strengthOrConc && form) {
    if (route === 'oral') {
      terms.push(`${ingredient} ${strengthOrConc} ${form.replace('Oral ', '')}`);
    } else {
      terms.push(`${ingredient} ${strengthOrConc} ${route} ${form}`);
    }
  }
  
  // 5. Form synonyms
  if (strengthOrConc) {
    if (doseForm === 'tablet') {
      terms.push(`${ingredient} ${strengthOrConc} Tab`);
    } else if (doseForm === 'capsule') {
      terms.push(`${ingredient} ${strengthOrConc} Cap`);
    } else if (doseForm === 'suspension') {
      terms.push(`${ingredient} ${strengthOrConc} Susp`);
    }
  }
  
  // 6. Clinical only (no form)
  if (strengthOrConc) {
    terms.push(`${ingredient} ${strengthOrConc}`);
  }
  
  // 7. Brand first (if brand)
  if (brand && strengthOrConc && form) {
    terms.push(`${brand} ${ingredient} ${strengthOrConc} ${form}`);
  }
  
  // 8. Ingredient only
  terms.push(ingredient);
  
  // Remove duplicates and empty
  return [...new Set(terms.filter(t => t.trim()))];
}

/**
 * Resolve remapped RxCUI via status.json
 */
async function resolveRemap(rxcui: string): Promise<string> {
  try {
    const res = await fetch(`https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/status.json`);
    if (res.ok) {
      const json = await res.json();
      if (json?.rxcuiStatus?.status === 'Remapped' && json?.rxcuiStatus?.minConcept?.rxcui) {
        return String(json.rxcuiStatus.minConcept.rxcui);
      }
      if (json?.rxcuiStatus?.status === 'Active') {
        return rxcui;
      }
    }
  } catch (e) {
    // Ignore errors
  }
  return rxcui;
}

/**
 * Hydrate candidate with full properties
 */
async function hydrateCandidate(
  rxcui: string,
  approxData?: any,
  attemptsLog?: string[]
): Promise<Candidate | null> {
  const log = (msg: string) => {
    if (attemptsLog) attemptsLog.push(`[${rxcui}] ${msg}`);
  };
  
  // Resolve remapping
  const activeRxcui = await resolveRemap(rxcui);
  if (activeRxcui !== rxcui) {
    log(`Remapped: ${rxcui} → ${activeRxcui}`);
    rxcui = activeRxcui;
  }
  
  // Get properties
  let name = '';
  let tty: string | undefined;
  let status = 'Unknown';
  let synonyms: string[] = [];
  
  try {
    const propsRes = await fetch(`https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/properties.json`);
    if (propsRes.ok) {
      const props = await propsRes.json();
      name = props?.properties?.name || '';
      tty = props?.properties?.tty;
      status = props?.properties?.status || 'Unknown';
      
      const synonymStr = props?.properties?.synonym || '';
      if (synonymStr) {
        synonyms = String(synonymStr).split('|').map(s => s.trim()).filter(Boolean);
      }
      log(`Properties: name="${name}", tty=${tty}, status=${status}`);
    } else {
      log(`Properties fetch failed: ${propsRes.status}`);
      return null;
    }
  } catch (e) {
    log(`Properties error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  
  // Check status - must be Active
  if (status !== 'Active') {
    log(`Status not Active: ${status}`);
    return null;
  }
  
  // Get NDC count (optional but useful)
  let ndcCount = 0;
  try {
    const ndcRes = await fetch(`https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/ndcs.json`);
    if (ndcRes.ok) {
      const ndcJson = await ndcRes.json();
      ndcCount = Array.isArray(ndcJson?.ndcGroup?.ndc) ? ndcJson.ndcGroup.ndc.length : 0;
      if (ndcCount > 0) log(`NDCs found: ${ndcCount}`);
    }
  } catch (e) {
    // Ignore NDC errors
  }
  
  const candidate: Candidate = {
    rxcui,
    rxaui: approxData?.rxaui ? String(approxData.rxaui) : undefined,
    name: name || approxData?.name || '',
    source: approxData?.source,
    tty,
    approxScore: approxData?.score ? parseFloat(String(approxData.score)) : undefined,
    ndcCount,
    status: status === 'Active' ? 'Active' : undefined,
    synonyms,
  };
  
  return candidate;
}

/**
 * Normalize strength for comparison
 */
function normalizeStrength(str: string): string {
  return str.toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+PER\s+/gi, '/')
    .replace(/\s+IN\s+/gi, '/')
    .trim();
}

/**
 * Check if name contains strength
 */
function nameHasStrength(name: string, requiredStrength: string): boolean {
  const normalized = normalizeStrength(name);
  const required = normalizeStrength(requiredStrength);
  
  // Exact match
  if (normalized.includes(required)) return true;
  
  // For concentrations, check if ratio matches
  const reqMatch = required.match(/(\d+(?:\.\d+)?)\s*MG\s*\/\s*(\d+(?:\.\d+)?)\s*ML/i);
  if (reqMatch) {
    const reqRatio = parseFloat(reqMatch[1]) / parseFloat(reqMatch[2]);
    const nameMatch = normalized.match(/(\d+(?:\.\d+)?)\s*MG\s*\/\s*(\d+(?:\.\d+)?)\s*ML/i);
    if (nameMatch) {
      const nameRatio = parseFloat(nameMatch[1]) / parseFloat(nameMatch[2]);
      // Allow small tolerance for rounding
      return Math.abs(reqRatio - nameRatio) < 0.01;
    }
  }
  
  return false;
}

/**
 * Canonical form mapping
 */
function canonicalForm(form: string): string {
  const map: Record<string, string> = {
    'tablet': 'tablet',
    'tab': 'tablet',
    'capsule': 'capsule',
    'cap': 'capsule',
    'suspension': 'suspension',
    'susp': 'suspension',
    'solution': 'solution',
    'injection': 'injection',
  };
  return map[form.toLowerCase()] || form.toLowerCase();
}

/**
 * Check if name contains form
 */
function nameHasForm(name: string, requiredForm: string): boolean {
  const normalized = name.toLowerCase();
  const canonical = canonicalForm(requiredForm);
  
  const formVariants: Record<string, string[]> = {
    'tablet': ['tablet', 'tab'],
    'capsule': ['capsule', 'cap'],
    'suspension': ['suspension', 'susp', 'oral suspension'],
    'solution': ['solution', 'oral solution'],
    'injection': ['injection', 'inject'],
  };
  
  const variants = formVariants[canonical] || [canonical];
  return variants.some(v => normalized.includes(v));
}

/**
 * Score candidate based on preferences
 */
function scoreCandidate(candidate: Candidate, parsed: ParsedMedication): number {
  let score = candidate.approxScore || 0;
  
  // Source preference
  if (candidate.source === 'RXNORM') {
    score += 10;
  } else if (['MTHSPL', 'NDDF', 'MMSL', 'VANDF'].includes(candidate.source || '')) {
    score -= 10;
  }
  
  // TTY priority
  const ttyScores: Record<string, number> = {
    'SBD': 8,
    'SCD': 7,
    'GPCK': 5,
    'BPCK': 4,
  };
  if (candidate.tty) {
    score += ttyScores[candidate.tty] || 0;
  }
  
  // Brand match
  if (parsed.brand && candidate.name.toLowerCase().includes(parsed.brand.toLowerCase())) {
    score += 8;
  }
  
  // Route match
  if (parsed.route && candidate.name.toLowerCase().includes(parsed.route.toLowerCase())) {
    score += 6;
  }
  
  // NDC presence (market evidence)
  if (candidate.ndcCount && candidate.ndcCount > 0) {
    score += 6;
  }
  
  return score;
}

/**
 * Verify final candidate
 */
async function verifyActiveAndTTY(candidate: Candidate): Promise<boolean> {
  // Re-check status
  try {
    const statusRes = await fetch(`https://rxnav.nlm.nih.gov/REST/rxcui/${candidate.rxcui}/status.json`);
    if (statusRes.ok) {
      const statusJson = await statusRes.json();
      if (statusJson?.rxcuiStatus?.status !== 'Active') {
        return false;
      }
    }
  } catch (e) {
    return false;
  }
  
  // Verify TTY
  const validTTYs = ['SCD', 'SBD', 'GPCK', 'BPCK'];
  return candidate.tty ? validTTYs.includes(candidate.tty) : false;
}

/**
 * Generate differences report
 */
function generateDifferences(parsed: ParsedMedication, winner: Candidate): string[] {
  const diffs: string[] = [];
  const winnerName = winner.name.toLowerCase();
  
  // Check ingredient
  if (!winnerName.includes(parsed.ingredient.toLowerCase())) {
    diffs.push(`Ingredient differs: input "${parsed.ingredient}" vs resolved "${winner.name}"`);
  }
  
  // Check strength/concentration
  const strengthOrConc = parsed.concentration || parsed.strength;
  if (strengthOrConc && !nameHasStrength(winner.name, strengthOrConc)) {
    diffs.push(`Strength/concentration differs: input "${strengthOrConc}" not found in resolved name`);
  }
  
  // Check form
  if (parsed.doseForm && !nameHasForm(winner.name, parsed.doseForm)) {
    diffs.push(`Form differs: input "${parsed.doseForm}" vs resolved form in "${winner.name}"`);
  }
  
  // Check brand
  if (parsed.brand) {
    if (!winnerName.includes(parsed.brand.toLowerCase())) {
      diffs.push(`Brand not found: input brand "${parsed.brand}" not in resolved name; returning generic ${winner.tty}`);
    }
  }
  
  // Check for chewable when not specified
  if (parsed.doseForm === 'tablet' && winnerName.includes('chewable') && !parsed.original.toLowerCase().includes('chewable')) {
    diffs.push(`Form differs: input "tablet" vs resolved "tablet, chewable"`);
  }
  
  if (diffs.length === 0) {
    diffs.push('—');
  }
  
  return diffs;
}

/**
 * Main resolution function
 */
export async function resolveMedication(input: string): Promise<Resolution> {
  const attemptsLog: string[] = [];
  const log = (msg: string) => {
    attemptsLog.push(msg);
    console.log(`[RxCUI Resolution] ${msg}`);
  };
  
  log(`Starting resolution for: "${input}"`);
  
  // A) Parse input
  const parsed = parseInput(input);
  log(`Parsed: ingredient="${parsed.ingredient}", strength="${parsed.strength}", concentration="${parsed.concentration}", form="${parsed.doseForm}", route="${parsed.route}", brand="${parsed.brand}"`);
  
  // B) Build search terms
  const terms = buildSearchTerms(parsed);
  log(`Generated ${terms.length} search terms`);
  
  // C) Collect candidates
  const seen = new Map<string, Candidate>();
  let groupRxCui: { ingredientRxcui?: string; ingredientName?: string } = {};
  
  for (const term of terms) {
    log(`Searching term: "${term}"`);
    
    // Exact search
    try {
      const exactRes = await fetch(`https://rxnav.nlm.nih.gov/REST/rxcui.json?name=${encodeURIComponent(term)}&search=1`);
      if (exactRes.ok) {
        const exactJson = await exactRes.json();
        const rxcuis = exactJson?.idGroup?.rxnormId || [];
        for (const rxcui of rxcuis) {
          const candidate = await hydrateCandidate(String(rxcui), undefined, attemptsLog);
          if (candidate) {
            if (candidate.tty === 'IN' || candidate.tty === 'MIN') {
              if (!groupRxCui.ingredientRxcui) {
                groupRxCui = { ingredientRxcui: candidate.rxcui, ingredientName: candidate.name };
              }
            }
            if (!seen.has(candidate.rxcui)) {
              seen.set(candidate.rxcui, candidate);
            }
          }
        }
      }
    } catch (e) {
      log(`Exact search error: ${e instanceof Error ? e.message : String(e)}`);
    }
    
    // Approximate search
    try {
      const approxRes = await fetch(`https://rxnav.nlm.nih.gov/REST/approximateTerm.json?term=${encodeURIComponent(term)}&maxEntries=20`);
      if (approxRes.ok) {
        const approxJson = await approxRes.json();
        const candidates = approxJson?.approximateGroup?.candidate || [];
        for (const cand of candidates) {
          const rxcui = String(cand.rxcui || '');
          if (!rxcui) continue;
          
          const activeRxcui = await resolveRemap(rxcui);
          const candidate = await hydrateCandidate(activeRxcui, cand, attemptsLog);
          if (candidate) {
            if (candidate.tty === 'IN' || candidate.tty === 'MIN') {
              if (!groupRxCui.ingredientRxcui) {
                groupRxCui = { ingredientRxcui: candidate.rxcui, ingredientName: candidate.name };
              }
            }
            if (!seen.has(candidate.rxcui)) {
              seen.set(candidate.rxcui, candidate);
            }
          }
        }
      }
    } catch (e) {
      log(`Approximate search error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  
  log(`Collected ${seen.size} unique candidates`);
  
  // D) Filter candidates
  const validTTYs = ['SCD', 'SBD', 'GPCK', 'BPCK'];
  const filtered = Array.from(seen.values()).filter(c => 
    c.tty && validTTYs.includes(c.tty) && c.status === 'Active'
  );
  
  log(`Filtered to ${filtered.length} valid candidates (excluded IN/MIN/PIN)`);
  
  // Strength/form filters
  const strengthOrConc = parsed.concentration || parsed.strength;
  const mustContain = strengthOrConc ? normalizeStrength(strengthOrConc) : undefined;
  const mustForm = parsed.doseForm ? canonicalForm(parsed.doseForm) : undefined;
  
  const strict = filtered.filter(c => {
    if (mustContain && !nameHasStrength(c.name, mustContain)) {
      return false;
    }
    if (mustForm && !nameHasForm(c.name, mustForm)) {
      // Special case: reject chewable if not in input
      if (mustForm === 'tablet' && c.name.toLowerCase().includes('chewable') && 
          !parsed.original.toLowerCase().includes('chewable')) {
        return false;
      }
      return true; // Allow if form matches
    }
    return true;
  });
  
  log(`After strength/form filtering: ${strict.length} candidates`);
  
  // Score candidates
  for (const c of strict) {
    c.compositeScore = scoreCandidate(c, parsed);
  }
  
  // Sort by composite score
  strict.sort((a, b) => (b.compositeScore || 0) - (a.compositeScore || 0));
  
  // E) Verify and select winner
  let winner: Candidate | null = null;
  for (const candidate of strict) {
    const isValid = await verifyActiveAndTTY(candidate);
    if (isValid) {
      winner = candidate;
      log(`Selected winner: ${candidate.rxcui} (${candidate.tty}) - ${candidate.name}`);
      break;
    } else {
      log(`Candidate ${candidate.rxcui} failed verification`);
    }
  }
  
  // F) Generate differences
  const differences = winner ? generateDifferences(parsed, winner) : ['No match found'];
  
  // G) Build result
  const normalized = parsed.original; // Could enhance this with better normalization
  
  if (!winner) {
    return {
      input: parsed.original,
      normalized,
      final: null,
      groupRxCui,
      differences,
      candidates: Array.from(seen.values()),
      attemptsLog,
    };
  }
  
  return {
    input: parsed.original,
    normalized,
    final: {
      rxcui: winner.rxcui,
      tty: winner.tty || '',
      name: winner.name,
      status: winner.status || 'Active',
      verification: {
        statusChecked: true,
        propertiesChecked: true,
        ndcFound: (winner.ndcCount || 0) > 0,
      },
    },
    groupRxCui,
    differences,
    candidates: Array.from(seen.values()),
    attemptsLog,
  };
}

