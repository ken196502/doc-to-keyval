#!/usr/bin/env node
/**
 * 验证生成的 HTML 报告是否正确加载了 JSON 数据
 * Usage: node scripts/mjs/verify-report.mjs <html-file>
 */

import fs from 'fs';
import path from 'path';

const targetFile = process.argv[2];

if (!targetFile || !fs.existsSync(targetFile)) {
  console.error("Usage: node scripts/mjs/verify-report.mjs <html-file>");
  console.error("Example: node scripts/mjs/verify-report.mjs report.html");
  process.exit(1);
}

console.log('=== 验证报告数据加载 ===');
console.log('文件:', targetFile);
console.log('');

const html = fs.readFileSync(targetFile, 'utf-8');

// 检查 1: 是否存在 report-data script 标签
const dataScriptMatch = html.match(/<script\s+id="report-data"[^>]*>([\s\S]*?)<\/script>/i);
if (!dataScriptMatch) {
  console.error('❌ 未找到 <script id="report-data"> 标签');
  console.error('   数据可能未正确注入到 HTML 中');
  process.exit(1);
}
console.log('✅ 找到 <script id="report-data"> 标签');

// 检查 2: script 标签内容是否为空
const jsonContent = dataScriptMatch[1].trim();
if (!jsonContent) {
  console.error('❌ <script id="report-data"> 标签内容为空');
  console.error('   数据注入可能失败');
  process.exit(1);
}
console.log('✅ script 标签内容非空');
console.log(`   数据大小: ${jsonContent.length} 字符`);

// 检查 3: JSON 是否可解析
try {
  const parsed = JSON.parse(jsonContent);
  const keys = Object.keys(parsed);
  console.log('✅ JSON 数据解析成功');
  console.log(`   数据条目数: ${keys.length}`);
  
  // 显示前 5 个键作为示例
  if (keys.length > 0) {
    console.log('   数据键示例:');
    keys.slice(0, 5).forEach(key => {
      const value = parsed[key];
      const preview = typeof value === 'string' 
        ? value.substring(0, 50) + (value.length > 50 ? '...' : '')
        : JSON.stringify(value).substring(0, 50);
      console.log(`     - ${key}: ${preview}`);
    });
    if (keys.length > 5) {
      console.log(`     ... 还有 ${keys.length - 5} 个条目`);
    }
  }
} catch (e) {
  console.error('❌ JSON 解析失败:', e.message);
  console.error('   数据内容可能已损坏');
  console.error('   原始内容前 200 字符:', jsonContent.substring(0, 200));
  process.exit(1);
}

// 检查 4: 是否存在 window.reportData 的引用
if (html.includes('window.reportData') || html.includes('reportData')) {
  console.log('✅ HTML 中包含 reportData 的引用');
} else {
  console.warn('⚠️ HTML 中未找到 reportData 的引用');
  console.warn('   页面可能未使用注入的数据');
}

console.log('');
console.log('=== 验证完成 ===');
console.log('✅ 报告数据加载正常');
