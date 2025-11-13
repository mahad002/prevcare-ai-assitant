import { NextRequest, NextResponse } from 'next/server';
import { join } from 'path';
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

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const search = searchParams.get('search')?.trim() ?? '';
    const limit = parseInt(searchParams.get('limit') ?? '20', 10);

    if (!search) {
      return NextResponse.json({ matches: [], error: 'Search term is required' }, { status: 400 });
    }

    await ensureCatalogLoaded();
    const matches = approximateMatch(search, limit);

    return NextResponse.json({
      input: search,
      matches,
      count: matches.length,
    });
  } catch (error) {
    console.error('Approximate search error', error);
    return NextResponse.json({ matches: [], error: 'Internal server error' }, { status: 500 });
  }
}
