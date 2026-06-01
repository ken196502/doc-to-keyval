import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { FileText, Languages, Printer, Settings2 } from "lucide-react";
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
import { generateHtmlReport, generateHtmlReportEn, type LLMConfig } from "@/lib/report";
import { translateDictForReport, type TranslateProgress } from "@/lib/translate";

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
  const [enDict, setEnDict] = useState<ExtractedDict | null>(null);
  const [zhReportHtml, setZhReportHtml] = useState<string>("");
  const [enReportHtml, setEnReportHtml] = useState<string>("");
  const [zhView, setZhView] = useState<"preview" | "source">("preview");
  const [enView, setEnView] = useState<"preview" | "source">("preview");
  const [filterStats, setFilterStats] = useState<ReportFilterStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const zhIframeRef = useRef<HTMLIFrameElement | null>(null);
  const enIframeRef = useRef<HTMLIFrameElement | null>(null);

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

  const onFile = async (f: File) => {
    setBusy(true);
    setZhReportHtml("");
    setEnReportHtml("");
    setEnDict(null);
    setFilterStats(null);
    try {
      const result = await extractDocxToDict(f);
      setOriginalDict(result.dict);
      console.log("提取的图片:", result.images);
      setFileName(f.name);
      toast.success(`提取完成：${Object.keys(result.dict).length} 顶层项 / ${countLeaves(result.dict)} 叶子`);
    } catch (e: any) {
      toast.error(e?.message ?? "解析失败");
    } finally {
      setBusy(false);
    }
  };

  const ensureCfg = () => {
    if (!cfg.apiKey || !cfg.baseUrl || !cfg.model) {
      toast.error("请先填写 Base URL / API Key / Model");
      return false;
    }
    return true;
  };

  const onGenerateReport = async () => {
    if (!originalDict || !ensureCfg()) return;
    setBusy(true);
    setBusyLabel("生成中文报告");
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const compacted = filterDictForReport(originalDict);
      setFilterStats(compacted.stats);
      if (compacted.stats.filteredLeaves === 0) {
        throw new Error("精简后没有可用于生成报告的有效内容");
      }
      const result = await generateHtmlReport(compacted.filtered, cfg, compacted.original, ac.signal);
      setZhReportHtml(result);
      toast.success(`HTML 报告生成完成，送模 ${compacted.stats.filteredEntries}/${compacted.stats.originalEntries} 项`);
    } catch (e: any) {
      toast.error(e?.message ?? "生成失败");
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  };

  const onTranslate = async () => {
    if (!originalDict || !ensureCfg()) return;
    setBusy(true);
    setBusyLabel("翻译中");
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const translated = await translateDictForReport(originalDict, cfg, {
        onProgress: (p: TranslateProgress) => {
          if (p.phase === "translate") {
            setBusyLabel(`翻译中 ${p.done}/${p.total}`);
          } else if (p.phase === "merge") {
            setBusyLabel("合并翻译结果");
          } else {
            setBusyLabel("过滤文本");
          }
        },
        signal: ac.signal,
      });
      setEnDict(translated);
      toast.success(`翻译完成：${Object.keys(translated).length} 项`);
    } catch (e: any) {
      if (e.name === "AbortError") return;
      toast.error(e?.message ?? "翻译失败");
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  };

  const onGenerateEnReport = async () => {
    if (!enDict || !ensureCfg()) return;
    setBusy(true);
    setBusyLabel("生成英文报告");
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const compacted = filterDictForReport(enDict);
      setFilterStats(compacted.stats);
      if (compacted.stats.filteredLeaves === 0) {
        throw new Error("精简后没有可用于生成报告的有效内容");
      }
      const result = await generateHtmlReportEn(compacted.filtered, cfg, compacted.original, ac.signal);
      setEnReportHtml(result);
      toast.success(`英文报告生成完成，送模 ${compacted.stats.filteredEntries} 项`);
    } catch (e: any) {
      if (e.name === "AbortError") return;
      toast.error(e?.message ?? "英文报告生成失败");
    } finally {
      setBusy(false);
      setBusyLabel("");
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

  const printIframe = (iframe: HTMLIFrameElement | null) => {
    const w = iframe?.contentWindow;
    if (!w) {
      toast.error("预览尚未加载完成，暂时无法打印");
      return;
    }
    w.focus();
    w.print();
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
        <div className="mx-auto w-full px-6 py-5 flex items-start justify-between gap-4">
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

      <main className="mx-auto w-full px-6 py-8 grid gap-6">
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
                已自动精简送模：{filterStats.rawOriginalChars.toLocaleString()} {"->"} {filterStats.compactedChars.toLocaleString()} {"->"} {filterStats.filteredChars.toLocaleString()} chars
                （压缩 {Math.round((1 - filterStats.compactedChars / filterStats.rawOriginalChars) * 100)}%，过滤 {filterStats.skippedEntries} 项低价值内容）
              </p>
            )}
            <div className="flex gap-2 pt-2">
              <Button onClick={onGenerateReport} disabled={busy || !originalDict}>
                {busy && busyLabel ? `${busyLabel}...` : "生成 HTML"}
              </Button>
              <Button onClick={onTranslate} disabled={busy || !originalDict} variant="secondary">
                {busy && busyLabel ? `${busyLabel}...` : "翻译成英文"}
              </Button>
              {enDict && (
                <Button onClick={onGenerateEnReport} disabled={busy} variant="secondary">
                  {busy && busyLabel ? `${busyLabel}...` : "生成英文 HTML"}
                </Button>
              )}
              {busy && <Button variant="outline" onClick={cancel}>取消</Button>}
              {!cfgReady && <Button variant="ghost" onClick={openCfg}>去配置 LLM</Button>}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2. 报告预览与打印</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3 rounded-md border p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <FileText className="h-4 w-4" />
                  中文报告
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!originalDict}
                    onClick={() => originalDict && downloadJson(originalDict, "original.json")}
                  >
                    原始JSON
                  </Button>
                  <Button size="sm" variant={zhView === "preview" ? "default" : "outline"} onClick={() => setZhView("preview")}>预览</Button>
                  <Button size="sm" variant={zhView === "source" ? "default" : "outline"} onClick={() => setZhView("source")}>源码</Button>
                  <Button size="sm" variant="outline" disabled={!zhReportHtml} onClick={() => printIframe(zhIframeRef.current)}>
                    <Printer className="mr-1 h-4 w-4" />
                    打印
                  </Button>
                  <Button size="sm" variant="outline" disabled={!zhReportHtml} onClick={() => downloadHtml(zhReportHtml, "report-zh.html")}>
                    下载
                  </Button>
                </div>
              </div>
              {zhView === "preview" ? (
                <div className="overflow-hidden rounded-md border bg-muted/20">
                  <iframe
                    ref={zhIframeRef}
                    title="中文报告预览"
                    className="h-[1000px] w-full bg-white"
                    srcDoc={zhReportHtml || "<!doctype html><html><body style='font-family:system-ui;padding:24px;color:#666'>生成中文报告后在这里预览。</body></html>"}
                  />
                </div>
              ) : (
                <Textarea
                  readOnly
                  className="h-[1000px] font-mono text-xs"
                  value={zhReportHtml}
                  placeholder="生成中文报告后显示 HTML 源码..."
                />
              )}
            </div>

            <div className="space-y-3 rounded-md border p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Languages className="h-4 w-4" />
                  英文报告
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!originalDict}
                    onClick={() => originalDict && downloadJson(originalDict, "original.json")}
                  >
                    原始JSON
                  </Button>
                  <Button size="sm" variant={enView === "preview" ? "default" : "outline"} onClick={() => setEnView("preview")}>预览</Button>
                  <Button size="sm" variant={enView === "source" ? "default" : "outline"} onClick={() => setEnView("source")}>源码</Button>
                  <Button size="sm" variant="outline" disabled={!enReportHtml} onClick={() => printIframe(enIframeRef.current)}>
                    <Printer className="mr-1 h-4 w-4" />
                    打印
                  </Button>
                  <Button size="sm" variant="outline" disabled={!enReportHtml} onClick={() => downloadHtml(enReportHtml, "report-en.html")}>
                    下载
                  </Button>
                </div>
              </div>
              {enView === "preview" ? (
                <div className="overflow-hidden rounded-md border bg-muted/20">
                  <iframe
                    ref={enIframeRef}
                    title="英文报告预览"
                    className="h-[1000px] w-full bg-white"
                    srcDoc={enReportHtml || "<!doctype html><html><body style='font-family:system-ui;padding:24px;color:#666'>生成英文报告后在这里预览。</body></html>"}
                  />
                </div>
              ) : (
                <Textarea
                  readOnly
                  className="h-[1000px] font-mono text-xs"
                  value={enReportHtml}
                  placeholder="生成英文报告后显示 HTML 源码..."
                />
              )}
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
