import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
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
import { extractDocxToDict, splitDict, type ExtractedDict } from "@/lib/docx-extract";
import { translateDict, type LLMConfig } from "@/lib/translate";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "研报结构化提取与翻译" },
      { name: "description", content: "上传中文研报 docx，结构化为 KV 字典，按需调用 LLM 翻译为英文。" },
    ],
  }),
  component: Index,
});

const LS_KEY = "llm_cfg_v1";

function Index() {
  const [fileName, setFileName] = useState<string>("");
  const [originalDict, setOriginalDict] = useState<ExtractedDict | null>(null);
  const [translatedDict, setTranslatedDict] = useState<ExtractedDict | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [cfg, setCfg] = useState<LLMConfig>(() => {
    if (typeof window === "undefined") return { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini" };
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
    return { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini" };
  });

  const saveCfg = (next: LLMConfig) => {
    setCfg(next);
    try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch {}
  };

  const split = useMemo(() => (originalDict ? splitDict(originalDict) : null), [originalDict]);

  const mergedDict = useMemo<ExtractedDict | null>(() => {
    if (!originalDict) return null;
    if (!translatedDict || !split) return null;
    const out: ExtractedDict = {};
    for (const k of Object.keys(originalDict)) {
      out[k] = translatedDict[k] ?? split.skipped[k] ?? originalDict[k];
    }
    return out;
  }, [originalDict, translatedDict, split]);

  const onFile = async (f: File) => {
    setBusy(true);
    setTranslatedDict(null);
    setProgress(null);
    try {
      const dict = await extractDocxToDict(f);
      setOriginalDict(dict);
      setFileName(f.name);
      toast.success(`提取完成：${Object.keys(dict).length} 项`);
    } catch (e: any) {
      toast.error(e?.message ?? "解析失败");
    } finally {
      setBusy(false);
    }
  };

  const onTranslate = async () => {
    if (!split) return;
    if (!cfg.apiKey || !cfg.baseUrl || !cfg.model) {
      toast.error("请先填写 Base URL / API Key / Model");
      return;
    }
    const keys = Object.keys(split.toTranslate);
    if (keys.length === 0) {
      toast.message("没有需要翻译的文本内容");
      setTranslatedDict({});
      return;
    }
    setBusy(true);
    setProgress({ done: 0, total: 1 });
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const result = await translateDict(split.toTranslate, cfg, {
        signal: ac.signal,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setTranslatedDict(result);
      toast.success(`翻译完成：${Object.keys(result).length} / ${keys.length}`);
    } catch (e: any) {
      toast.error(e?.message ?? "翻译失败");
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    setBusy(false);
    toast.message("已取消");
  };

  const download = (data: unknown, name: string) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  };

  const [cfgOpen, setCfgOpen] = useState(false);
  const [draftCfg, setDraftCfg] = useState<LLMConfig>(cfg);
  const openCfg = () => { setDraftCfg(cfg); setCfgOpen(true); };
  const confirmCfg = () => { saveCfg(draftCfg); setCfgOpen(false); toast.success("已保存到本地"); };

  const cfgReady = !!(cfg.baseUrl && cfg.apiKey && cfg.model);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Toaster richColors position="top-right" />
      <header className="border-b">
        <div className="mx-auto max-w-6xl px-6 py-5 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">研报结构化提取与翻译</h1>
            <p className="text-sm text-muted-foreground mt-1">
              上传中文研报（.docx）→ 结构化为 <code>p-n</code> / <code>td-n</code> KV → 仅翻译文本字段，保留数字 / 图片 / Base64。
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
            <CardTitle>1. 上传 docx 并翻译</CardTitle>
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
            {originalDict && split && (
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="secondary">总计 {Object.keys(originalDict).length}</Badge>
                <Badge>待翻译 {Object.keys(split.toTranslate).length}</Badge>
                <Badge variant="outline">跳过 {Object.keys(split.skipped).length}</Badge>
              </div>
            )}
            <div className="flex gap-2 pt-2">
              <Button onClick={onTranslate} disabled={busy || !originalDict}>
                {busy && progress ? `翻译中 ${progress.done}/${progress.total}` : "开始翻译"}
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
              <Button size="sm" variant="outline" onClick={() => download(originalDict, "original.json")}>
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
            <CardTitle>3. 翻译合并结果</CardTitle>
            {mergedDict && (
              <Button size="sm" variant="outline" onClick={() => download(mergedDict, "translated.json")}>
                下载
              </Button>
            )}
          </CardHeader>
          <CardContent>
            <Textarea
              readOnly
              className="font-mono text-xs h-72"
              value={mergedDict ? JSON.stringify(mergedDict, null, 2) : ""}
              placeholder="翻译完成后显示合并结果（保留原始数字/图片）..."
            />
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
