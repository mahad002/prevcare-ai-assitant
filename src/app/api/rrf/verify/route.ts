import { NextRequest, NextResponse } from 'next/server';
import { join } from 'path';
import { readFile } from 'fs/promises';
import { loadCatalog, approximateMatch } from '@/lib/approxMatch';
import { loadRrfFileToConcepts } from '@/lib/rrfLoader';

let conceptsCache: Awaited<ReturnType<typeof loadRrfFileToConcepts>> | null = null;
let conceptsCacheTimestamp = 0;
const CACHE_DURATION_MS = 5 * 60 * 1000;

async function ensureCatalogLoaded() {
  const now = Date.now();
  if (conceptsCache && now - conceptsCacheTimestamp < CACHE_DURATION_MS) {
    return;
  }

  const rrfPath = join(process.cwd(), 'public', 'rrf', 'RXNCONSO.RRF');
  const concepts = await loadRrfFileToConcepts(rrfPath);
  loadCatalog(concepts);
  conceptsCache = concepts;
  conceptsCacheTimestamp = now;
}

/**
 * Search RRF file for medications by name
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, searchTerm, rxcui } = body;

    if (action === 'search') {
      // Search for medications by name in RRF
      if (!searchTerm || typeof searchTerm !== 'string') {
        return NextResponse.json({ 
          success: false, 
          error: 'searchTerm is required for search action',
          matches: []
        }, { status: 400 });
      }

      await ensureCatalogLoaded();
      const matches = approximateMatch(searchTerm.trim(), 20);

      const enrichedMatches = matches
        .map((m) => {
          const concept = conceptsCache?.find((c) => c.rxcui === m.rxcui);
          return {
            rxcui: m.rxcui,
            name: m.name,
            tty: m.tty,
            route: concept?.route,
            form: concept?.form,
            ingredients: concept?.ingredients,
            brand: concept?.brand,
            score: m.score,
          };
        });

      return NextResponse.json({
        success: true,
        action: 'search',
        searchTerm,
        matches: enrichedMatches,
        count: enrichedMatches.length
      });
    } else if (action === 'verify_rxcui') {
      // Verify if RxCUI exists in RRF file
      if (!rxcui || typeof rxcui !== 'string') {
        return NextResponse.json({ 
          success: false, 
          error: 'rxcui is required for verify_rxcui action',
          exists: false
        }, { status: 400 });
      }

      const rrfPath = join(process.cwd(), 'public', 'rrf', 'RXNCONSO.RRF');
      const content = await readFile(rrfPath, 'utf-8');
      const lines = content.split(/\r?\n/);

      const matches: Array<{
        rxcui: string;
        tty: string;
        str: string;
        sab: string;
      }> = [];

      for (const line of lines) {
        if (!line.trim()) continue;
        const parts = line.trim().split('|');
        if (parts.length < 15) continue;

        const lineRxcui = parts[0]?.trim();
        if (lineRxcui === rxcui.trim()) {
          const tty = parts[12]?.trim() || '';
          const str = parts[14]?.trim() || '';
          const sab = parts[11]?.trim() || '';

          if (sab === 'RXNORM') {
            matches.push({
              rxcui: lineRxcui,
              tty,
              str,
              sab,
            });
          }
        }
      }

      // Check if any match has TTY="SU" (Semantic Unit)
      const hasSU = matches.some(m => m.tty === 'SU');
      
      // Prefer SCD/SBD entries
      const preferredMatches = matches.filter(m => 
        m.tty === 'SCD' || m.tty === 'SBD' || m.tty === 'SCDC' || m.tty === 'SBDC'
      );

      return NextResponse.json({
        success: true,
        action: 'verify_rxcui',
        rxcui: rxcui.trim(),
        exists: matches.length > 0,
        hasSU,
        matches: preferredMatches.length > 0 ? preferredMatches : matches,
        count: matches.length,
        preferredName: preferredMatches.length > 0 ? preferredMatches[0].str : (matches.length > 0 ? matches[0].str : null)
      });
    } else {
      return NextResponse.json({ 
        success: false, 
        error: 'Invalid action. Use "search" or "verify_rxcui"'
      }, { status: 400 });
    }
  } catch (error) {
    console.error('RRF verify error', error);
    return NextResponse.json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Internal server error'
    }, { status: 500 });
  }
}

