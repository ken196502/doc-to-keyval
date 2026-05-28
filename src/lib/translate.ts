import type { ExtractedDict } from "./docx-extract";

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
