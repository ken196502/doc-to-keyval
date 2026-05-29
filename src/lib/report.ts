import type { ExtractedDict } from "./docx-extract";
import templateHtml from "../../template.html?raw";

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const SYSTEM_PROMPT = `You are a senior financial research report editor and HTML front-end engineer.
Your job is to generate a polished, standalone HTML report from a source JSON object.

Hard requirements:
- Use the provided @template as the visual and structural reference.
- Use the original JSON keys and values as the source of truth.
- Return ONLY one complete HTML document, no markdown fences, no explanations.
- Keep the report language consistent with the source content unless the source clearly indicates another language.
- Do not fabricate unavailable facts, figures, dates, ratings, or prices.
- The HTML must be browser-runnable as a standalone file.
- The HTML must include JavaScript that reads the original JSON from:
  const reportDataEl = document.getElementById("report-data");
  const reportData = reportDataEl ? JSON.parse(reportDataEl.textContent || "{}") : {};
- Use reportData to fill the page content.
- Keep the page visually refined and readable even when some fields are missing.
- You may reorganize sections, but the style should remain close to @template.

Implementation requirements:
- Include <script id="report-data" type="application/json"></script> somewhere before the final rendering script.
- Prefer safe helper functions for missing keys, for example flattening keys, fallback text, and filtering empty values.
- If charts are not feasible, render elegant summary cards, tables, timelines, and key-value sections instead.
- Avoid external dependencies except lightweight CDN usage already present in the template style.`;

export async function generateHtmlReport(
  promptDict: ExtractedDict,
  cfg: LLMConfig,
  originalDict: ExtractedDict = promptDict,
  signal?: AbortSignal,
): Promise<string> {
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const body = {
    model: cfg.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          [
            "Please generate a polished standalone HTML report.",
            "",
            "@template",
            templateHtml,
            "",
            "@curated_report_json",
            JSON.stringify(promptDict, null, 2),
            "",
            "Important: the curated JSON above is intentionally compacted for token efficiency. Build the report from it.",
          ].join("\n"),
      },
    ],
    temperature: 0.3,
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
  const html = parseHtmlLoose(content);
  if (!html) {
    throw new Error("LLM 返回的不是有效 HTML");
  }

  return injectReportData(html, originalDict);
}

function parseHtmlLoose(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("<!DOCTYPE html") || trimmed.startsWith("<html")) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const htmlMatch = trimmed.match(/<!DOCTYPE html[\s\S]*<\/html>/i) ?? trimmed.match(/<html[\s\S]*<\/html>/i);
  return htmlMatch?.[0]?.trim() ?? "";
}

function injectReportData(html: string, dict: ExtractedDict): string {
  const serialized = safeJsonForScript(dict);
  const dataScript = `<script id="report-data" type="application/json">${serialized}</script>`;
  const bootstrapScript = `<script>
const reportDataEl = document.getElementById("report-data");
const reportData = reportDataEl ? JSON.parse(reportDataEl.textContent || "{}") : {};
window.reportData = reportData;
</script>`;

  let next = html;

  if (/<script[^>]+id=["']report-data["']/i.test(next)) {
    next = next.replace(
      /<script[^>]*id=["']report-data["'][^>]*>[\s\S]*?<\/script>/i,
      dataScript,
    );
  } else if (/<body[^>]*>/i.test(next)) {
    next = next.replace(/<body([^>]*)>/i, `<body$1>\n${dataScript}`);
  } else if (/<\/html>/i.test(next)) {
    next = next.replace(/<\/html>/i, `${dataScript}\n</html>`);
  } else {
    next += `\n${dataScript}`;
  }

  if (!/const reportDataEl = document\.getElementById\(["']report-data["']\)/.test(next)) {
    next = next.replace(/<\/body>/i, `${bootstrapScript}\n</body>`);
    if (next === html || !/<\/body>/i.test(next)) {
      next += `\n${bootstrapScript}`;
    }
  }

  return next;
}

function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
