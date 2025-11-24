import { NextResponse } from 'next/server';
import { readdir } from 'fs/promises';
import { join } from 'path';

export async function GET() {
  try {
    const rrfDir = join(process.cwd(), 'public', 'rrf');
    const files = await readdir(rrfDir);
    
    // Filter for .RRF files
    const rrfFiles = files
      .filter(file => file.toUpperCase().endsWith('.RRF'))
      .sort();
    
    return NextResponse.json({
      files: rrfFiles,
      count: rrfFiles.length
    });
  } catch (error) {
    console.error('Error listing RRF files:', error);
    return NextResponse.json({
      files: [],
      count: 0,
      error: error instanceof Error ? error.message : 'Failed to list RRF files'
    }, { status: 500 });
  }
}

