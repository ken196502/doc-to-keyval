import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { extractDocxToDict, countLeaves, type ExtractedDict } from "@/lib/docx-extract";
import { filterDictForReport, type ReportFilterStats } from "@/lib/report-filter";
import { generateHtmlReport, type LLMConfig } from "@/lib/report";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "研报结构化提取与 HTML 报告生成" },
      { name: "description", content: "上传研报 docx，结构化为 KV JSON，并结合 template 由 LLM 生成可直接运行的 HTML 报告。" },
    ],
  }),
  component: Index,
});

const LS_KEY = "llm_cfg_v1";

function Index() {
  const [fileName, setFileName] = useState<string>("");
  const [originalDict, setOriginalDict] = useState<ExtractedDict | null>(null);
  const [reportHtml, setReportHtml] = useState<string>("");
  const [filterStats, setFilterStats] = useState<ReportFilterStats | null>(null);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const [cfg, setCfg] = useState<LLMConfig>({
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini",
  });
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) setCfg(JSON.parse(raw));
    } catch {}
    setHydrated(true);
  }, []);


  const saveCfg = (next: LLMConfig) => {
    setCfg(next);
    try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch {}
  };

  const htmlPreview = useMemo(() => reportHtml, [reportHtml]);

  const onFile = async (f: File) => {
    setBusy(true);
    setReportHtml("");
    setFilterStats(null);
    try {
      const dict = await extractDocxToDict(f);
      setOriginalDict(dict);
      setFileName(f.name);
      toast.success(`提取完成：${Object.keys(dict).length} 顶层项 / ${countLeaves(dict)} 叶子`);
    } catch (e: any) {
      toast.error(e?.message ?? "解析失败");
    } finally {
      setBusy(false);
    }
  };

  const onGenerateReport = async () => {
    if (!originalDict) return;
    if (!cfg.apiKey || !cfg.baseUrl || !cfg.model) {
      toast.error("请先填写 Base URL / API Key / Model");
      return;
    }
    setBusy(true);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const compacted = filterDictForReport(originalDict);
      setFilterStats(compacted.stats);
      if (compacted.stats.filteredLeaves === 0) {
        throw new Error("精简后没有可用于生成报告的有效内容");
      }
      const result = await generateHtmlReport(compacted.filtered, cfg, originalDict, ac.signal);
      setReportHtml(result);
      toast.success(`HTML 报告生成完成，送模 ${compacted.stats.filteredEntries}/${compacted.stats.originalEntries} 项`);
    } catch (e: any) {
      toast.error(e?.message ?? "生成失败");
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    setBusy(false);
    toast.message("已取消");
  };

  const downloadJson = (data: unknown, name: string) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  };

  const downloadHtml = (html: string, name: string) => {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  };

  const [cfgOpen, setCfgOpen] = useState(false);
  const [draftCfg, setDraftCfg] = useState<LLMConfig>(cfg);
  const openCfg = () => { setDraftCfg(cfg); setCfgOpen(true); };
  const confirmCfg = () => { saveCfg(draftCfg); setCfgOpen(false); toast.success("已保存到本地"); };

  const cfgReady = hydrated && !!(cfg.baseUrl && cfg.apiKey && cfg.model);


  return (
    <div className="min-h-screen bg-background text-foreground">
      <Toaster richColors position="top-right" />
      <header className="border-b">
        <div className="mx-auto max-w-6xl px-6 py-5 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">研报结构化提取与 HTML 报告生成</h1>
            <p className="text-sm text-muted-foreground mt-1">
              上传研报 <code>.docx</code> → 提取结构化 JSON → 让 LLM 参考 <code>@template</code> 和原始 key 生成可独立运行的 HTML 精美报告。
            </p>
          </div>
          <Dialog open={cfgOpen} onOpenChange={setCfgOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" onClick={openCfg}>
                <Settings2 className="h-4 w-4 mr-2" />
                LLM 配置
                {!cfgReady && <Badge variant="destructive" className="ml-2">未配置</Badge>}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>LLM 配置</DialogTitle>
                <DialogDescription>OpenAI 兼容接口。仅保存在浏览器本地存储（localStorage）。</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="baseUrl">Base URL</Label>
                  <Input id="baseUrl" placeholder="https://api.openai.com/v1" value={draftCfg.baseUrl}
                    onChange={(e) => setDraftCfg({ ...draftCfg, baseUrl: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="apiKey">API Key</Label>
                  <Input id="apiKey" type="password" placeholder="sk-..." value={draftCfg.apiKey}
                    onChange={(e) => setDraftCfg({ ...draftCfg, apiKey: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="model">Model</Label>
                  <Input id="model" placeholder="gpt-4o-mini" value={draftCfg.model}
                    onChange={(e) => setDraftCfg({ ...draftCfg, model: e.target.value })} />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCfgOpen(false)}>取消</Button>
                <Button onClick={confirmCfg}>保存</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8 grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>1. 上传 docx 并生成报告</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input
              type="file"
              accept=".docx"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
              }}
            />
            {fileName && <p className="text-sm text-muted-foreground">已选择：{fileName}</p>}
            {originalDict && (
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="secondary">顶层项 {Object.keys(originalDict).length}</Badge>
                <Badge variant="secondary">总叶子 {countLeaves(originalDict)}</Badge>
                <Badge variant="outline">模板来源 template.html</Badge>
                {filterStats && <Badge>送模项 {filterStats.filteredEntries}</Badge>}
                {filterStats && <Badge variant="outline">过滤项 {filterStats.skippedEntries}</Badge>}
              </div>
            )}
            {filterStats && (
              <p className="text-xs text-muted-foreground">
                已自动精简送模：{filterStats.originalChars} {"->"} {filterStats.filteredChars} chars，优先保留标题、结论、财务、估值、风险等高价值内容。
              </p>
            )}
            <div className="flex gap-2 pt-2">
              <Button onClick={onGenerateReport} disabled={busy || !originalDict}>
                {busy ? "生成中..." : "生成 HTML 报告"}
              </Button>
              {busy && <Button variant="outline" onClick={cancel}>取消</Button>}
              {!cfgReady && <Button variant="ghost" onClick={openCfg}>去配置 LLM</Button>}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>2. 原始 JSON</CardTitle>
            {originalDict && (
              <Button size="sm" variant="outline" onClick={() => downloadJson(originalDict, "original.json")}>
                下载
              </Button>
            )}
          </CardHeader>
          <CardContent>
            <Textarea
              readOnly
              className="font-mono text-xs h-72"
              value={originalDict ? JSON.stringify(originalDict, null, 2) : ""}
              placeholder="上传 docx 后显示提取结果..."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>3. HTML 报告预览</CardTitle>
            {reportHtml && (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => downloadHtml(reportHtml, "report.html")}>
                  下载 HTML
                </Button>
              </div>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-hidden rounded-lg border bg-muted/20">
              <iframe
                title="HTML 报告预览"
                className="h-[720px] w-full bg-white"
                srcDoc={htmlPreview || "<!doctype html><html><body style='font-family:system-ui;padding:24px;color:#666'>生成完成后在这里预览 HTML 报告。</body></html>"}
              />
            </div>
            <Textarea
              readOnly
              className="font-mono text-xs h-72"
              value={reportHtml}
              placeholder="生成完成后显示 HTML 源码..."
            />
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
