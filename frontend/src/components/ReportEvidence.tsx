import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { GroundedFinding, GroundedReport, ReportEvidence } from "@/lib/report-grounding";
import { remarkStockLinks } from "@/lib/stock-link";

/** Cited records plus the inputs of cited comparisons, order preserved. */
function citedRecords(finding: GroundedFinding, report: GroundedReport): ReportEvidence[] {
  const cited = report.records.filter(r => finding.citations.includes(r.id));
  const inputIds = cited.flatMap(r => r.inputs || []);
  return [...cited, ...report.records.filter(r => inputIds.includes(r.id) && !cited.some(c => c.id === r.id))];
}

function shownNumber(record: ReportEvidence): boolean {
  if (record.kind === "comparison") return true;
  return record.kind === "metric" && !record.text.endsWith("未获取");
}

function numberValue(record: ReportEvidence): string {
  if (record.kind === "metric" && record.text.startsWith(record.label)) {
    return record.text.slice(record.label.length).replace(/^[：:]\s*/, "");
  }
  return record.text;
}

/** Host-computed readings cited by one finding, shown next to the prose. */
function KeyNumbers({ records }: { records: ReportEvidence[] }) {
  if (!records.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5" aria-label="本段引用的程序读数">
      {records.map(record => (
        <span key={record.id} className="rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
          <b className="font-semibold text-foreground">{record.label}</b>
          <span className="mx-1 text-border">|</span>
          {numberValue(record)}
        </span>
      ))}
    </div>
  );
}

export function EvidenceReferences({ finding, report }: { finding?: GroundedFinding; report?: GroundedReport }) {
  if (!finding || !report || !Array.isArray(finding.citations) || !Array.isArray(report.records)) return null;
  const cited = report.records.filter(r => finding.citations.includes(r.id));
  if (!cited.length) return <p className="text-xs text-warning">本段依据未能读取，请重新生成后核对。</p>;
  const records = citedRecords(finding, report);
  const numbers = records.filter(shownNumber);
  const excerptGroups = new Map<string, ReportEvidence[]>();
  for (const record of records.filter(r => r.kind === "input_excerpt")) {
    const list = excerptGroups.get(record.label) || [];
    list.push(record);
    excerptGroups.set(record.label, list);
  }
  return (
    <details className="mt-2 text-xs" data-report-evidence>
      <summary className="cursor-pointer rounded text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
        查看依据（{cited.length}）
      </summary>
      <div className="mt-2 space-y-3">
        {numbers.length > 0 && (
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <p className="mb-2 font-semibold">程序读数</p>
            <ul className="space-y-2">
              {numbers.map(record => (
                <li key={record.id} className="break-words">
                  <span className="text-muted-foreground">{record.label} · {record.target_date}</span>
                  <p>{record.text}</p>
                  <p className="mt-0.5 text-muted-foreground">{record.note}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
        {[...excerptGroups].map(([label, list]) => {
          const contexts = [...new Set(list.map(r => r.context || "").filter(c => c))];
          return (
            <div key={label} className="rounded-lg border border-border bg-muted/30 p-3">
              <p className="font-semibold">{label} · {list[0].target_date}</p>
              <p className="mt-1 text-muted-foreground">本次输入摘录（日期以原文为准）</p>
              <ul className="mt-2 list-disc space-y-1 pl-4">
                {list.map(record => <li key={record.id} className="break-words">{record.text}</li>)}
              </ul>
              {contexts.length === 1
                ? <p className="mt-2 break-words text-muted-foreground">{contexts[0]}</p>
                : list.map(record => record.context && record.context !== record.text
                    ? <p key={record.id} className="mt-2 break-words text-muted-foreground">{record.context}</p> : null)}
            </div>
          );
        })}
        <p className="text-muted-foreground">{report.note}</p>
      </div>
    </details>
  );
}

export function GroundedAnalysis({ report }: { report?: GroundedReport }) {
  if (!report || report.version !== 1 || !Array.isArray(report.sections)) return null;
  return (
    <section className="space-y-3" aria-label="分项复盘与依据">
      <h2 className="text-sm font-bold">分项复盘与依据</h2>
      <p className="text-xs text-muted-foreground">每段解释旁的标签直接列出本段引用的程序读数；展开「查看依据」可核对原始输入片段。解释文字不含数字，数值以程序读数为准。</p>
      <div className="grid gap-4 lg:grid-cols-2">
        {report.sections.map(section => (
          <article key={section.key} className="glass rounded-2xl p-5">
            <h3 className="mb-3 font-semibold">{section.title}</h3>
            {section.findings.map((finding, i) => (
              <div key={i} className="mb-4 border-l-2 border-primary/25 pl-3 text-sm leading-relaxed">
                <div className="prose prose-sm max-w-none dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm, remarkStockLinks]}>{finding.text}</ReactMarkdown></div>
                <KeyNumbers records={citedRecords(finding, report).filter(shownNumber)} />
                <EvidenceReferences finding={finding} report={report} />
              </div>
            ))}
          </article>
        ))}
      </div>
    </section>
  );
}
