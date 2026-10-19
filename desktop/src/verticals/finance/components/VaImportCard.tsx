import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { backend } from "@/lib/backend";
import { usePrivacyMode } from "@/hooks/usePrivacyMode";
import { maskPrivateText } from "@/lib/privacy";
import { writtenText, type VaGroup, type VaImportInfo, type VaImportPreview, type VaImportResult } from "@/lib/vaImport";

const INPUT = "w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm";
const BUTTON = "inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 hover:bg-muted disabled:opacity-50";
/** 列表太长时先显示几条,其余折起来 */
const SHOW = 6;

/** 预览、结果、报错里的说明来自旧版的交易记录(「卖出 N 股,超过…」):隐私模式下按措辞遮掉股数和金额 */
const masker = (hide: boolean): ((s: string) => string) => (hide ? maskPrivateText : (s) => s);

function Folded({ items: raw, title, tone, hide }: { items: string[]; title: string; tone: string; hide: boolean }) {
  const items = raw.map(masker(hide));
  if (!items.length) return null;
  return (
    <div className="mt-2 text-xs">
      <p className={`font-semibold ${tone}`}>{title}</p>
      <ul className="mt-1 space-y-0.5 text-muted-foreground">{items.slice(0, SHOW).map((x, i) => <li key={i}>· {x}</li>)}</ul>
      {items.length > SHOW && (
        <details className="mt-0.5">
          <summary className="cursor-pointer text-primary">还有 {items.length - SHOW} 条</summary>
          <ul className="mt-1 space-y-0.5 text-muted-foreground">{items.slice(SHOW).map((x, i) => <li key={i}>· {x}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

function GroupRows({ g, hide }: { g: VaGroup; hide: boolean }) {
  const mask = masker(hide);
  const more = g.skipped.length > 0 || g.notes.length > 0;
  return (
    <>
      <tr className="border-t border-border/40">
        <td className="whitespace-nowrap py-1.5 pr-3 font-medium">{g.label}</td>
        <td className="py-1.5 pr-3 tabular-nums">{g.found}</td>
        <td className="py-1.5 pr-3 tabular-nums font-semibold text-primary">{g.add}</td>
        <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">{g.already}</td>
        <td className={`py-1.5 tabular-nums ${g.skipped.length ? "font-semibold text-warning" : "text-muted-foreground"}`}>{g.skipped.length}</td>
      </tr>
      {more && (
        <tr>
          <td colSpan={5} className="pb-1.5 text-muted-foreground">
            {g.skipped.length > 0 && (
              <details>
                <summary className="cursor-pointer text-warning">跳过的 {g.skipped.length} 项和原因</summary>
                <ul className="mt-1 space-y-0.5">{g.skipped.map((s, i) => <li key={i}>· {mask(`${s.what}:${s.why}`)}</li>)}</ul>
              </details>
            )}
            {g.notes.map((n, i) => <p key={i} className="mt-0.5 text-muted-foreground/80">{mask(n)}</p>)}
          </td>
        </tr>
      )}
    </>
  );
}

/** 预览:每类找到多少、要新导多少、以前导过多少、跳过多少(带原因);导入后对不上的;旧版里不导的 */
export function VaImportPreviewView({ p, hide = false }: { p: VaImportPreview; hide?: boolean }) {
  return (
    <div className="mt-3">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-muted-foreground">
            <tr className="whitespace-nowrap"><th className="pb-1 pr-3 font-normal">内容</th><th className="pb-1 pr-3 font-normal">找到</th><th className="pb-1 pr-3 font-normal">要导入</th><th className="pb-1 pr-3 font-normal">以前导过</th><th className="pb-1 font-normal">跳过</th></tr>
          </thead>
          <tbody>{p.groups.map((g) => <GroupRows key={g.key} g={g} hide={hide} />)}</tbody>
        </table>
      </div>
      <Folded items={p.warnings} title="导入后交易日志里会对不上的(按新版规则重算):" tone="text-warning" hide={hide} />
      <Folded items={p.not_imported.map((x) => `${x.label} ${x.count} 个:${x.why}`)} title="旧版里这些不导入:" tone="text-muted-foreground" hide={hide} />
    </div>
  );
}

/** 导入结果:写进去了什么、备份在哪、哪些没写成 */
export function VaImportResultView({ r, hide = false }: { r: VaImportResult; hide?: boolean }) {
  const text = writtenText(r.written);
  return (
    <div role="status" className="mt-3 rounded-lg border border-border/60 bg-muted/10 p-3 text-xs">
      <p className="font-semibold">{text ? `导入了:${text}。` : "这次没有写进任何东西。"}</p>
      {r.backup && <p className="mt-1 text-muted-foreground">导入前的原样文件备份在数据目录下的 <span className="font-mono">{r.backup}</span>,里面的说明写了怎么恢复。</p>}
      <Folded items={r.failed.map((f) => `${f.what}:${f.why}`)} title="这些没写成(再导一次会补上,已写的不会重复):" tone="text-destructive" hide={hide} />
    </div>
  );
}

/**
 * 设置页「从旧版导入」:用过 Python 版 Vibe AStock 的,把它存在本机的交易日志、模式卡、AI 复盘、明日验证、
 * 盘中快照、个股深挖搬进来。先预览不写;确认后先备份再写;旧版的文件只读不改。
 * 个人交易数据只在本机接口里走,这张卡片不登记 AI 页面上下文。
 */
export function VaImportCard() {
  const { on: hide } = usePrivacyMode();
  const [info, setInfo] = useState<VaImportInfo | null>(null);
  const [dir, setDir] = useState("");
  const [preview, setPreview] = useState<VaImportPreview | null>(null);
  const [result, setResult] = useState<VaImportResult | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<"" | "preview" | "import">("");
  useEffect(() => {
    backend.vaImportInfo().then((x) => { setInfo(x); setDir((d) => d || x.default_dir); })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  const look = async () => {
    setBusy("preview"); setErr(""); setPreview(null); setResult(null);
    try { setPreview(await backend.vaImportPreview(dir.trim())); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(""); }
  };
  const run = async () => {
    if (!preview) return;
    setBusy("import"); setErr("");
    try { setResult(await backend.vaImportRun(preview.dir)); setPreview(null); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(""); }
  };
  return (
    <GlassCard>
      <h3 className="mb-1 font-semibold">从旧版导入</h3>
      <p className="mb-3 text-xs text-muted-foreground">
        用过旧版 Vibe AStock（Python 版）的，可以把它存在这台电脑上的交易记录、模式卡、AI 复盘、明日验证条件、盘中快照和个股深挖搬进来。
        先预览，不会写；确认后才导入，导入前自动备份。旧版的文件只读、不改。可以重复导，以前导过的会跳过。
      </p>
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (dir.trim()) void look(); }}>
        <input className={`${INPUT} min-w-[16rem] flex-1 font-mono`} value={dir} disabled={!!busy}
          onChange={(e) => { setDir(e.target.value); setPreview(null); setResult(null); }}
          placeholder="旧版数据目录，例如 ~/.duanxian-agents" aria-label="旧版数据目录" autoComplete="off" spellCheck={false} maxLength={1000} />
        <button type="submit" disabled={!!busy || !dir.trim()} className={BUTTON}>
          {busy === "preview" && <LoaderCircle className="h-3 w-3 animate-spin" />}预览
        </button>
      </form>
      {info && !info.exists && !preview && !result && dir.trim() === info.default_dir && (
        <p className="mt-2 text-xs text-muted-foreground">旧版默认的数据目录在这台电脑上没找到；没用过旧版就不用管，装在别处的话把路径填进上面。</p>
      )}
      {err && <p role="alert" className="mt-2 text-xs text-destructive">{masker(hide)(err)}</p>}
      {preview && <VaImportPreviewView p={preview} hide={hide} />}
      {preview && (preview.total > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void run()} disabled={!!busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {busy === "import" && <LoaderCircle className="h-3 w-3 animate-spin" />}导入这 {preview.total} 项
          </button>
          <span className="text-xs text-muted-foreground">先备份涉及的台账文件再写。</span>
        </div>
      ) : <p role="status" className="mt-3 text-xs text-muted-foreground">没有要导入的：能导的以前都导过了，或者都在上面列的跳过原因里。</p>)}
      {result && <VaImportResultView r={result} hide={hide} />}
    </GlassCard>
  );
}
