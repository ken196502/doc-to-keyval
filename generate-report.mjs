#!/usr/bin/env node
/**
 * Generate HTML report from docx file using LLM
 * Usage: node generate-report.mjs <docx-file>
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read .env file
const envPath = path.join(__dirname, '.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
const env = {};
envContent.split('\n').forEach(line => {
  const match = line.match(/^([A-Z_]+)=(.+)$/);
  if (match) {
    env[match[1]] = match[2].replace(/^"|"$/g, '');
  }
});

console.log('Environment loaded:');
console.log('  LLM_BASE_URL:', env.LLM_BASE_URL);
console.log('  LLM_MODEL:', env.LLM_MODEL);
console.log('  LLM_API_KEY:', env.LLM_API_KEY ? '***' + env.LLM_API_KEY.slice(-8) : 'NOT SET');

// Get target file
const targetFile = process.argv[2];
if (!targetFile || !fs.existsSync(targetFile)) {
  console.error('Usage: node generate-report.mjs <docx-file>');
  console.error('Test files:');
  console.error('  test/BTC ETF点评.docx');
  console.error('  test/天风证券_公司报告_季报点评_26Q1业绩暂承压，期待产品、渠道调整显效—老凤祥（600612）_何富丽.docx');
  process.exit(1);
}

console.log('\n=== Generating HTML Report ===');
console.log('Input file:', targetFile);

// Read template
const templateHtml = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf-8');

// Docx extraction
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

async function extractDocxToDict(fileBuffer) {
  const zip = await JSZip.loadAsync(fileBuffer);
  const xmlFile = zip.file("word/document.xml");
  if (!xmlFile) throw new Error("无效的docx文件：缺少 word/document.xml");
  const xml = await xmlFile.async("string");

  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "application/xml");
  const body = doc.getElementsByTagNameNS(W_NS, "body")[0];
  if (!body) throw new Error("文档body缺失");

  const dict = {};
  let pIdx = 0;
  let tcIdx = 0;

  const getParaLines = (p) => {
    const lines = [];
    let current = "";
    const runs = p.getElementsByTagNameNS(W_NS, "r");
    for (let i = 0; i < runs.length; i++) {
      const children = runs[i].childNodes;
      for (let j = 0; j < children.length; j++) {
        const c = children[j];
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
    return lines
      .flatMap((l) => l.split(/\r?\n/))
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  };

  const linesToValue = (lines) => {
    if (lines.length === 0) return null;
    if (lines.length === 1) return lines[0];
    const obj = {};
    lines.forEach((l, i) => {
      obj[`p${i + 1}`] = l;
    });
    return obj;
  };

  const isInsideTable = (el) => {
    let p = el.parentNode;
    while (p && p.localName !== "body") {
      if (p.localName === "tbl") return true;
      p = p.parentNode;
    }
    return false;
  };

  const walk = (node) => {
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i];
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
          const allLines = [];
          for (let j = 0; j < ps.length; j++) {
            allLines.push(...getParaLines(ps[j]));
          }
          const value = linesToValue(allLines);
          if (value !== null) {
            tcIdx++;
            dict[`tc-${tcIdx}`] = value;
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

// Call LLM to generate HTML
async function generateHtmlReport(promptDict, templateHtml, originalDict, cfg) {
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  
  const systemPrompt = `You are a senior financial research report editor and HTML front-end engineer.
Your job is to generate a polished, standalone HTML report from a source JSON object.

Hard requirements:
- Use the provided @template as the visual and structural reference.
- Use the original JSON keys and values as the source of truth.
- Return ONLY one complete HTML document, no markdown fences, no explanations.
- Keep the report language consistent with the source content.
- Do not fabricate unavailable facts, figures, dates, ratings, or prices.
- The HTML must be browser-runnable as a standalone file.
- The HTML must include JavaScript that reads the original JSON from:
  const reportDataEl = document.getElementById("report-data");
  const reportData = reportDataEl ? JSON.parse(reportDataEl.textContent || "{}") : {};
- Use reportData to fill the page content.

Implementation requirements:
- Include <script id="report-data" type="application/json"></script> somewhere before the final rendering script.
- Prefer safe helper functions for missing keys, for example flattening keys, fallback text, and filtering empty values.`;

  const body = {
    model: cfg.model,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
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
  });
  
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`LLM ${resp.status}: ${text.slice(0, 300)}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  
  // Parse HTML from response
  let html = content.trim();
  if (html.startsWith("```")) {
    const match = html.match(/```(?:html)?\s*([\s\S]*?)```/);
    if (match) html = match[1].trim();
  }
  
  // Inject original JSON
  const serialized = JSON.stringify(originalDict)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
  
  const dataScript = `<script id="report-data" type="application/json">${serialized}</script>`;
  const bootstrapScript = `<script>const reportDataEl = document.getElementById("report-data"); const reportData = reportDataEl ? JSON.parse(reportDataEl.textContent || "{}") : {}; window.reportData = reportData;</script>`;
  
  if (/<script[^>]+id=["']report-data["']/i.test(html)) {
    html = html.replace(/<script[^>]*id=["']report-data["'][^>]*>[\s\S]*?<\/script>/i, dataScript);
  } else if (/<body[^>]*>/i.test(html)) {
    html = html.replace(/<body([^>]*)>/i, `<body$1>\n${dataScript}`);
  } else if (/<\/html>/i.test(html)) {
    html = html.replace(/<\/html>/i, `${dataScript}\n</html>`);
  } else {
    html += `\n${dataScript}`;
  }
  
  if (!/const reportDataEl = document\.getElementById\(["']report-data["']\)/.test(html)) {
    html = html.replace(/<\/body>/i, `${bootstrapScript}\n</body>`);
    if (!/<\/body>/i.test(html)) {
      html += `\n${bootstrapScript}`;
    }
  }
  
  return html;
}

// Main execution
async function main() {
  try {
    const fileBuffer = fs.readFileSync(targetFile);
    
    console.log('\nStep 1: Extracting docx...');
    const dict = await extractDocxToDict(fileBuffer);
    console.log(`  ✓ Entries: ${Object.keys(dict).length}`);
    console.log(`  ✓ Chars: ${JSON.stringify(dict).length}`);
    
    console.log('\nStep 2: Calling LLM to generate HTML...');
    console.log('  This may take 20-60 seconds...');
    
    const cfg = {
      baseUrl: env.LLM_BASE_URL,
      apiKey: env.LLM_API_KEY,
      model: env.LLM_MODEL
    };
    
    const startTime = Date.now();
    const html = await generateHtmlReport(dict, templateHtml, dict, cfg);
    const elapsed = Date.now() - startTime;
    
    console.log(`  ✓ LLM call completed in ${(elapsed / 1000).toFixed(1)} seconds`);
    console.log(`  ✓ Generated HTML size: ${html.length} chars`);
    
    // Save output
    const outputPath = targetFile.replace('.docx', '-report.html');
    fs.writeFileSync(outputPath, html);
    console.log(`\n✅ Report saved to: ${outputPath}`);
    
    // Verify
    console.log('\n--- Verification ---');
    console.log(`  ✓ Contains report-data script: ${html.includes('id="report-data"')}`);
    console.log(`  ✓ Contains window.reportData: ${html.includes('window.reportData')}`);
    console.log(`  ✓ Contains HTML structure: ${html.includes('<!DOCTYPE html') || html.includes('<html')}`);
    
  } catch (error) {
    console.error('\n❌ Failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
