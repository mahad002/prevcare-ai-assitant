/**
 * Extract JSON from RTF file by parsing the text content
 */
export function extractJsonFromRtf(rtfText: string): { medications: Array<{ name: string }> } | null {
  try {
    // Method 1: Extract medications directly by pattern matching
    // RTF format: \{ "name": "..." \} - braces are escaped with backslash
    // Pattern: look for \{ "name": "..." followed by \}
    const medicationPattern = /\\\{\s*"name"\s*:\s*"([^"]+)"\s*\\\}/g;
    const medications: Array<{ name: string }> = [];
    let match;
    
    while ((match = medicationPattern.exec(rtfText)) !== null) {
      const name = match[1].trim();
      if (name) {
        medications.push({ name });
      }
    }
    
    if (medications.length > 0) {
      return { medications };
    }
    
    // Method 2: Try to clean RTF and parse as JSON
    // Remove RTF control codes
    let cleaned = rtfText
      .replace(/\\[a-z]+\d*\s?/gi, ' ') // Remove RTF control words
      .replace(/\\[{}]/g, (match) => match === '\\{' ? '{' : '}') // Unescape braces
      .replace(/\\'([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))) // Decode hex escapes
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
    
    // Find JSON structure
    const jsonStart = cleaned.indexOf('{"medications"');
    const jsonEnd = cleaned.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      let jsonStr = cleaned.substring(jsonStart, jsonEnd + 1);
      // Try to fix common RTF artifacts
      jsonStr = jsonStr.replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/\\t/g, ' ');
      
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed && Array.isArray(parsed.medications)) {
          return parsed;
        }
      } catch (parseError) {
        // If JSON parsing fails, extract manually
        const nameMatches = jsonStr.matchAll(/"name"\s*:\s*"([^"]+)"/g);
        const extracted: Array<{ name: string }> = [];
        for (const m of nameMatches) {
          if (m[1]) extracted.push({ name: m[1] });
        }
        if (extracted.length > 0) {
          return { medications: extracted };
        }
      }
    }
  } catch (e) {
    console.error('Error extracting JSON from RTF:', e);
  }
  return null;
}

/**
 * Load medications from RTF file
 */
export async function loadMedicationsList(): Promise<Array<{ name: string }>> {
  try {
    const response = await fetch('/medications list.rtf');
    if (!response.ok) {
      throw new Error(`Failed to fetch medications list: ${response.status}`);
    }
    const rtfText = await response.text();
    const result = extractJsonFromRtf(rtfText);
    return result?.medications || [];
  } catch (error) {
    console.error('Error loading medications list:', error);
    return [];
  }
}

