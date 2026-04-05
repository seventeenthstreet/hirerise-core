import "dotenv/config";

/**
 * @file src/services/embedQuery.ts
 * @description
 * Shared Gemini embedding client.
 *
 * Optimized for:
 * - lazy API key resolution
 * - timeout-safe fetch
 * - input normalization
 * - response validation
 * - deterministic dimensionality
 */

const MODEL = "models/gemini-embedding-001";
const OUTPUT_DIMENSIONALITY = 768;
const REQUEST_TIMEOUT_MS = 10000;

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim();

  if (!key) {
    throw new Error("Missing GEMINI_API_KEY");
  }

  return key;
}

function normalizeText(text: string): string {
  return String(text || "").trim();
}

function validateEmbedding(values: unknown): number[] {
  if (!Array.isArray(values)) {
    throw new Error("Invalid embedding response shape");
  }

  const numeric = values.map((v) => Number(v));

  if (
    numeric.length !== OUTPUT_DIMENSIONALITY ||
    numeric.some((v) => !Number.isFinite(v))
  ) {
    throw new Error(
      `Embedding dimension mismatch. Expected ${OUTPUT_DIMENSIONALITY}, got ${numeric.length}`
    );
  }

  return numeric;
}

// Shared embedding function (used everywhere)
export async function embedQuery(text: string): Promise<number[]> {
  const safeText = normalizeText(text);

  if (!safeText) {
    throw new Error("Text is required for embedding");
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${getApiKey()}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          content: {
            parts: [{ text: safeText }],
          },
          taskType: "RETRIEVAL_QUERY",
          outputDimensionality: OUTPUT_DIMENSIONALITY,
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Gemini API error ${response.status}: ${errorText}`
      );
    }

    const data = await response.json();

    return validateEmbedding(data?.embedding?.values);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `Gemini embedding request timed out after ${REQUEST_TIMEOUT_MS}ms`
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}