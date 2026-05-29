import JSZip from "jszip";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export type DictValue = string | Record<string, string>;
export type ExtractedDict = Record<string, DictValue>;

export async function extractDocxToDict(file: File): Promise<ExtractedDict> {
  const zip = await JSZip.loadAsync(file);
  const xmlFile = zip.file("word/document.xml");
  if (!xmlFile) throw new Error("无效的docx文件：缺少 word/document.xml");
  const xml = await xmlFile.async("string");

  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const body = doc.getElementsByTagNameNS(W_NS, "body")[0];
  if (!body) throw new Error("文档body缺失");

  const dict: ExtractedDict = {};
  let pIdx = 0;
  let tdIdx = 0;

  // Collect text lines in a paragraph, splitting on <w:br/> and explicit \n in <w:t>
  const getParaLines = (p: Element): string[] => {
    const lines: string[] = [];
    let current = "";
    const runs = p.getElementsByTagNameNS(W_NS, "r");
    for (let i = 0; i < runs.length; i++) {
      const children = runs[i].childNodes;
      for (let j = 0; j < children.length; j++) {
        const c = children[j] as Element;
        if (c.nodeType !== 1) continue;
        if (c.localName === "t") {
          current += c.textContent ?? "";
        } else if (c.localName === "br" || c.localName === "cr") {
          lines.push(current);
          current = "";
        } else if (c.localName === "tab") {
          current += "\t";
        }
      }
    }
    lines.push(current);
    // also split on any literal \n that snuck in
    return lines
      .flatMap((l) => l.split(/\r?\n/))
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  };

  const linesToValue = (lines: string[]): DictValue | null => {
    if (lines.length === 0) return null;
    if (lines.length === 1) return lines[0];
  const linesToValue = (lines: string[]): DictValue | null => {
    if (lines.length === 0) return null;
    if (lines.length === 1) return lines[0];
    const obj: Record<string, string> = {};
    lines.forEach((l, i) => {
      obj[`p${i + 1}`] = l;
    });
    return obj;
  };

    while (p && (p as Element).localName !== "body") {
      if ((p as Element).localName === "tbl") return true;
      p = p.parentNode;
    }
    return false;
  };

  const walk = (node: Element) => {
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i] as Element;
      if (child.nodeType !== 1) continue;
      const local = child.localName;
      if (local === "p") {
        if (isInsideTable(child)) continue;
        const lines = getParaLines(child);
        const value = linesToValue(lines);
        if (value !== null) {
          pIdx++;
          dict[`p-${pIdx}`] = value;
        }
      } else if (local === "tbl") {
        const cells = child.getElementsByTagNameNS(W_NS, "tc");
        for (let c = 0; c < cells.length; c++) {
          const ps = cells[c].getElementsByTagNameNS(W_NS, "p");
          const allLines: string[] = [];
          for (let j = 0; j < ps.length; j++) {
            allLines.push(...getParaLines(ps[j]));
          }
          const value = linesToValue(allLines);
          if (value !== null) {
            tdIdx++;
            dict[`td-${tdIdx}`] = value;
          }
        }
      } else {
        walk(child);
      }
    }
  };

  walk(body);
  return dict;
}

// Decide if a leaf string value should be skipped (not translated)
export function shouldSkip(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (/^[\s\d\.,%+\-()¥$€£]+$/.test(v)) return true;
  if (/^https?:\/\/\S+\.(png|jpg|jpeg|gif|webp|svg|bmp)(\?\S*)?$/i.test(v)) return true;
  if (/^data:image\/[a-z]+;base64,/i.test(v)) return true;
  if (/^[A-Za-z0-9+/=]{200,}$/.test(v)) return true;
  if (!/[\u4e00-\u9fffA-Za-z]/.test(v)) return true;
  return false;
}

// Recursively split a value into translatable and skipped parts.
// Returns null for a side when nothing belongs there.
function splitValue(v: DictValue): { keep: DictValue | null; skip: DictValue | null } {
  if (typeof v === "string") {
    return shouldSkip(v) ? { keep: null, skip: v } : { keep: v, skip: null };
  }
  const keepObj: Record<string, string> = {};
  const skipObj: Record<string, string> = {};
  for (const [k, inner] of Object.entries(v)) {
    const r = splitValue(inner);
    if (r.keep !== null) keepObj[k] = r.keep as string;
    if (r.skip !== null) skipObj[k] = r.skip as string;
  }
  return {
    keep: Object.keys(keepObj).length ? keepObj : null,
    skip: Object.keys(skipObj).length ? skipObj : null,
  };
}

export function splitDict(dict: ExtractedDict): {
  toTranslate: ExtractedDict;
  skipped: ExtractedDict;
} {
  const toTranslate: ExtractedDict = {};
  const skipped: ExtractedDict = {};
  for (const [k, v] of Object.entries(dict)) {
    const r = splitValue(v);
    if (r.keep !== null) toTranslate[k] = r.keep;
    if (r.skip !== null) skipped[k] = r.skip;
  }
  return { toTranslate, skipped };
}

// Count leaf string entries (for progress / stats)
export function countLeaves(dict: ExtractedDict): number {
  let n = 0;
  for (const v of Object.values(dict)) {
    if (typeof v === "string") n++;
    else n += Object.keys(v).length;
  }
  return n;
}

// Merge translated + skipped back over the original structure
export function mergeDict(
  original: ExtractedDict,
  translated: ExtractedDict | null,
  skipped: ExtractedDict | null,
): ExtractedDict {
  const mergeVal = (o: DictValue, t: DictValue | undefined, s: DictValue | undefined): DictValue => {
    if (typeof o === "string") {
      if (typeof t === "string") return t;
      if (typeof s === "string") return s;
      return o;
    }
    const out: Record<string, string> = {};
    for (const k of Object.keys(o)) {
      const tk = t && typeof t === "object" ? (t as Record<string, string>)[k] : undefined;
      const sk = s && typeof s === "object" ? (s as Record<string, string>)[k] : undefined;
      out[k] = mergeVal(o[k], tk, sk) as string;
    }
    return out;
  };
  const out: ExtractedDict = {};
  for (const k of Object.keys(original)) {
    out[k] = mergeVal(original[k], translated?.[k], skipped?.[k]);
  }
  return out;
}
