import { NextRequest, NextResponse } from 'next/server';
import { join } from 'path';
import { readFile } from 'fs/promises';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const rxcui = searchParams.get('rxcui')?.trim();

    if (!rxcui) {
      return NextResponse.json({ exists: false, error: 'RxCUI is required' }, { status: 400 });
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
      if (lineRxcui === rxcui) {
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

    return NextResponse.json({
      exists: matches.length > 0,
      matches,
      count: matches.length,
      hasSU,
    });
  } catch (error) {
    console.error('RRF check error', error);
    return NextResponse.json({ exists: false, error: 'Internal server error' }, { status: 500 });
  }
}

