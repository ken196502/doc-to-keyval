import JSZip from "jszip";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export type ExtractedDict = Record<string, string>;

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

  const getParagraphText = (p: Element): string => {
    const texts = p.getElementsByTagNameNS(W_NS, "t");
    let s = "";
    for (let i = 0; i < texts.length; i++) s += texts[i].textContent ?? "";
    return s.trim();
  };

  const walk = (node: Element) => {
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i] as Element;
      if (child.nodeType !== 1) continue;
      const local = child.localName;
      if (local === "p") {
        // Skip paragraphs inside tables (handled by tc)
        if (isInsideTable(child)) continue;
        const text = getParagraphText(child);
        if (text) {
          pIdx++;
          dict[`p-${pIdx}`] = text;
        }
      } else if (local === "tbl") {
        const cells = child.getElementsByTagNameNS(W_NS, "tc");
        for (let c = 0; c < cells.length; c++) {
          const ps = cells[c].getElementsByTagNameNS(W_NS, "p");
          const parts: string[] = [];
          for (let j = 0; j < ps.length; j++) {
            const t = getParagraphText(ps[j]);
            if (t) parts.push(t);
          }
          const text = parts.join("\n").trim();
          tdIdx++;
          dict[`td-${tdIdx}`] = text;
        }
      } else {
        walk(child);
      }
    }
  };

  const isInsideTable = (el: Element): boolean => {
    let p: Node | null = el.parentNode;
    while (p && (p as Element).localName !== "body") {
      if ((p as Element).localName === "tbl") return true;
      p = p.parentNode;
    }
    return false;
  };

  walk(body);
  return dict;
}

// Decide if a value should be skipped (not translated)
export function shouldSkip(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  // Pure numeric (with commas, decimals, %, +/-, parens for negatives, currency, spaces)
  if (/^[\s\d\.,%+\-()¥$€£]+$/.test(v)) return true;
  // Image URLs
  if (/^https?:\/\/\S+\.(png|jpg|jpeg|gif|webp|svg|bmp)(\?\S*)?$/i.test(v)) return true;
  // Data URIs / base64
  if (/^data:image\/[a-z]+;base64,/i.test(v)) return true;
  if (/^[A-Za-z0-9+/=]{200,}$/.test(v)) return true;
  // No CJK and no latin letters → likely symbols/numbers only
  if (!/[\u4e00-\u9fffA-Za-z]/.test(v)) return true;
  return false;
}

export function splitDict(dict: ExtractedDict): {
  toTranslate: ExtractedDict;
  skipped: ExtractedDict;
} {
  const toTranslate: ExtractedDict = {};
  const skipped: ExtractedDict = {};
  for (const [k, v] of Object.entries(dict)) {
    if (shouldSkip(v)) skipped[k] = v;
    else toTranslate[k] = v;
  }
  return { toTranslate, skipped };
}
