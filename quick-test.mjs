#!/usr/bin/env node
/**
 * Quick test for docx extraction and filtering
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

async function extractDocxToDict(fileBuffer, fileName) {
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

function countLeaves(dict) {
  let n = 0;
  for (const v of Object.values(dict)) {
    if (typeof v === "string") n++;
    else n += Object.keys(v).length;
  }
  return n;
}

// Run test
async function runTest() {
  const testDir = path.join(__dirname, 'test');
  const files = fs.readdirSync(testDir).filter(f => f.endsWith('.docx'));
  
  console.log(`\nFound ${files.length} test files:\n`);
  
  for (const file of files) {
    const filePath = path.join(testDir, file);
    console.log(`Testing: ${file}`);
    console.log('-'.repeat(50));
    
    try {
      const fileBuffer = fs.readFileSync(filePath);
      
      console.log('Step 1: Extracting docx...');
      const dict = await extractDocxToDict(fileBuffer, file);
      const originalEntries = Object.keys(dict).length;
      const originalLeaves = countLeaves(dict);
      const originalChars = JSON.stringify(dict).length;
      
      console.log(`  ✓ Entries: ${originalEntries}`);
      console.log(`  ✓ Leaves: ${originalLeaves}`);
      console.log(`  ✓ Chars: ${originalChars}`);
      
      // Save original JSON for inspection
      const jsonPath = filePath.replace('.docx', '-extracted.json');
      fs.writeFileSync(jsonPath, JSON.stringify(dict, null, 2));
      console.log(`  ✓ Saved extracted JSON to: ${path.basename(jsonPath)}`);
      
    } catch (error) {
      console.error(`  ❌ Failed: ${error.message}`);
    }
    
    console.log('');
  }
  
  console.log('=== Test Complete ===');
}

runTest().catch(console.error);
