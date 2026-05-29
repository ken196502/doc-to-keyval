import type { DictValue, ExtractedDict } from "./docx-extract";

export interface ReportFilterStats {
  originalEntries: number;
  filteredEntries: number;
  skippedEntries: number;
  originalLeaves: number;
  filteredLeaves: number;
  skippedLeaves: number;
  originalChars: number;
  filteredChars: number;
  skippedChars: number;
}

export interface ReportFilterResult {
  /** Compacted dict (placeholders instead of base64/long values) — send this to LLM */
  filtered: ExtractedDict;
  /** Skipped entries (also compacted) */
  skipped: ExtractedDict;
  /** Original dict with full data — for injecting into HTML via window.reportData */
  original: ExtractedDict;
  stats: ReportFilterStats;
}

const REPORT_KEYWORDS_RE =
  /投资|摘要|核心|逻辑|评级|目标价|公司|行业|市场|竞争|格局|业务|产品|客户|订单|渠道|管理层|治理|股权|财务|收入|营收|利润|净利|毛利|毛利率|现金流|费用|研发|预测|假设|估值|PE|PB|PS|PEG|DCF|EPS|ROE|ROIC|EBIT|EBITDA|FCF|风险|催化|成长|增长|驱动|产能|扩产|政策|份额|护城河|壁垒/i;

const IMAGE_URL_RE = /^https?:\/\/\S+\.(png|jpg|jpeg|gif|webp|svg|bmp)(\?\S*)?$/i;
const DATA_IMAGE_RE = /^data:image\/[a-z]+;base64,/i;
const LONG_BASE64ISH_RE = /^[A-Za-z0-9+/=]{180,}$/;
const PURE_PUNCT_RE = /^[\s\p{P}\p{S}]+$/u;
const PURE_NUMERIC_RE = /^[\s\d.,%+\-()/:~至¥$€£亿万千百十]+$/;
const DATEISH_RE = /\d{2,4}\s*[年\/.-]\s*\d{1,2}(?:\s*[月\/.-]\s*\d{1,2})?/;

type ScoredEntry = {
  key: string;
  value: DictValue;
  text: string;
  chars: number;
  leaves: number;
  score: number;
  index: number;
};

// ── Placeholder helpers ──────────────────────────────────────────

/**
 * Replace a single leaf string with a placeholder if it's a
 * base64 data-URL, raw base64, or image URL — saving thousands of
 * tokens per value while keeping the key discoverable for the LLM.
 */
function compactLeaf(value: string): string {
  if (DATA_IMAGE_RE.test(value)) return "[img]";
  if (LONG_BASE64ISH_RE.test(value)) return "[base64]";
  if (IMAGE_URL_RE.test(value)) return "[img-url]";
  return value;
}

/**
 * Recursively compact a DictValue: every leaf string that looks like
 * base64 / data-URL / image-URL is replaced with a short placeholder.
 * Image objects ({type:"image", dataUrl:...}) are replaced entirely.
 */
function compactValue(value: DictValue): DictValue {
  // Image object shorthand
  if (typeof value === "object" && value !== null && "type" in value) {
    const obj = value as Record<string, string>;
    if (obj.type === "image") return "[img]";
  }
  // Plain string
  if (typeof value === "string") return compactLeaf(value);
  // Nested Record<string, string>
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, string>)) {
    out[k] = compactLeaf(v);
  }
  return out;
}

/**
 * Compact an entire ExtractedDict for LLM consumption.
 * Returns a NEW dict; the original is untouched.
 */
export function compactForLLM(dict: ExtractedDict): ExtractedDict {
  const result: ExtractedDict = {};
  for (const [key, value] of Object.entries(dict)) {
    result[key] = compactValue(value);
  }
  return result;
}

// ── Filter logic ─────────────────────────────────────────────────

export function filterDictForReport(
  dict: ExtractedDict,
  opts?: { maxChars?: number; maxEntries?: number },
): ReportFilterResult {
  const maxChars = opts?.maxChars ?? 120000;
  const maxEntries = opts?.maxEntries ?? 2000;


  // Compact everything first so scoring/char-counting works on the
  // placeholder version (matches what the LLM actually sees).
  const compacted = compactForLLM(dict);

  const entries = Object.entries(compacted).map(([key, value], index) => ({
    key,
    value,
    index,
    text: flattenValue(value),
    chars: estimateValueChars(value),
    leaves: countValueLeaves(value),
  }));

  const scored = entries
    .map((entry, index, arr) => ({
      ...entry,
      score: scoreEntry(entry.text, arr[index - 1]?.text, arr[index + 1]?.text),
    }))
    .filter((entry) => !shouldHardSkipForReport(entry.text));

  const selected = scored
    .slice()
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .reduce<ScoredEntry[]>((acc, entry) => {
      const usedChars = acc.reduce((sum, item) => sum + item.chars, 0);
      if (acc.length >= maxEntries) return acc;
      if (usedChars + entry.chars > maxChars) return acc;
      if (entry.score <= 0) return acc;
      acc.push(entry);
      return acc;
    }, [])
    .sort((a, b) => a.index - b.index);

  const selectedKeys = new Set(selected.map((entry) => entry.key));
  const filtered: ExtractedDict = {};
  const skipped: ExtractedDict = {};

  // Return the compacted version (with placeholders) for LLM
  for (const [key, value] of Object.entries(compacted)) {
    if (selectedKeys.has(key)) filtered[key] = value;
    else skipped[key] = value;
  }

  const stats = buildStats(compacted, filtered, skipped);
  return { filtered, skipped, original: dict, stats };
}

function buildStats(
  original: ExtractedDict,
  filtered: ExtractedDict,
  skipped: ExtractedDict,
): ReportFilterStats {
  return {
    originalEntries: Object.keys(original).length,
    filteredEntries: Object.keys(filtered).length,
    skippedEntries: Object.keys(skipped).length,
    originalLeaves: countDictLeaves(original),
    filteredLeaves: countDictLeaves(filtered),
    skippedLeaves: countDictLeaves(skipped),
    originalChars: estimateDictChars(original),
    filteredChars: estimateDictChars(filtered),
    skippedChars: estimateDictChars(skipped),
  };
}

function scoreEntry(text: string, prev = "", next = ""): number {
  const v = normalizeText(text);
  if (!v) return -10;

  let score = 0;

  if (REPORT_KEYWORDS_RE.test(v)) score += 6;
  if (DATEISH_RE.test(v)) score += 2;
  if (/[A-Za-z\u4e00-\u9fff]/.test(v)) score += 2;
  if (/[¥$€£]|\d+\s*%|\d+\s*(亿|万|元|x|倍)/i.test(v)) score += 2;
  if (v.length >= 8 && v.length <= 120) score += 2;
  if (v.length > 120 && v.length <= 360) score += 1;
  if (PURE_NUMERIC_RE.test(v)) score -= 2;
  if (v.length > 800) score -= 2;

  if (PURE_NUMERIC_RE.test(v) && looksLikeLabel(prev)) score += 3;
  if (PURE_NUMERIC_RE.test(v) && looksLikeLabel(next)) score += 3;
  if (looksLikeLabel(v) && PURE_NUMERIC_RE.test(prev)) score += 1;
  if (looksLikeLabel(v) && PURE_NUMERIC_RE.test(next)) score += 1;

  return score;
}

function shouldHardSkipForReport(text: string): boolean {
  const v = normalizeText(text);
  if (!v) return true;
  if (IMAGE_URL_RE.test(v)) return true;
  if (DATA_IMAGE_RE.test(v)) return true;
  if (LONG_BASE64ISH_RE.test(v)) return true;
  if (PURE_PUNCT_RE.test(v)) return true;
  if (!/[\u4e00-\u9fffA-Za-z0-9]/.test(v)) return true;
  return false;
}

function looksLikeLabel(text: string): boolean {
  const v = normalizeText(text);
  if (!v) return false;
  if (v.length > 40) return false;
  if (PURE_NUMERIC_RE.test(v)) return false;
  return REPORT_KEYWORDS_RE.test(v) || /[A-Za-z\u4e00-\u9fff]/.test(v);
}

function flattenValue(value: DictValue): string {
  if (typeof value === "string") return normalizeText(value);
  return Object.values(value)
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .join(" | ");
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function countValueLeaves(value: DictValue): number {
  return typeof value === "string" ? 1 : Object.keys(value).length;
}

function countDictLeaves(dict: ExtractedDict): number {
  return Object.values(dict).reduce((sum, value) => sum + countValueLeaves(value), 0);
}

function estimateValueChars(value: DictValue): number {
  return JSON.stringify(value).length;
}

function estimateDictChars(dict: ExtractedDict): number {
  return JSON.stringify(dict).length;
}
