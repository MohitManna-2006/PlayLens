"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { AnalystPane } from "@/components/analyst/AnalystPane";
import { useAnalystStore } from "@/components/shell/Providers";
import { Identifier } from "@/components/ui/Identifier";
import { MenuButton } from "@/components/ui/Menu";
import { StatusState } from "@/components/ui/StatusState";
import { useAnalystState } from "@/lib/analyst/store";
import type { EvaluationReport as Report, ModelInfo } from "@/lib/contracts";
import { errorMessage, getClient } from "@/lib/datasource";
import { fixed, percent } from "@/lib/format";
import { atLeast, useBreakpoint } from "@/lib/hooks/useBreakpoint";
import { ChartFrame, fmt, LineChart, SeriesTable, type ChartSeries } from "./ChartFrame";

const PENDING = "Pending evaluation";

const noopSubscribe = () => () => {};

function kindText(m: ModelInfo) {
  return m.kind === "learned" ? "Learned model" : m.kind === "baseline" ? "Baseline" : "Development mock";
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="border-t border-border pt-8 first:border-0 first:pt-0">
      <h2 id={id} className="text-section font-semibold">
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Pending({ children }: { children?: ReactNode }) {
  return (
    <StatusState kind="unavailable" compact title={PENDING}>
      {children}
    </StatusState>
  );
}

/**
 * Evaluation report (§11): identity first, then scope before metrics, then
 * six ordered sections. Unavailable results are labeled, never filled in.
 */
export function EvaluationReport() {
  const client = getClient();
  const params = useSearchParams();
  const router = useRouter();
  const bp = useBreakpoint();
  const analyst = useAnalystStore();
  const { open: analystOpen } = useAnalystState(analyst);
  const models = useQuery({ queryKey: ["models"], queryFn: ({ signal }) => client.listModels(signal) });
  // The top bar may fill the shared model cache before this boundary hydrates; render
  // the server's (empty) state first so hydration matches, then the cached data.
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const modelList = hydrated ? models.data : undefined;
  const served = modelList?.find((m) => m.task === "trajectory" && m.served) ?? modelList?.[0];
  const version = params.get("model") ?? served?.model_version ?? null;
  const model = modelList?.find((m) => m.model_version === version) ?? null;
  const report = useQuery({
    queryKey: ["evaluation", version],
    queryFn: ({ signal }) => client.getEvaluation(version!, signal),
    enabled: !!version,
  });

  useEffect(
    () => analyst.bindWorkspace({ getContext: () => ({ kind: "evaluation", model_version: version }), tools: { client } }),
    [analyst, version, client],
  );

  const r = report.data;
  const side = analystOpen && atLeast(bp, "xl");

  return (
    <div
      className={`mx-auto px-[var(--page-pad)] pb-16 ${side ? "grid max-w-[calc(1280px+var(--analyst-w)+var(--gap)+2*var(--page-pad))] gap-[var(--gap)]" : "max-w-[calc(1280px+2*var(--page-pad))]"}`}
      style={side ? { gridTemplateColumns: "minmax(0,1fr) var(--analyst-w)" } : undefined}
    >
      <div className="min-w-0">
        <header className="flex flex-wrap items-end justify-between gap-4 pt-6 pb-2">
          <h1 className="text-page font-semibold">Evaluation</h1>
          {modelList && (
            <MenuButton
              label="Model version"
              placement="bottom-end"
              width={320}
              triggerContent={<span className="num">Model {version ?? "—"}</span>}
              groups={(["trajectory", "retrieval", "counterfactual"] as const).map((task) => ({
                label: task === "trajectory" ? "Trajectory" : task === "retrieval" ? "Retrieval" : "Counterfactual",
                items: modelList
                  .filter((m) => m.task === task)
                  .map((m) => ({
                    value: m.model_version,
                    label: m.model_version,
                    hint: `${kindText(m)}${m.served ? " · served" : ""} · ${m.evaluation_status === "evaluated" ? "evaluated" : m.evaluation_status === "pending" ? "evaluation pending" : "not evaluated"}`,
                    checked: m.model_version === version,
                  })),
              }))}
              onSelect={(i) => router.replace(`/evaluation?model=${encodeURIComponent(i.value)}`, { scroll: false })}
            />
          )}
        </header>
        <p className="num flex flex-wrap gap-x-4 gap-y-1 text-meta text-fg-2">
          <span className="font-sans">{model ? `${model.name} · ${kindText(model)}` : modelList?.length === 0 ? "No model" : "Loading model"}</span>
          <span>task {r?.task ?? "—"}</span>
          <span>dataset {r?.dataset_version ?? "—"}</span>
          <span>split {r?.split ?? "—"}</span>
          <span>run {r?.run_time ?? "—"}</span>
          {r?.artifact_uri ? <Identifier value={r.artifact_uri} label="Artifact" /> : <span>artifact —</span>}
        </p>
        {r && r.status !== "complete" && (
          <div className="mt-4 max-w-[680px] border-l-2 border-control pl-3">
            <p className="text-body-2 font-medium text-fg">{r.status === "pending" ? PENDING : "Evaluation unavailable"}</p>
            <p className="text-body-2 text-fg-2">{r.status_reason}</p>
          </div>
        )}

        {analystOpen && !side && <AnalystPane variant={bp === "xs" ? "sheet" : "inline"} className="mt-6" />}

        {models.isError ? (
          <StatusState kind="error" title="Model registry unavailable" className="mt-8" action={<button type="button" className="btn" onClick={() => models.refetch()}>Retry</button>}>
            {errorMessage(models.error)}
          </StatusState>
        ) : modelList && modelList.length === 0 ? (
          <StatusState kind="unavailable" title="No models are registered yet" className="mt-8">
            The model registry is empty: nothing has been trained or evaluated, so this page reports no metrics. Tracking replay and
            play metadata do not depend on a model.
          </StatusState>
        ) : report.isError ? (
          <StatusState kind="error" title="Report unavailable" className="mt-8" action={<button type="button" className="btn" onClick={() => report.refetch()}>Retry</button>}>
            {errorMessage(report.error)}
          </StatusState>
        ) : (
          <div className="mt-12 space-y-12">
            <ScopeSection report={r} model={model} loading={report.isPending} />
            <TrajectorySection report={r} model={model} />
            <ErrorUncertaintySection report={r} model={model} />
            <RetrievalSection report={r} model={model} />
            <SystemSection report={r} />
            <SlicesSection report={r} />
          </div>
        )}
      </div>
      {side && (
        <div className="pt-4">
          <AnalystPane variant="side" />
        </div>
      )}
    </div>
  );
}

function ScopeSection({ report: r, model, loading }: { report: Report | undefined; model: ModelInfo | null; loading: boolean }) {
  return (
    <Section id="scope" title="Scope and evidence">
      <div className="max-w-[680px] space-y-4 text-body text-fg-2">
        {loading ? (
          <div className="skeleton h-24 w-full" />
        ) : r?.scope ? (
          <>
            <p>
              <span className="text-fg">Predicted:</span> {r.scope.predicted}. <span className="text-fg">Observation window:</span> {r.scope.observation_window}.{" "}
              <span className="text-fg">Horizon:</span> {r.scope.horizon}.
            </p>
            <p>
              <span className="text-fg">Population:</span> {r.scope.population}. <span className="text-fg">Unit:</span> {r.scope.sample_unit},{" "}
              <span className="num text-fg">n = {r.scope.sample_count}</span>. <span className="text-fg">Exclusions:</span> {r.scope.exclusions}.
            </p>
            <p>
              <span className="text-fg">Split policy:</span> {r.scope.split_policy}
            </p>
            <div>
              <p className="text-fg">Limitations</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {r.scope.limitations.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </div>
            {r.run_id && (
              <p className="text-body-2">
                Run <Identifier value={r.run_id} label="Run ID" />
              </p>
            )}
          </>
        ) : (
          <>
            {model && <p className="text-fg">{model.description}</p>}
            <p>
              This section will state what was predicted, the observation window and horizon, the population, the sample unit and count, exclusions, and the
              split policy, with links to the run and artifact. Limitations are summarized here before any metric.
            </p>
            <Pending>No run is recorded for this model.</Pending>
          </>
        )}
      </div>
    </Section>
  );
}

function TrajectorySection({ report: r, model }: { report: Report | undefined; model: ModelInfo | null }) {
  const applicable = !model || model.task === "trajectory";
  return (
    <Section id="trajectory" title="Trajectory performance">
      <p className="max-w-[680px] text-body-2 text-fg-2">
        ADE is the mean Euclidean displacement across evaluated future points; FDE is the displacement at the specified final horizon. Both in yards, lower is
        better. Models are compared only under matching conditions; different conditions get separate tables.
      </p>
      {r?.trajectory && <p className="mt-1 text-caption text-muted">Aggregation: {r.trajectory.aggregation} · Masks: {r.trajectory.masks}</p>}
      {!applicable ? (
        <div className="mt-4">
          <StatusState kind="unavailable" compact title="Not applicable">
            {model?.model_version} is a {model?.task} model; trajectory metrics do not apply.
          </StatusState>
        </div>
      ) : r?.trajectory && r.trajectory.condition_groups.length ? (
        r.trajectory.condition_groups.map((g) => (
          <div key={g.conditions} className="scroll-quiet mt-4 overflow-x-auto" role="region" aria-label={`Trajectory metrics, ${g.conditions}`} tabIndex={0}>
            <p className="mb-2 text-caption text-muted">Conditions: {g.conditions}</p>
            <table className="data-table min-w-[640px]">
              <thead>
                <tr>
                  <th scope="col">Model / baseline</th>
                  <th scope="col" className="n">ADE (yd) · lower is better</th>
                  <th scope="col" className="n">FDE (yd) · lower is better</th>
                  <th scope="col" className="n">Horizon</th>
                  <th scope="col" className="n">N</th>
                </tr>
              </thead>
              <tbody>
                {g.rows.map((row) => (
                  <tr key={row.model_version} className={row.is_served ? "relative" : undefined}>
                    <th scope="row" className={`font-normal ${row.is_served ? "border-l-2 border-l-accent pl-3 text-fg" : "text-fg-2"}`}>
                      {row.label} <span className="num text-meta text-muted">{row.model_version}</span>
                      {row.is_served && <span className="ml-2 text-caption text-fg-2">served</span>}
                    </th>
                    <td className="n">
                      {fixed(row.ade_yd, 2)}
                      {row.ade_interval && <span className="text-muted"> [{fixed(row.ade_interval.lo, 2)}, {fixed(row.ade_interval.hi, 2)}]</span>}
                    </td>
                    <td className="n">
                      {fixed(row.fde_yd, 2)}
                      {row.fde_interval && <span className="text-muted"> [{fixed(row.fde_interval.lo, 2)}, {fixed(row.fde_interval.hi, 2)}]</span>}
                    </td>
                    <td className="n">{fixed(row.horizon_s, 1)} s</td>
                    <td className="n">{row.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      ) : (
        <div className="scroll-quiet mt-4 overflow-x-auto">
          <table className="data-table min-w-[640px]">
            <thead>
              <tr>
                <th scope="col">Model / baseline</th>
                <th scope="col" className="n">ADE (yd) · lower is better</th>
                <th scope="col" className="n">FDE (yd) · lower is better</th>
                <th scope="col" className="n">Horizon</th>
                <th scope="col" className="n">N</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row" className="border-l-2 border-l-accent pl-3 font-normal text-fg">
                  {model?.name ?? "Selected model"} <span className="num text-meta text-muted">{model?.model_version}</span>
                </th>
                <td colSpan={4} className="text-right text-muted">
                  {PENDING} · no values are shown until a run records them
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function ErrorUncertaintySection({ report: r, model }: { report: Report | undefined; model: ModelInfo | null }) {
  const series: ChartSeries[] = useMemo(
    () =>
      r?.error_by_horizon?.series.slice(0, 4).map((s, i) => ({
        key: s.model_version,
        label: s.label,
        served: s.is_served,
        dash: s.is_served ? "solid" : (["dashed", "dotted", "solid"] as const)[i % 3],
        points: s.points.map((p) => ({ x: p.horizon_s, y: p.value, lo: p.lo, hi: p.hi, n: p.n })),
      })) ?? [],
    [r],
  );
  const cov = r?.uncertainty;
  const covSeries: ChartSeries[] = cov?.supported
    ? [{ key: "cov", label: "Empirical", served: true, dash: "solid", points: cov.coverage.map((c) => ({ x: c.nominal, y: c.empirical, n: c.n })) }]
    : [];
  const nTotal = (s: ChartSeries[]) => Math.max(0, ...s.flatMap((x) => x.points.map((p) => p.n)));
  const trajectoryModel = !model || model.task === "trajectory";
  return (
    <Section id="error" title="Error and uncertainty">
      <div className="grid gap-8 lg:grid-cols-2">
        <ChartFrame
          title="Error by horizon"
          definition={r?.error_by_horizon?.definition ?? "Mean displacement error (yd) at each forecast horizon; lower is better."}
          footer={series.length ? `Up to n = ${nTotal(series)} per point · run ${r?.run_id ?? "—"} · split ${r?.split ?? "—"}` : "Source: evaluation run"}
          unavailable={
            !trajectoryModel ? (
              <Pending>Not applicable to a {model?.task} model.</Pending>
            ) : series.length === 0 ? (
              <Pending>No per-horizon errors are recorded for this model.</Pending>
            ) : undefined
          }
          table={<SeriesTable series={series} xLabel="Horizon (s)" yLabel="Error (yd)" xFormat={fmt.s1} yFormat={fmt.yd2} />}
        >
          <LineChart
            series={series}
            xLabel="Horizon (s)"
            yLabel="Error (yd)"
            xFormat={fmt.s1}
            yFormat={fmt.yd2}
            summary={series.map((s) => `${s.label}: ${s.points.filter((p) => p.y !== null).map((p) => `${fmt.yd2(p.y!)} yd at ${fmt.s1(p.x)}`).join(", ")}`).join(". ")}
          />
        </ChartFrame>
        <ChartFrame
          title="Uncertainty coverage"
          definition={
            cov?.definition ??
            "Share of observed positions inside the model's nominal region at each nominal level. States whether uncertainty is nominal, empirically calibrated, or uncalibrated."
          }
          footer={
            cov
              ? `Calibration status: ${cov.calibration ?? "not stated"} · up to n = ${nTotal(covSeries)} per level`
              : "Source: evaluation run"
          }
          unavailable={
            !trajectoryModel ? (
              <Pending>Not applicable to a {model?.task} model.</Pending>
            ) : !cov ? (
              <Pending>No coverage evaluation is recorded.</Pending>
            ) : !cov.supported ? (
              <StatusState kind="unavailable" compact title="Not supported by this model">
                {cov.unsupported_reason}
              </StatusState>
            ) : undefined
          }
          table={<SeriesTable series={covSeries} xLabel="Nominal level" yLabel="Empirical coverage" xFormat={fmt.pct} yFormat={fmt.pct} />}
        >
          <LineChart
            series={covSeries}
            xLabel="Nominal level"
            yLabel="Empirical coverage"
            xFormat={fmt.pct}
            yFormat={fmt.pct}
            yDomain={[0, 1]}
            reference={{ from: [0, 0], to: [1, 1], label: "Ideal" }}
            summary={covSeries[0]?.points.map((p) => `${fmt.pct(p.x)} nominal: ${p.y === null ? "missing" : fmt.pct(p.y)}`).join(", ") ?? ""}
          />
        </ChartFrame>
      </div>
    </Section>
  );
}

function RetrievalSection({ report: r, model }: { report: Report | undefined; model: ModelInfo | null }) {
  const applicable = !model || model.task === "retrieval";
  const rq = r?.retrieval;
  return (
    <Section id="retrieval" title="Retrieval quality">
      <p className="max-w-[680px] text-body-2 text-fg-2">
        Label-based relevance and ANN recall against exact search are reported separately. Cosine similarity alone is not evidence of retrieval quality.
      </p>
      {!applicable ? (
        <div className="mt-4">
          <StatusState kind="unavailable" compact title="Not applicable">
            Select a retrieval model to see retrieval quality.
          </StatusState>
        </div>
      ) : !rq ? (
        <div className="mt-4">
          <Pending>No relevance labels or ANN recall measurements are recorded for {model?.model_version ?? "this model"}.</Pending>
        </div>
      ) : (
        <>
          {(["relevance", "ann_recall"] as const).map((kind) => {
            const rows = rq.measures.filter((m) => m.kind === kind);
            if (!rows.length) return null;
            return (
              <div key={kind} className="scroll-quiet mt-4 overflow-x-auto" role="region" aria-label={kind === "relevance" ? "Label-based relevance" : "ANN recall"} tabIndex={0}>
                <p className="mb-2 text-caption text-muted">{kind === "relevance" ? "Label-based relevance" : "ANN recall against exact search"}</p>
                <table className="data-table min-w-[720px]">
                  <thead>
                    <tr>
                      <th scope="col">Measure</th>
                      <th scope="col">Label source</th>
                      <th scope="col">Evaluation set</th>
                      <th scope="col">Unit</th>
                      <th scope="col" className="n">Result</th>
                      <th scope="col" className="n">N</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((m) => (
                      <tr key={m.name}>
                        <th scope="row" className="font-normal text-fg" title={m.definition}>
                          {m.name}
                          <span className="block text-caption text-muted">{m.definition}</span>
                        </th>
                        <td>{m.label_source}</td>
                        <td>{m.evaluation_set}</td>
                        <td>{m.sample_unit}</td>
                        <td className="n">{fixed(m.value, m.decimals)}</td>
                        <td className="n">{m.n}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
          {rq.examples.length > 0 && (
            <div className="scroll-quiet mt-6 overflow-x-auto">
              <p className="mb-2 text-caption text-muted">Inspectable examples</p>
              <table className="data-table min-w-[560px]">
                <thead>
                  <tr>
                    <th scope="col">Query play</th>
                    <th scope="col">Result play</th>
                    <th scope="col" className="n">Rank</th>
                    <th scope="col" className="n">Cosine</th>
                    <th scope="col">Label</th>
                  </tr>
                </thead>
                <tbody>
                  {rq.examples.map((e) => (
                    <tr key={`${e.query_play_id}-${e.result_play_id}`}>
                      <td className="num text-meta">
                        <a className="link" href={`/play/${encodeURIComponent(e.query_play_id)}`}>{e.query_play_id}</a>
                      </td>
                      <td className="num text-meta">
                        <a className="link" href={`/compare?left=${encodeURIComponent(e.query_play_id)}&right=${encodeURIComponent(e.result_play_id)}`}>{e.result_play_id}</a>
                      </td>
                      <td className="n">{e.rank}</td>
                      <td className="n">{fixed(e.score, 3)}</td>
                      <td>{e.relevance_label ?? <span className="text-muted">Unlabeled</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

function SystemSection({ report: r }: { report: Report | undefined }) {
  const s = r?.system;
  return (
    <Section id="system" title="System performance">
      <p className="max-w-[680px] text-body-2 text-fg-2">Latency in milliseconds with its measurement context. No speed claim appears without hardware, data size, batch, and warm or cold conditions.</p>
      {!s ? (
        <div className="mt-4">
          <Pending>No latency measurements are recorded for this run.</Pending>
        </div>
      ) : (
        <>
          <p className="mt-2 text-caption text-muted">
            {s.conditions.hardware} · dataset {s.conditions.dataset_size} · index {s.conditions.index_size ?? "—"} · batch {s.conditions.batch_size} ·{" "}
            {s.conditions.warm ? "warm" : "cold"} · {s.conditions.timing_scope === "model_only" ? "model only" : "end to end"}
          </p>
          <div className="scroll-quiet mt-3 overflow-x-auto" role="region" aria-label="Latency" tabIndex={0}>
            <table className="data-table min-w-[560px]">
              <thead>
                <tr>
                  <th scope="col">Operation</th>
                  <th scope="col" className="n">p50 (ms)</th>
                  <th scope="col" className="n">p95 (ms)</th>
                  <th scope="col" className="n">p99 (ms)</th>
                  <th scope="col" className="n">N</th>
                </tr>
              </thead>
              <tbody>
                {s.rows.map((row) => (
                  <tr key={row.operation}>
                    <th scope="row" className="font-normal text-fg">{row.operation}</th>
                    <td className="n">{fixed(row.p50_ms, 1)}</td>
                    <td className="n">{fixed(row.p95_ms, 1)}</td>
                    <td className="n">{fixed(row.p99_ms, 1)}</td>
                    <td className="n">{row.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Section>
  );
}

type SliceKey = "slice" | "n" | "ade_yd" | "fde_yd" | "coverage";

function SlicesSection({ report: r }: { report: Report | undefined }) {
  const [sort, setSort] = useState<{ key: SliceKey; dir: 1 | -1 }>({ key: "ade_yd", dir: -1 });
  const rows = useMemo(() => {
    const list = [...(r?.slices?.rows ?? [])];
    list.sort((a, b) => {
      const va = a[sort.key];
      const vb = b[sort.key];
      if (va === null) return 1;
      if (vb === null) return -1;
      return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
    });
    return list;
  }, [r, sort]);
  const header = (key: SliceKey, label: string, numeric = true) => {
    const active = sort.key === key;
    return (
      <th scope="col" className={numeric ? "n" : undefined} aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
        <button type="button" className="inline-flex items-center gap-1 hover:text-fg" onClick={() => setSort({ key, dir: active ? (sort.dir === 1 ? -1 : 1) : -1 })}>
          {label}
          {active && (sort.dir === 1 ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />)}
        </button>
      </th>
    );
  };
  return (
    <Section id="slices" title="Slices and limitations">
      {!r?.slices ? (
        <Pending>Error slices appear with a stated reporting rule for insufficient samples.</Pending>
      ) : (
        <>
          <p className="text-caption text-muted">Reporting rule: {r.slices.reporting_rule}</p>
          <div className="scroll-quiet mt-3 overflow-x-auto" role="region" aria-label="Error slices" tabIndex={0}>
            <table className="data-table min-w-[640px]">
              <thead>
                <tr>
                  {header("slice", "Slice", false)}
                  {header("n", "N")}
                  {header("ade_yd", "ADE (yd)")}
                  {header("fde_yd", "FDE (yd)")}
                  {header("coverage", "Coverage")}
                  <th scope="col">Evidence / limitations</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.slice}>
                    <th scope="row" className="font-normal text-fg">{row.slice}</th>
                    <td className="n">{row.n}</td>
                    <td className="n">{fixed(row.ade_yd, 2)}</td>
                    <td className="n">{fixed(row.fde_yd, 2)}</td>
                    <td className="n">{percent(row.coverage)}</td>
                    <td>
                      {!row.sufficient && <span className="text-warning">Insufficient sample · </span>}
                      {row.note ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div className="mt-8 grid gap-8 md:grid-cols-2">
        <div>
          <h3 className="text-panel font-semibold">Known failure modes</h3>
          {r?.failure_modes.length ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-body-2 text-fg-2">
              {r.failure_modes.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-body-2 text-muted">{r?.run_id ? "None recorded for this run." : "Recorded with an evaluation run."}</p>
          )}
        </div>
        <div>
          <h3 className="text-panel font-semibold">Reproducibility</h3>
          {r?.reproducibility ? (
            <dl className="mt-2 grid grid-cols-[120px_minmax(0,1fr)] gap-y-1 text-body-2">
              {(
                [
                  ["Commit", r.reproducibility.git_commit],
                  ["Config", r.reproducibility.config],
                  ["Dataset manifest", r.reproducibility.dataset_manifest],
                  ["Run", r.reproducibility.run_id],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-fg-2">{k}</dt>
                  <dd>{v ? <Identifier value={v} label={k} maxWidth={320} /> : <span className="text-muted">—</span>}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="mt-2 text-body-2 text-muted">Dataset, split, model, run, and artifact identifiers appear once a run is recorded.</p>
          )}
        </div>
      </div>
    </Section>
  );
}
