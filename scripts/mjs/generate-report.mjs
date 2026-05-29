#!/usr/bin/env node
/**
 * Generate HTML report from docx file using LLM
 * Usage: node scripts/mjs/generate-report.mjs <docx-file>
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");

// Read .env file
const envPath = path.join(projectRoot, ".env");
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
  console.error("Usage: node scripts/mjs/generate-report.mjs <docx-file>");
  console.error('Test files:');
  console.error('  test/BTC ETF点评.docx');
  console.error('  test/天风证券_公司报告_季报点评_26Q1业绩暂承压，期待产品、渠道调整显效—老凤祥（600612）_何富丽.docx');
  process.exit(1);
}

console.log('\n=== Generating HTML Report ===');
console.log('Input file:', targetFile);

// Read template
const templateHtml = fs.readFileSync(path.join(projectRoot, "template.html"), "utf-8");

// Docx extraction
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const PIC_NS = "http://schemas.openxmlformats.org/drawingml/2006/picture";

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
  let imgIdx = 0;

  // Extract all images from word/media/ and convert to base64
  const imageMap = new Map(); // rId -> { filename, base64, mimeType }
  const mediaFiles = Object.keys(zip.files).filter(path => 
    path.startsWith("word/media/") || path.startsWith("word/Media/")
  );
  
  for (const mediaPath of mediaFiles) {
    const file = zip.file(mediaPath);
    if (!file) continue;
    
    const ext = path.extname(mediaPath).toLowerCase();
    let mimeType = "image/png";
    if (ext === ".jpg" || ext === ".jpeg") mimeType = "image/jpeg";
    else if (ext === ".png") mimeType = "image/png";
    else if (ext === ".gif") mimeType = "image/gif";
    else if (ext === ".bmp") mimeType = "image/bmp";
    else if (ext === ".webp") mimeType = "image/webp";
    
    const buffer = await file.async("nodebuffer");
    const base64 = buffer.toString("base64");
    const filename = path.basename(mediaPath);
    
    imageMap.set(filename, {
      filename,
      base64,
      mimeType,
      dataUrl: `data:${mimeType};base64,${base64}`
    });
  }

  // Parse relationships to map rId to filename
  const relsPath = "word/_rels/document.xml.rels";
  const relsFile = zip.file(relsPath);
  let rIdToFilename = new Map();
  
  if (relsFile) {
    const relsXml = await relsFile.async("string");
    const relsDoc = parser.parseFromString(relsXml, "application/xml");
    const relationships = relsDoc.getElementsByTagName("Relationship");
    
    for (let i = 0; i < relationships.length; i++) {
      const rel = relationships[i];
      const rId = rel.getAttribute("Id");
      const target = rel.getAttribute("Target");
      const type = rel.getAttribute("Type");
      
      if (type && type.includes("image")) {
        // Handle relative path
        const filename = target.split("/").pop();
        rIdToFilename.set(rId, filename);
      }
    }
  }

  // Helper function to extract image from drawing element
  const extractImageFromDrawing = (drawing) => {
    // Try to find blip element which contains the rId
    const blip = drawing.getElementsByTagNameNS(A_NS, "blip")[0];
    if (blip) {
      const embed = blip.getAttribute("r:embed");
      const link = blip.getAttribute("r:link");
      const rId = embed || link;
      
      if (rId && rIdToFilename.has(rId)) {
        const filename = rIdToFilename.get(rId);
        if (imageMap.has(filename)) {
          return imageMap.get(filename);
        }
      }
    }
    return null;
  };

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

  // First: scan the entire document for all drawing elements to extract images
  const allDrawings = body.getElementsByTagNameNS(W_NS, "drawing");
  for (let d = 0; d < allDrawings.length; d++) {
    const img = extractImageFromDrawing(allDrawings[d]);
    if (img) {
      imgIdx++;
      dict[`img-${imgIdx}`] = {
        type: "image",
        filename: img.filename,
        dataUrl: img.dataUrl,
        mimeType: img.mimeType
      };
    }
  }

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

/**
 * Recursively compact a dict for LLM consumption:
 * - Image objects ({type:"image", dataUrl:...}) → "[img]"
 * - base64 data-URL strings → "[img]"
 * - Long base64-ish strings → "[base64]"
 * - Image URLs → "[img-url]"
 * Returns a NEW dict; the original is untouched.
 */
function compactLeaf(value) {
  if (/^data:image\/[a-z]+;base64,/i.test(value)) return "[img]";
  if (/^[A-Za-z0-9+/=]{180,}$/.test(value)) return "[base64]";
  if (/^https?:\/\/\S+\.(png|jpg|jpeg|gif|webp|svg|bmp)(\?\S*)?$/i.test(value)) return "[img-url]";
  return value;
}

function compactValue(value) {
  if (typeof value === "object" && value !== null && value.type === "image") return "[img]";
  if (typeof value === "string") return compactLeaf(value);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = compactLeaf(v);
  }
  return out;
}

function compactForLLM(dict) {
  const result = {};
  for (const [key, value] of Object.entries(dict)) {
    result[key] = compactValue(value);
  }
  return result;
}

// Call LLM to generate HTML
async function generateHtmlReport(promptDict, templateHtml, originalDict, cfg) {
  // Compact the prompt dict (replace base64/images with placeholders)
  const promptDictCompacted = compactForLLM(promptDict);

  const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  
  const systemPrompt = `You are a senior financial research report editor and HTML front-end engineer.
Your job is to generate a polished, standalone HTML report from a source JSON object.

CRITICAL - Data Format Understanding:
The source JSON uses flattened keys like "tc-1", "tc-2", "p-1", "p-2", "img-1" etc.
- Keys starting with "tc-" are table cell content (usually from tables in the original docx)
- Keys starting with "p-" are paragraph content
- Keys starting with "img-" are image content
- The values can be either strings or nested objects (with p1, p2, p3... sub-keys)
YOU MUST extract ALL meaningful content from these keys and display them in the report.

Hard requirements:
- Use the provided @template as the visual and structural reference for styling and layout.
- Use the original JSON keys and values as the source of truth - extract ALL available data.
- Return ONLY one complete HTML document, no markdown fences, no explanations.
- Keep the report language consistent with the source content (typically Chinese).
- Do not fabricate unavailable facts, figures, dates, ratings, or prices - only use what's in the JSON.
- The HTML must be browser-runnable as a standalone file.
- IMPORTANT: A global variable window.reportData is ALREADY defined for you BEFORE any of your scripts run.
  It contains the FULL source JSON object (with original image data, not placeholders).
  - DO NOT redeclare it. Never write \`const reportData = ...\` or \`let reportData = ...\` or \`var reportData = ...\` at top level.
  - Read it as \`const data = window.reportData || {};\` inside your script.
  - DO NOT add another <script id="report-data"> block — it is already injected.

CRITICAL — Placeholder handling:
- The @curated_report_json below has been compacted for token efficiency:
  - Image objects are replaced with "[img]" placeholders.
  - base64 strings are replaced with "[base64]" placeholders.
  - Image URLs are replaced with "[img-url]" placeholders.
- When you need to render images, use window.reportData to get the ORIGINAL data:
  - For keys that were "[img]" in the curated JSON, the original window.reportData[key] may be
    an object like {type:"image", dataUrl:"data:image/...", filename:"...", mimeType:"..."}.
    Render it as <img src="${data[key].dataUrl}" />.
  - For keys whose leaf values were "[base64]", read the original value from window.reportData[key].
- ALWAYS prefer reading from window.reportData over the curated JSON for any value that looks like a placeholder.

Image sizing requirements:
- ALL images (charts, graphs, figures) MUST be displayed at FULL WIDTH of their container.
- Use style="width:100%;height:auto;" on every <img> tag.
- Never use fixed pixel widths or leave images at their default small size.
- Wrap images in a full-width container: <div style="width:100%"><img ... style="width:100%;height:auto" /></div>
- Charts and graphs from the source document are key visual content — make them prominent and large.

Table & print requirements (CRITICAL):
- This report MUST be printable. NEVER use overflow:auto, overflow-y:auto, overflow-x:auto, or max-height on any table or container.
- NEVER wrap tables in scrollable containers. Tables must be fully visible without scrolling.
- If a table is too wide, make it responsive by: reducing font-size, using shorter headers, or breaking into multiple smaller tables — but NEVER add horizontal scroll.
- If a table is too tall, let it flow naturally across pages — do NOT clip it with max-height or overflow-y.
- All <table> elements should use: border-collapse:collapse; width:100%; font-size:10px or smaller; to fit within A4 width.
- Add this CSS rule for print: @media print { table { page-break-inside:auto; } tr { page-break-inside:avoid; page-break-after:auto; } }
- NEVER use max-h-* tailwind class or max-height CSS on table containers.

Structure Requirements:
- Include a cover page with title, date, and key metadata extracted from the JSON
- Include sections for: investment summary, company overview, financial analysis, risk factors
- Generate AT LEAST 5-6 pages of content using ALL available data from the JSON
- Use proper semantic HTML structure with sections, headings, and content areas
- The report should be comprehensive and professional, not minimal

Implementation requirements:
- Create JavaScript code that reads window.reportData and iterates through ALL keys to render content dynamically.
- Prefer safe helper functions for missing keys, for example flattening keys, fallback text, and filtering empty values.
- DO NOT leave elements empty - fill them with actual data from the JSON.`;

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
          JSON.stringify(promptDictCompacted, null, 2),
          "",
          "Important: the curated JSON above is intentionally compacted for token efficiency. When rendering, use window.reportData to access the full original values (images, base64, etc.).",
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

// Enhanced JSON injection with verification
function injectReportData(html, originalDict) {
  // Validate input
  if (!html || typeof html !== 'string') {
    throw new Error('Invalid HTML content');
  }
  if (!originalDict || Object.keys(originalDict).length === 0) {
    throw new Error('Empty data dictionary');
  }

  // Serialize JSON with HTML escaping
  const serialized = JSON.stringify(originalDict)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");

  // Create data script
  const dataScript = `<script id="report-data" type="application/json">${serialized}</script>`;

  // Create bootstrap script with error handling
  const bootstrapScript = `<script>
(function() {
  try {
    const el = document.getElementById('report-data');
    if (!el) {
      console.error('[Report Data] Missing report-data element');
      window.reportData = {};
      return;
    }
    const content = el.textContent || '{}';
    window.reportData = JSON.parse(content);
    console.log('[Report Data] Loaded successfully:', Object.keys(window.reportData).length, 'entries');
  } catch (e) {
    console.error('[Report Data] Parse error:', e.message);
    window.reportData = {};
  }
})();
</script>`;

  // Inject into HTML
  let modifiedHtml = html;

  // Try to replace existing report-data script
  if (/<script[^>]+id=["']report-data["']/i.test(modifiedHtml)) {
    modifiedHtml = modifiedHtml.replace(
      /<script[^>]*id=["']report-data["'][^>]*>[\s\S]*?<\/script>/i,
      dataScript
    );
    console.log('  ✓ Replaced existing report-data script');
  } else if (/<head[^>]*>/i.test(modifiedHtml)) {
    // Inject into head
    modifiedHtml = modifiedHtml.replace(
      /<head([^>]*)>/i,
      `<head$1>\n${dataScript}\n${bootstrapScript}`
    );
    console.log('  ✓ Injected into <head>');
  } else if (/<body[^>]*>/i.test(modifiedHtml)) {
    // Inject at start of body
    modifiedHtml = modifiedHtml.replace(
      /<body([^>]*)>/i,
      `<body$1>\n${dataScript}\n${bootstrapScript}`
    );
    console.log('  ✓ Injected into <body>');
  } else {
    // Fallback: prepend to HTML
    modifiedHtml = `${dataScript}\n${bootstrapScript}\n${modifiedHtml}`;
    console.log('  ⚠️ Prepend to HTML (unusual structure)');
  }

  // Verify injection
  if (!modifiedHtml.includes('id="report-data"')) {
    throw new Error('Data injection failed: report-data element not found after injection');
  }

  return modifiedHtml;
}

// Main execution
async function main() {
  try {
    const fileBuffer = fs.readFileSync(targetFile);

    console.log('\n📄 Step 1: Extracting docx...');
    const dict = await extractDocxToDict(fileBuffer);
    console.log(`   ✓ Entries: ${Object.keys(dict).length}`);
    console.log(`   ✓ Original Chars: ${JSON.stringify(dict).length}`);

    // Calculate size after compacting for display
    const dictCompacted = compactForLLM(dict);
    console.log(`   ✓ Compacted (sends to LLM): ${JSON.stringify(dictCompacted).length}`);

    // Save extracted data for debugging
    const dataPath = targetFile.replace('.docx', '-data.json');
    fs.writeFileSync(dataPath, JSON.stringify(dict, null, 2));
    console.log(`   ✓ Saved data to: ${dataPath}`);

    console.log('\n🤖 Step 2: Calling LLM to generate HTML...');
    console.log('   ⏳ This may take 20-60 seconds...');

    const cfg = {
      baseUrl: env.LLM_BASE_URL,
      apiKey: env.LLM_API_KEY,
      model: env.LLM_MODEL
    };

    const startTime = Date.now();
    let html = await generateHtmlReport(dict, templateHtml, dict, cfg);
    const llmElapsed = Date.now() - startTime;

    console.log(`   ✓ LLM call completed in ${(llmElapsed / 1000).toFixed(1)}s`);
    console.log(`   ✓ Generated HTML size: ${html.length} chars`);

    // Enhanced data injection
    console.log('\n💾 Step 3: Injecting report data...');
    html = injectReportData(html, dict);
    console.log('   ✓ Data injection complete');

    // Save output
    const outputPath = targetFile.replace('.docx', '-report.html');
    fs.writeFileSync(outputPath, html);
    console.log(`\n✅ Report saved to: ${outputPath}`);

    // Enhanced verification
    console.log('\n🔍 Step 4: Verification...');
    const checks = {
      hasReportDataScript: html.includes('id="report-data"'),
      hasWindowReportData: html.includes('window.reportData'),
      hasDocType: html.includes('<!DOCTYPE html') || html.includes('<html'),
      hasBootstrapScript: html.includes('[Report Data]'),
      dataSize: html.match(/<script\s+id="report-data"[^>]*>([\s\S]*?)<\/script>/i)?.[1]?.length || 0
    };

    console.log(`   ${checks.hasReportDataScript ? '✅' : '❌'} Report data script`);
    console.log(`   ${checks.hasWindowReportData ? '✅' : '❌'} Window.reportData`);
    console.log(`   ${checks.hasDocType ? '✅' : '❌'} HTML structure`);
    console.log(`   ${checks.hasBootstrapScript ? '✅' : '❌'} Bootstrap script`);
    console.log(`   📊 Injected data size: ${checks.dataSize} chars`);

    // Final status
    const allPassed = checks.hasReportDataScript && checks.hasWindowReportData && checks.hasDocType;
    console.log('\n' + (allPassed ? '✅ All checks passed!' : '⚠️ Some checks failed'));

    if (!allPassed) {
      console.log('\n💡 Tip: Run the following command to verify data loading:');
      console.log(`   node scripts/mjs/verify-report.mjs "${outputPath}"`);
    }

  } catch (error) {
    console.error('\n❌ Failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
