import type { ExtractedDict } from "./docx-extract";
import { splitDict, mergeDict, type DictValue } from "./docx-extract";
import { compactForLLM } from "./report-filter";

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const SYSTEM_PROMPT = `You are a professional financial research report translator. Translate the VALUES of the given JSON from Chinese to English. 
Rules:
- Keep the original keys exactly unchanged.
- Translate only the string values.
- Preserve numbers, tickers, company codes, units, and punctuation faithfully.
- Output ONLY a valid JSON object with the same keys, no commentary, no markdown fences.`;

export async function translateChunk(
  chunk: ExtractedDict,
  cfg: LLMConfig,
  signal?: AbortSignal,
): Promise<ExtractedDict> {
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const body = {
    model: cfg.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "Translate values of this JSON to English. Return JSON only.\n\n" + JSON.stringify(chunk, null, 2) },
    ],
    temperature: 0.2,
    response_format: { type: "json_object" },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`LLM ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = await resp.json();
  const content: string = data?.choices?.[0]?.message?.content ?? "";
  const parsed = parseJsonLoose(content);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("LLM返回不是有效JSON: " + content.slice(0, 200));
  }
  return parsed as ExtractedDict;
}

function parseJsonLoose(s: string): unknown {
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

export function chunkDict(dict: ExtractedDict, maxChars = 3000): ExtractedDict[] {
  const entries = Object.entries(dict);
  const chunks: ExtractedDict[] = [];
  let cur: ExtractedDict = {};
  let size = 0;
  for (const [k, v] of entries) {
    const add = k.length + JSON.stringify(v).length + 8;
    if (size + add > maxChars && Object.keys(cur).length > 0) {
      chunks.push(cur);
      cur = {};
      size = 0;
    }
    cur[k] = v;
    size += add;
  }
  if (Object.keys(cur).length > 0) chunks.push(cur);
  return chunks;
}

export async function translateDict(
  dict: ExtractedDict,
  cfg: LLMConfig,
  opts?: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal; chunkChars?: number },
): Promise<ExtractedDict> {
  const chunks = chunkDict(dict, opts?.chunkChars ?? 3000);
  const out: ExtractedDict = {};
  for (let i = 0; i < chunks.length; i++) {
    const translated = await translateChunk(chunks[i], cfg, opts?.signal);
    Object.assign(out, translated);
    opts?.onProgress?.(i + 1, chunks.length);
  }
  return out;
}

// ── High-level: translate entire dict for English report ──────────

export interface TranslateProgress {
  phase: "filter" | "translate" | "merge";
  /** Current chunk / total chunks (only meaningful during "translate") */
  done: number;
  total: number;
}

/**
 * Translate an entire ExtractedDict to English, suitable for generating
 * an English HTML report.
 *
 * Pipeline:
 * 1. splitDict — separate translatable text from skip-able content (base64, images, pure numbers)
 * 2. compactForLLM — replace base64 / long strings with placeholders to save tokens
 * 3. translateDict — send compacted translatable text to LLM in chunks
 * 4. mergeDict — merge translated values + skipped values back into original structure
 *
 * The returned dict preserves all original image objects and skipped values
 * while having all translatable text converted to English.
 */
export async function translateDictForReport(
  dict: ExtractedDict,
  cfg: LLMConfig,
  opts?: { onProgress?: (p: TranslateProgress) => void; signal?: AbortSignal; chunkChars?: number },
): Promise<ExtractedDict> {
  // Step 1: split into translatable / skipped
  opts?.onProgress?.({ phase: "filter", done: 0, total: 1 });
  const { toTranslate, skipped } = splitDict(dict);

  const translatableKeys = Object.keys(toTranslate);
  if (translatableKeys.length === 0) {
    // Nothing to translate — return as-is (images & numbers only)
    opts?.onProgress?.({ phase: "merge", done: 1, total: 1 });
    return dict;
  }

  // Step 2: compact the translatable part for LLM (replace base64 etc.)
  const compacted = compactForLLM(toTranslate);

  // Step 3: translate chunk by chunk
  const translated = await translateDict(compacted, cfg, {
    onProgress: (done, total) => {
      opts?.onProgress?.({ phase: "translate", done, total });
    },
    signal: opts?.signal,
    chunkChars: opts?.chunkChars,
  });

  // Step 4: merge translated + skipped back over original structure
  opts?.onProgress?.({ phase: "merge", done: 1, total: 1 });
  return mergeDict(dict, translated, skipped);
}
