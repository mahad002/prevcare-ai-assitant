const OPENAI_KEY = process.env.NEXT_PUBLIC_OPENAI_API_KEY ?? "";

const EMBEDDING_MODEL = "text-embedding-3-large";
const DEFAULT_EMBEDDING_WEIGHT = 0.85;
const DEFAULT_LEXICAL_WEIGHT = 0.15;

type EmbeddingCache = Map<string, number[]>;

const embeddingCache: EmbeddingCache = new Map();

export type BestMatchOptions = {
  embeddingWeight?: number;
  lexicalWeight?: number;
};

export type LlmRankedCandidate = {
  name: string;
  similarity: number;
};

export type LlmMatchResult = {
  bestMatch: string | null;
  reason: string | null;
  ranked: LlmRankedCandidate[];
  raw: unknown;
};

export type BestMatchResult = {
  candidate: string | null;
  semanticScore: number;
  lexicalScore: number;
  similarityScore: number;
  reason: string;
  evaluated: Array<{
    candidate: string;
    semanticScore: number;
    lexicalScore: number;
    similarityScore: number;
    adjustedScore: number;
  }>;
};

async function fetchEmbedding(text: string): Promise<number[]> {
  const normalized = preprocessText(text);
  if (!normalized) {
    throw new Error("Cannot create embedding for empty text.");
  }
  if (embeddingCache.has(normalized)) {
    return embeddingCache.get(normalized)!;
  }
  if (!OPENAI_KEY) {
    throw new Error("OpenAI API key is not configured (NEXT_PUBLIC_OPENAI_API_KEY).");
  }

  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: normalized,
    }),
  });

  if (!res.ok) {
    const textResponse = await res.text();
    throw new Error(`Embedding request failed (${res.status}): ${textResponse}`);
  }

  const json = await res.json();
  const embedding = json?.data?.[0]?.embedding;
  if (!embedding || !Array.isArray(embedding)) {
    throw new Error("Embedding response missing data.");
  }

  embeddingCache.set(normalized, embedding as number[]);
  return embedding as number[];
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Embedding vectors must be the same length.");
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const ai = a[i];
    const bi = b[i];
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const REPLACEMENTS: Array<[RegExp, string]> = [
  [/actuat(e|ion|ions)?/gi, "inhal"],
  [/aerosol/gi, "inhaler"],
  [/mcg\/?\s*actuat/gi, "mcg"],
];

function preprocessText(text: string): string {
  let processed = text.toLowerCase().trim();
  for (const [pattern, replacement] of REPLACEMENTS) {
    processed = processed.replace(pattern, replacement);
  }
  return processed.replace(/\s+/g, " ");
}

function tokenSet(text: string): Set<string> {
  return new Set(
    preprocessText(text)
      .replace(/[,[\]()]/g, " ")
      .replace(/[\/]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
  );
}

function tokenOverlapScore(input: string, candidate: string): number {
  const a = tokenSet(input);
  const b = tokenSet(candidate);
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) overlap += 1;
  }
  return overlap / Math.max(a.size, b.size);
}

function buildReason(input: string, bestCandidate: string, lexicalScore: number, semanticScore: number): string {
  const inputTokens = tokenSet(input);
  const candidateTokens = tokenSet(bestCandidate);
  const sharedTokens = Array.from(inputTokens.values()).filter((token) => candidateTokens.has(token));

  const highlighted = sharedTokens
    .filter((token) => /\d/.test(token) || token.length > 3)
    .slice(0, 5);

  const pieces: string[] = [];
  if (highlighted.length) {
    pieces.push(`Shares key tokens: ${highlighted.join(", ")}`);
  } else if (sharedTokens.length) {
    pieces.push(`Shares ${sharedTokens.length} tokens with the input`);
  }
  pieces.push(`semantic score ${semanticScore.toFixed(2)}`);
  pieces.push(`lexical score ${lexicalScore.toFixed(2)}`);

  return pieces.join("; ");
}

export async function findBestStringMatch(
  input: string,
  candidates: string[],
  options: BestMatchOptions = {}
): Promise<BestMatchResult> {
  const originalMap = new Map<string, string>();
  candidates.forEach((candidate) => {
    const processed = preprocessText(candidate);
    if (processed) {
      originalMap.set(processed, candidate);
    }
  });

  const uniqueCandidates = Array.from(originalMap.keys());

  const processedInput = preprocessText(input);

  if (!processedInput || uniqueCandidates.length === 0) {
    return {
      candidate: null,
      semanticScore: 0,
      lexicalScore: 0,
      similarityScore: 0,
      reason: "No candidates available for comparison.",
      evaluated: [],
    };
  }

  const embeddingWeight = options.embeddingWeight ?? DEFAULT_EMBEDDING_WEIGHT;
  const lexicalWeight = options.lexicalWeight ?? DEFAULT_LEXICAL_WEIGHT;
  const weightSum = embeddingWeight + lexicalWeight;
  const normalizedEmbeddingWeight = weightSum === 0 ? 0 : embeddingWeight / weightSum;
  const normalizedLexicalWeight = weightSum === 0 ? 0 : lexicalWeight / weightSum;

  const inputEmbedding = await fetchEmbedding(processedInput);

  let bestCandidate: string | null = null;
  let bestSemantic = 0;
  let bestLexical = 0;
  let bestScore = 0;
  const evaluated: BestMatchResult["evaluated"] = [];

  for (const processedCandidate of uniqueCandidates) {
    const originalCandidate = originalMap.get(processedCandidate) ?? processedCandidate;
    const candidateEmbedding = await fetchEmbedding(processedCandidate);
    const semanticScore = cosineSimilarity(inputEmbedding, candidateEmbedding);
    const lexicalScore = tokenOverlapScore(processedInput, processedCandidate);
    const similarityScore =
      normalizedEmbeddingWeight * semanticScore + normalizedLexicalWeight * lexicalScore;

    let adjustedScore = similarityScore;
    const inputLower = processedInput;
    const candidateLower = processedCandidate;

    if (candidateLower.includes("ventolin") && inputLower.includes("ventolin")) {
      adjustedScore += 0.05;
    }

    const tokens = ["ventolin", "albuterol", "hfa", "inhal", "inhaler"];
    const hasSharedTokens = tokens.some(
      (token) => candidateLower.includes(token) && inputLower.includes(token)
    );
    if (hasSharedTokens) {
      adjustedScore += 0.02;
    }

    const strengthRegex = /\b\d+(\.\d+)?\b/g;
    const inputStrengths = new Set<string>();
    const candidateStrengths = new Set<string>();

    let match;
    while ((match = strengthRegex.exec(inputLower)) !== null) {
      inputStrengths.add(match[0]);
    }
    while ((match = strengthRegex.exec(candidateLower)) !== null) {
      candidateStrengths.add(match[0]);
    }

    const strengthMatch =
      inputStrengths.size > 0 &&
      Array.from(candidateStrengths).some((value) => inputStrengths.has(value));
    if (strengthMatch) {
      adjustedScore += 0.03;
    }

    evaluated.push({
      candidate: originalCandidate,
      semanticScore,
      lexicalScore,
      similarityScore,
      adjustedScore,
    });

    if (adjustedScore > bestScore) {
      bestScore = adjustedScore;
      bestCandidate = originalCandidate;
      bestSemantic = semanticScore;
      bestLexical = lexicalScore;
    }
  }

  if (!bestCandidate) {
    return {
      candidate: null,
      semanticScore: 0,
      lexicalScore: 0,
      similarityScore: 0,
      reason: "No candidate produced a similarity score above zero.",
      evaluated,
    };
  }

  const reason = buildReason(input, bestCandidate, bestLexical, bestSemantic);

  return {
    candidate: bestCandidate,
    semanticScore: bestSemantic,
    lexicalScore: bestLexical,
    similarityScore: bestScore,
    reason,
    evaluated,
  };
}

export async function findBestStringMatchWithLLM(
  input: string,
  candidates: Array<Record<string, unknown>>,
  model = "gpt-4o-mini"
): Promise<LlmMatchResult | null> {
  if (!candidates.length) {
    return null;
  }
  if (!OPENAI_KEY) {
    throw new Error("OpenAI API key is not configured (NEXT_PUBLIC_OPENAI_API_KEY).");
  }

  const listLines = candidates
    .map((candidate, index) => {
      const name =
        (typeof candidate.name === "string" && candidate.name) ||
        (typeof candidate.term === "string" && candidate.term) ||
        (typeof candidate.rxcui === "string" && candidate.rxcui) ||
        JSON.stringify(candidate);
      const scoreParts: string[] = [];
      const numericFields: Array<[string, unknown]> = [
        ["similarity", candidate.similarity],
        ["adjustedScore", candidate.adjustedScore],
        ["score", candidate.score],
        ["semanticScore", candidate.semanticScore],
        ["lexicalScore", candidate.lexicalScore],
      ];
      for (const [label, value] of numericFields) {
        if (typeof value === "number") {
          scoreParts.push(`${label}=${value.toFixed(3)}`);
        }
      }
      const suffix = scoreParts.length ? ` (${scoreParts.join(", ")})` : "";
      return `${index + 1}. ${name}${suffix}`;
    })
    .join("\n");

  const candidateJson = JSON.stringify(candidates, null, 2);

  const prompt = `
You are a U.S. clinical terminology reasoning model that aligns drug names to RxNorm-style products.

Input medication:
"${input}"

Candidates (from database search):
${listLines}

Candidates JSON:
${candidateJson}

Goal:
Select the candidate(s) that refer to the **same physical drug or the closest U.S.-marketed product** as the input.
Consider ingredient, strength, unit, route, dosage form, salt form, and brand equivalence.

Rules:
- Match brand vs generic if same composition.
- Prefer exact strength + dosage form + route matches.
- Do not generalize or mix dosage forms (e.g., tablet ≠ suspension).
- For powders intended for reconstitution, “powder for oral suspension” = “oral suspension”.
- Output must be strict JSON with ranked candidates.

Return format:
{
  "best_match": {
    "name": "<exact candidate text>",
    "reason": "<brief clinical reasoning>"
  },
  "ranked": [
    {"name": "<candidate>", "similarity": 0.xx},
    ...
  ]
}
`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a precise RxNorm drug name matcher." },
        { role: "user", content: prompt },
      ],
    }),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`LLM re-rank failed (${res.status}): ${raw}`);
  }

  let parsed: any = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }

  const content = parsed?.choices?.[0]?.message?.content ?? parsed?.choices?.[0]?.message?.parsed;
  if (!content) {
    return null;
  }

  let data: any = content;
  if (typeof content === "string") {
    try {
      data = JSON.parse(content);
    } catch {
      data = {};
    }
  }

  const bestMatchName =
    typeof data?.best_match?.name === "string" ? data.best_match.name : null;
  const bestMatchReason =
    typeof data?.best_match?.reason === "string"
      ? data.best_match.reason
      : typeof data?.reason === "string"
      ? data.reason
      : null;

  const ranked: LlmRankedCandidate[] = Array.isArray(data?.ranked)
    ? data.ranked
        .map((entry: any) => {
          const name = typeof entry?.name === "string" ? entry.name : null;
          const similarity =
            typeof entry?.similarity === "number"
              ? entry.similarity
              : typeof entry?.score === "number"
              ? entry.score
              : null;
          if (!name || similarity === null) {
            return null;
          }
          return { name, similarity };
        })
        .filter((entry: LlmRankedCandidate | null): entry is LlmRankedCandidate => Boolean(entry))
    : [];

  return {
    bestMatch: bestMatchName,
    reason: bestMatchReason ?? null,
    ranked,
    raw: parsed,
  };
}

