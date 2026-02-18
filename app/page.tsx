"use client";

import { useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

type CsvRow = {
  Fuel?: string;
  LicenceStatus?: string;
  BodyType?: string;
  Make?: string;
  [key: string]: string | undefined;
};

type Metric = "TOTAL" | "LICENSED" | "SORN" | "BOTH";
type ScaleMode = "COMBINED" | "DUAL";
type ChartType = "LINE" | "BAR";

type Point = {
  quarter: string;
  licensed: number;
  sorn: number;
  total: number;
};
// Detects columns formatted as "YYYY Q#" (e.g., 2023 Q1)
function isQuarterCol(col: string) {
  return /^\d{4}\sQ[1-4]$/.test(col);
}

// Converts "YYYY Q#" into sortable numeric key (year * 10 + quarter)
function quarterSortKey(col: string) {
  const [y, q] = col.split(" ");
  const year = Number(y);
  const quarter = Number(q.replace("Q", ""));
  return year * 10 + quarter;
}

// Finds index of default starting quarter (2009 Q1) to exclude sparse early data
const DEFAULT_START = "2009 Q1";
function findDefaultStartIdx(qCols: string[]) {
  const startKey = quarterSortKey(DEFAULT_START);
  const idx = qCols.findIndex((q) => quarterSortKey(q) >= startKey);
  return idx >= 0 ? idx : 0;
}

// Safely converts CSV values to numbers (handles empty/invalid values)
function safeNum(x: string | undefined) {
  if (!x) return 0;
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

// Normalises text fields (trim + uppercase) for consistent grouping
function normUpper(x: string | undefined) {
  return (x || "").trim().toUpperCase();
}

function KpiCard({
  title,
  value,
  sub,
}: {
  title: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-md hover:shadow-lg transition-shadow duration-200">
      <div className="text-xs uppercase tracking-wide text-slate-500">
        {title}
      </div>
      <div className="mt-1 text-2xl font-semibold text-slate-900">{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

export default function Home() {
  const [rowsCount, setRowsCount] = useState(0);

  const [quarterCols, setQuarterCols] = useState<string[]>([]);
  const [fuelOptions, setFuelOptions] = useState<string[]>([]);
  const [bodyTypeOptions, setBodyTypeOptions] = useState<string[]>([]);

  // Controls
  const [fuel, setFuel] = useState("ALL");
  const [bodyType, setBodyType] = useState("ALL");
  const [makeKey, setMakeKey] = useState("ALL");

  const [metric, setMetric] = useState<Metric>("TOTAL");
  const [chartType, setChartType] = useState<ChartType>("LINE");
  const [scaleMode, setScaleMode] = useState<ScaleMode>("COMBINED");
  const [includeEarly, setIncludeEarly] = useState(false);

  const [fromIdx, setFromIdx] = useState(0);
  const [toIdx, setToIdx] = useState(0);

  const [fuelBodyMakeSeriesMap, setFuelBodyMakeSeriesMap] = useState<
    Record<string, Record<string, Record<string, Point[]>>>
  >({});

  const [topMakes, setTopMakes] = useState<string[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fmt = (n: number) => Math.round(n).toLocaleString("en-GB");

  // Visible quarter list
  const visibleQuarterCols = useMemo(() => {
    if (!quarterCols.length) return [];
    if (includeEarly) return quarterCols;

    const defaultFrom = findDefaultStartIdx(quarterCols);
    return quarterCols.slice(defaultFrom);
  }, [quarterCols, includeEarly]);

  // Enforce range validity
  useEffect(() => {
    if (!quarterCols.length) return;

    const defaultFrom = findDefaultStartIdx(quarterCols);

    if (!includeEarly) {
      if (fromIdx < defaultFrom) setFromIdx(defaultFrom);
      if (toIdx < defaultFrom) setToIdx(defaultFrom);
    }
  }, [includeEarly, quarterCols, fromIdx, toIdx]);

  // BAR forces combined
  useEffect(() => {
    if (chartType === "BAR" && scaleMode === "DUAL") {
      setScaleMode("COMBINED");
    }
  }, [chartType, scaleMode]);


  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        setError(null);

        const res = await fetch("/VEH0120_GB.csv");
        if (!res.ok) throw new Error(`Failed to fetch CSV: ${res.status}`);

        const text = await res.text();
        const parsed = Papa.parse<CsvRow>(text, {
          header: true,
          skipEmptyLines: true,
        });

        if (parsed.errors?.length) throw new Error(parsed.errors[0].message);

        const data = parsed.data.filter(Boolean);
        setRowsCount(data.length);

        const cols = parsed.meta.fields ?? [];
        const qCols = cols
          .filter(isQuarterCol)
          .sort((a, b) => quarterSortKey(a) - quarterSortKey(b));
        if (!qCols.length) throw new Error("No valid quarter columns detected.");
        setQuarterCols(qCols);

        const defaultFrom = findDefaultStartIdx(qCols);
        setFromIdx(defaultFrom);
        setToIdx(Math.max(defaultFrom, qCols.length - 1));

        // Fuel options
        const fuelLabels = Array.from(
          new Set(data.map((r) => (r.Fuel || "").trim()).filter(Boolean))
        ).sort((a, b) => a.localeCompare(b));
        if (!fuelLabels.length) throw new Error("No fuel categories detected.");


        setFuelOptions(["All", ...fuelLabels]);

        const fuelKeys = ["ALL", ...fuelLabels.map((f) => f.toUpperCase())];
        if (!fuelKeys.includes(fuel)) setFuel("ALL");

        // Body type options
        const bodyLabels = Array.from(
          new Set(data.map((r) => (r.BodyType || "").trim()).filter(Boolean))
        ).sort((a, b) => a.localeCompare(b));
        setBodyTypeOptions(bodyLabels);

        const bodyKeys = ["ALL", ...bodyLabels.map((b) => b.toUpperCase())];
        if (!bodyKeys.includes(bodyType)) setBodyType("ALL");

        // One-pass aggregation:
        // Pre-computes quarterly totals for every Fuel → BodyType → Make combination,
        // including "ALL" rollups, so filtering is instant during chart interaction.
        const qCount = qCols.length;

        const acc: Record<
          string,
          Record<string, Record<string, { licensed: number[]; sorn: number[] }>>
        > = {};
        // Ensures accumulator bucket exists for given fuel/body/make combination
        function ensureAcc(fuelKey: string, bodyKey: string, mk: string) {
          if (!acc[fuelKey]) acc[fuelKey] = {};
          if (!acc[fuelKey][bodyKey]) acc[fuelKey][bodyKey] = {};
          if (!acc[fuelKey][bodyKey][mk]) {
            acc[fuelKey][bodyKey][mk] = {
              licensed: Array(qCount).fill(0),
              sorn: Array(qCount).fill(0),
            };
          }
          return acc[fuelKey][bodyKey][mk];
        }

        for (const r of data) {
          const fuelKey = normUpper(r.Fuel);
          if (!fuelKey) continue;

          const bodyKey = normUpper(r.BodyType) || "UNKNOWN";
          const mk = normUpper(r.Make) || "UNKNOWN";
          const status = normUpper(r.LicenceStatus);
          if (status !== "LICENSED" && status !== "SORN") continue;

          //  normal fuel buckets
          const b1 = ensureAcc(fuelKey, bodyKey, mk);
          const b2 = ensureAcc(fuelKey, bodyKey, "ALL");
          const b3 = ensureAcc(fuelKey, "ALL", mk);
          const b4 = ensureAcc(fuelKey, "ALL", "ALL");

          //  ALL-fuel buckets 
          const a1 = ensureAcc("ALL", bodyKey, mk);
          const a2 = ensureAcc("ALL", bodyKey, "ALL");
          const a3 = ensureAcc("ALL", "ALL", mk);
          const a4 = ensureAcc("ALL", "ALL", "ALL");

          for (let i = 0; i < qCount; i++) {
            const q = qCols[i];
            const v = safeNum(r[q]);
            if (v === 0) continue;

            if (status === "LICENSED") {
              b1.licensed[i] += v;
              b2.licensed[i] += v;
              b3.licensed[i] += v;
              b4.licensed[i] += v;

              a1.licensed[i] += v;
              a2.licensed[i] += v;
              a3.licensed[i] += v;
              a4.licensed[i] += v;
            } else {
              b1.sorn[i] += v;
              b2.sorn[i] += v;
              b3.sorn[i] += v;
              b4.sorn[i] += v;

              a1.sorn[i] += v;
              a2.sorn[i] += v;
              a3.sorn[i] += v;
              a4.sorn[i] += v;
            }
          }
        }

        const finalMap: Record<string, Record<string, Record<string, Point[]>>> =
          {};

        for (const fk of Object.keys(acc)) {
          finalMap[fk] = {};
          for (const bk of Object.keys(acc[fk])) {
            finalMap[fk][bk] = {};
            for (const mk of Object.keys(acc[fk][bk])) {
              const a = acc[fk][bk][mk];
              finalMap[fk][bk][mk] = qCols.map((q, i) => {
                const licensed = a.licensed[i];
                const sorn = a.sorn[i];
                return { quarter: q, licensed, sorn, total: licensed + sorn };
              });
            }
          }
        }

        setFuelBodyMakeSeriesMap(finalMap);
      } catch (e: any) {
        setError(e?.message ?? "Unknown error");
      } finally {
        setLoading(false);
      }
    }

    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Determine top 20 makes (by latest total) for selected fuel and body type
  useEffect(() => {
    const obj = fuelBodyMakeSeriesMap[fuel]?.[bodyType] || {};
    const keys = Object.keys(obj).filter((k) => k !== "ALL");

    const ranked = keys
      .map((mk) => {
        const s = obj[mk];
        const last = s?.[s.length - 1];
        return { mk, total: last?.total ?? 0 };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, 20)
      .map((x) => x.mk);

    setTopMakes(ranked);

    if (makeKey !== "ALL" && !ranked.includes(makeKey)) {
      setMakeKey("ALL");
    }
  }, [fuelBodyMakeSeriesMap, fuel, bodyType, makeKey]);

  // Extract currently selected time range series for chart rendering
  const series: Point[] = useMemo(() => {
    const base = fuelBodyMakeSeriesMap[fuel]?.[bodyType]?.[makeKey] || [];
    return base.slice(fromIdx, toIdx + 1);
  }, [fuelBodyMakeSeriesMap, fuel, bodyType, makeKey, fromIdx, toIdx]);

  // KPI metric extractor
  const metricValue = (p: Point | null) => {
    if (!p) return 0;
    if (metric === "LICENSED") return p.licensed;
    if (metric === "SORN") return p.sorn;
    return p.total;
  };

  const last = series.length ? series[series.length - 1] : null;
  const prev = series.length >= 2 ? series[series.length - 2] : null;

  const latestQuarter = last?.quarter ?? "—";
  const latestVal = metricValue(last);
  const prevVal = metricValue(prev);

  const qoqAbs = latestVal - prevVal;
  const qoqPct = prevVal === 0 ? null : (qoqAbs / prevVal) * 100;

  const qoqLabel =
    series.length >= 2
      ? qoqPct === null
        ? `${qoqAbs >= 0 ? "+" : ""}${fmt(qoqAbs)}`
        : `${qoqAbs >= 0 ? "+" : ""}${fmt(qoqAbs)} (${qoqPct >= 0 ? "+" : ""
        }${qoqPct.toFixed(1)}%)`
      : "—";

  const sornShare = last && last.total > 0 ? (last.sorn / last.total) * 100 : 0;

  const start = series.length ? series[0] : null;
  const startVal = metricValue(start);
  const endVal = metricValue(last);

  const netAbs = endVal - startVal;
  const netPct = startVal < 50000 ? null : (netAbs / startVal) * 100;

  const netLabel =
    series.length >= 2
      ? netPct === null
        ? `${netAbs >= 0 ? "+" : ""}${fmt(netAbs)} (since ${start?.quarter ?? "start"
        })`
        : `${netAbs >= 0 ? "+" : ""}${fmt(netAbs)} (${netPct >= 0 ? "+" : ""
        }${netPct.toFixed(1)}%)`
      : "—";


  const allSeries: Point[] = useMemo(() => {
    const base = fuelBodyMakeSeriesMap["ALL"]?.[bodyType]?.[makeKey] || [];
    return base.slice(fromIdx, toIdx + 1);
  }, [fuelBodyMakeSeriesMap, bodyType, makeKey, fromIdx, toIdx]);

  const lastAll = allSeries.length ? allSeries[allSeries.length - 1] : null;
  const latestAllVal = metricValue(lastAll);

  const marketSharePct =
    latestAllVal > 0 ? (latestVal / latestAllVal) * 100 : null;
  const marketShareLabel =
    marketSharePct === null ? "—" : `${marketSharePct.toFixed(1)}%`;

  // Compute EV share:
  // Aggregates all fuel types containing "ELECTRIC" (battery, hybrid, plug-in, etc.)
  // to calculate overall electric proportion within filtered selection.
  const evSeries: Point[] = useMemo(() => {
    const fuelKeys = Object.keys(fuelBodyMakeSeriesMap);
    const evKeys = fuelKeys.filter((k) => k.includes("ELECTRIC"));

    const len = Math.max(0, toIdx - fromIdx + 1);
    if (!evKeys.length || len === 0) return [];

    // create an empty series we can add into
    const out: Point[] = Array.from({ length: len }, (_, i) => {
      const q = series[i]?.quarter ?? (quarterCols[fromIdx + i] ?? "");
      return { quarter: q, licensed: 0, sorn: 0, total: 0 };
    });

    // sum across all electric-ish fuels
    for (const fk of evKeys) {
      const s = (fuelBodyMakeSeriesMap[fk]?.[bodyType]?.[makeKey] || []).slice(
        fromIdx,
        toIdx + 1
      );

      for (let i = 0; i < out.length; i++) {
        const p = s[i];
        if (!p) continue;
        out[i].licensed += p.licensed;
        out[i].sorn += p.sorn;
        out[i].total += p.total;
      }
    }

    return out;
  }, [
    fuelBodyMakeSeriesMap,
    bodyType,
    makeKey,
    fromIdx,
    toIdx,
    series,
    quarterCols,
  ]);

  const lastEV = evSeries.length ? evSeries[evSeries.length - 1] : null;
  const evSharePct =
    latestAllVal > 0 ? (metricValue(lastEV) / latestAllVal) * 100 : null;
  const evLabel = evSharePct === null ? "—" : `${evSharePct.toFixed(1)}%`;

  const Q_3Y = 12;
  const idx3y = series.length - 1 - Q_3Y;

  const base3y = idx3y >= 0 ? metricValue(series[idx3y]) : null;
  const abs3y = base3y === null ? null : latestVal - base3y;
  const pct3y =
    base3y && base3y > 0 ? (abs3y! / base3y) * 100 : null;

  const growth3yLabel =
    base3y === null
      ? "—"
      : pct3y === null
        ? `${abs3y! >= 0 ? "+" : ""}${fmt(abs3y!)}`
        : `${abs3y! >= 0 ? "+" : ""}${fmt(abs3y!)} (${pct3y >= 0 ? "+" : ""
        }${pct3y.toFixed(1)}%)`;

  // Auto-generated summary insight based on latest metrics
  const insight =
    series.length >= 2
      ? (() => {
        const parts: string[] = [];
        if (marketSharePct !== null) {
          parts.push(
            `Selected fuel accounts for ~${marketSharePct.toFixed(
              1
            )}% of the filtered fleet in the latest quarter.`
          );
        }
        if (evSharePct !== null) {
          parts.push(`Electric share is ~${evSharePct.toFixed(1)}%.`);
        }
        if (pct3y !== null) {
          parts.push(
            `Compared to 3 years ago, values changed by ${pct3y >= 0 ? "+" : ""
            }${pct3y.toFixed(1)}%.`
          );
        }
        return parts.join(" ") || "Not enough data for trend analysis.";
      })()
      : "Not enough data for trend analysis.";

  const metricTitle =
    metric === "TOTAL"
      ? "Total"
      : metric === "LICENSED"
        ? "Licensed"
        : metric === "SORN"
          ? "SORN"
          : "Total (with breakdown)";

  return (
    <main className="min-h-screen bg-slate-50 p-10">
      <h1 className="text-4xl font-bold text-slate-900 tracking-tight">
        UK Vehicle Dashboard
      </h1>
      <div className="mt-2 h-1 w-16 bg-blue-600 rounded-full"></div>
      <p className="mt-2 text-slate-500 text-sm">
        Quarterly registrations (Licensed, SORN, Total) — GOV dataset VEH0120.
      </p>

      <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center gap-4">
          <div className="text-sm font-semibold text-slate-700">Controls</div>

          {/* Fuel */}
          <label className="text-sm text-slate-700">
            Fuel:
            <select
              className="ml-2 rounded-md border border-slate-300 bg-white text-slate-800 px-3 py-2 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={fuel}
              onChange={(e) => setFuel(e.target.value)}
              disabled={!fuelOptions.length}
            >
              <option value="ALL" className="bg-white text-black">
                All
              </option>
              {fuelOptions
                .filter((x) => x !== "All")
                .map((label) => (
                  <option
                    key={label}
                    value={label.toUpperCase()}
                    className="bg-white text-black"
                  >
                    {label}
                  </option>
                ))}
            </select>
          </label>

          {/* Body type */}
          <label className="text-sm text-slate-700">
            Body type:
            <select
              className="ml-2 rounded-md border border-slate-300 bg-white text-slate-800 px-3 py-2 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={bodyType}
              onChange={(e) => setBodyType(e.target.value)}
              disabled={!bodyTypeOptions.length}
            >
              <option value="ALL" className="bg-white text-black">
                All
              </option>
              {bodyTypeOptions.map((label) => (
                <option
                  key={label}
                  value={label.toUpperCase()}
                  className="bg-white text-black"
                >
                  {label}
                </option>
              ))}
            </select>
          </label>

          {/* Make */}
          <label className="text-sm text-slate-700">
            Make:
            <select
              className="ml-2 rounded-md border border-slate-300 bg-white text-slate-800 px-3 py-2 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={makeKey}
              onChange={(e) => setMakeKey(e.target.value)}
            >
              <option value="ALL" className="bg-white text-black">
                All
              </option>
              {topMakes.map((m) => (
                <option key={m} value={m} className="bg-white text-black">
                  {m}
                </option>
              ))}
            </select>
          </label>

          {/* Metric */}
          <label className="text-sm text-slate-700">
            Metric:
            <select
              className="ml-2 rounded-md border border-slate-300 bg-white text-slate-800 px-3 py-2 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={metric}
              onChange={(e) => setMetric(e.target.value as Metric)}
            >
              <option value="TOTAL" className="bg-white text-black">
                Total
              </option>
              <option value="LICENSED" className="bg-white text-black">
                Licensed
              </option>
              <option value="SORN" className="bg-white text-black">
                SORN
              </option>
              <option value="BOTH" className="bg-white text-black">
                Total + breakdown
              </option>
            </select>
          </label>

          {/* Chart */}
          <label className="text-sm text-slate-700">
            Chart:
            <select
              className="ml-2 rounded-md border border-slate-300 bg-white text-slate-800 px-3 py-2 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={chartType}
              onChange={(e) => setChartType(e.target.value as ChartType)}
            >
              <option value="LINE" className="bg-white text-black">
                Line
              </option>
              <option value="BAR" className="bg-white text-black">
                Bar
              </option>
            </select>
          </label>

          {/* Scale */}
          <label className="text-sm text-slate-700">
            Scale:
            <select
              className="ml-2 rounded-md border border-slate-300 bg-white text-slate-800 px-3 py-2 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={scaleMode}
              onChange={(e) => setScaleMode(e.target.value as ScaleMode)}
              disabled={chartType === "BAR"}
            >
              <option value="COMBINED" className="bg-white text-black">
                Combined
              </option>
              <option value="DUAL" className="bg-white text-black">
                Dual axis
              </option>
            </select>
          </label>

          {/* From */}
          <label className="text-sm text-slate-700">
            From:
            <select
              className="ml-2 rounded-md border border-slate-300 bg-white text-slate-800 px-3 py-2 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={fromIdx}
              onChange={(e) => {
                const next = Number(e.target.value);
                setFromIdx(next);
                if (next > toIdx) setToIdx(next);
              }}
              disabled={!quarterCols.length}
            >
              {visibleQuarterCols.map((q) => {
                const fullIdx = quarterCols.indexOf(q);
                return (
                  <option
                    key={q}
                    value={fullIdx}
                    className="bg-white text-black"
                  >
                    {q}
                  </option>
                );
              })}
            </select>
          </label>

          {/* To */}
          <label className="text-sm text-slate-700">
            To:
            <select
              className="ml-2 rounded-md border border-slate-300 bg-white text-slate-800 px-3 py-2 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={toIdx}
              onChange={(e) => {
                const next = Number(e.target.value);
                setToIdx(next);
                if (next < fromIdx) setFromIdx(next);
              }}
              disabled={!quarterCols.length}
            >
              {visibleQuarterCols.map((q) => {
                const fullIdx = quarterCols.indexOf(q);
                return (
                  <option
                    key={q}
                    value={fullIdx}
                    className="bg-white text-black"
                  >
                    {q}
                  </option>
                );
              })}
            </select>
          </label>

          {/* Early years toggle */}
          <label className="text-sm text-slate-700 flex items-center gap-2">
            <input
              type="checkbox"
              checked={includeEarly}
              onChange={(e) => setIncludeEarly(e.target.checked)}
              className="h-4 w-4"
            />
            Include early years (pre-2009)
          </label>

          {!includeEarly && (
            <div className="text-xs text-slate-400">
              Default starts at 2009 Q1 due to limited pre-2009 coverage.
            </div>
          )}

          {/* Reset */}
          <button
            className="rounded-md border border-slate-300 bg-white text-slate-700 px-4 py-2 text-sm shadow-sm hover:bg-slate-100 transition"
            onClick={() => {
              const defaultFrom = findDefaultStartIdx(quarterCols);
              setFromIdx(defaultFrom);
              setToIdx(Math.max(defaultFrom, quarterCols.length - 1));
            }}
            disabled={!quarterCols.length}
          >
            Reset range
          </button>

          {/* Info */}
          <div className="text-xs text-slate-400">
            Rows: {rowsCount.toLocaleString("en-GB")} • Quarters:{" "}
            {quarterCols.length}
          </div>
        </div>
      </section>

      {/* KPI row 1 */}
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <KpiCard
          title={`Latest (${metricTitle})`}
          value={fmt(latestVal)}
          sub={latestQuarter}
        />
        <KpiCard
          title={`QoQ change (${metricTitle})`}
          value={qoqLabel}
          sub="vs previous quarter"
        />
        <KpiCard
          title="SORN share (latest)"
          value={`${sornShare.toFixed(1)}%`}
          sub="portion off-road"
        />
      </div>

      {/* KPI row 2 (priorities) */}
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <KpiCard
          title="Market share (latest)"
          value={marketShareLabel}
          sub="Selected fuel vs all fuels (same filters)"
        />
        <KpiCard
          title="EV share (latest)"
          value={evLabel}
          sub="Electric / all fuels (same filters)"
        />
        <KpiCard
          title={`3-year change (${metricTitle})`}
          value={growth3yLabel}
          sub={
            idx3y >= 0
              ? `${series[idx3y]?.quarter ?? "—"} → ${latestQuarter}`
              : "needs 12 quarters"
          }
        />
      </div>

      <div className="mt-3 text-xs text-slate-400">
        Selected period net change:
        <span className="text-slate-800 font-medium"> {netLabel}</span>{" "}
        ({series[0]?.quarter ?? "—"} →{" "}
        {series[series.length - 1]?.quarter ?? "—"})
      </div>

      <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
        <strong>Insight:</strong> {insight}
      </div>

      {loading && <p className="mt-6">Loading CSV...</p>}
      {error && <p className="mt-6 text-red-600">Error: {error}</p>}

      {!loading && !error && (
        <div className="mt-6 h-[520px] w-full rounded-2xl bg-white p-6 shadow-sm border border-slate-200">
          <ResponsiveContainer>
            {chartType === "LINE" ? (
              <LineChart
                data={series}
                margin={{ top: 20, right: 40, left: 60, bottom: 60 }}
              >
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="quarter"
                  angle={-30}
                  textAnchor="end"
                  interval={6}
                  height={60}
                />

                {scaleMode === "COMBINED" ? (
                  <>
                    <YAxis
                      width={105}
                      tickFormatter={(v) =>
                        Number(v).toLocaleString("en-GB")
                      }
                    />
                    <Tooltip
                      formatter={(v: any) =>
                        Number(v).toLocaleString("en-GB")
                      }
                    />
                    <Legend />

                    {metric === "TOTAL" && (
                      <Line
                        type="monotone"
                        dataKey="total"
                        name="Total"
                        strokeWidth={3}
                        dot={false}
                      />
                    )}
                    {metric === "LICENSED" && (
                      <Line
                        type="monotone"
                        dataKey="licensed"
                        name="Licensed"
                        strokeWidth={3}
                        dot={false}
                      />
                    )}
                    {metric === "SORN" && (
                      <Line
                        type="monotone"
                        dataKey="sorn"
                        name="SORN"
                        strokeWidth={3}
                        dot={false}
                      />
                    )}
                    {metric === "BOTH" && (
                      <>
                        <Line
                          type="monotone"
                          dataKey="licensed"
                          name="Licensed"
                          strokeWidth={3}
                          dot={false}
                        />
                        <Line
                          type="monotone"
                          dataKey="sorn"
                          name="SORN"
                          strokeWidth={2}
                          strokeDasharray="5 5"
                          dot={false}
                        />
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <YAxis
                      yAxisId="left"
                      width={80}
                      tickFormatter={(v) =>
                        Number(v).toLocaleString("en-GB")
                      }
                    />
                    {metric === "BOTH" && (
                      <YAxis
                        yAxisId="right"
                        width={80}
                        orientation="right"
                        tickFormatter={(v) =>
                          Number(v).toLocaleString("en-GB")
                        }
                      />
                    )}
                    <Tooltip
                      formatter={(v: any) =>
                        Number(v).toLocaleString("en-GB")
                      }
                    />
                    <Legend />

                    {metric !== "BOTH" && (
                      <Line
                        yAxisId="left"
                        type="monotone"
                        dataKey={
                          metric === "TOTAL"
                            ? "total"
                            : metric === "LICENSED"
                              ? "licensed"
                              : "sorn"
                        }
                        name={
                          metric === "TOTAL"
                            ? "Total"
                            : metric === "LICENSED"
                              ? "Licensed"
                              : "SORN"
                        }
                        strokeWidth={3}
                        dot={false}
                      />
                    )}

                    {metric === "BOTH" && (
                      <>
                        <Line
                          yAxisId="left"
                          type="monotone"
                          dataKey="licensed"
                          name="Licensed"
                          strokeWidth={3}
                          dot={false}
                        />
                        <Line
                          yAxisId="right"
                          type="monotone"
                          dataKey="sorn"
                          name="SORN"
                          strokeWidth={3}
                          dot={false}
                        />
                      </>
                    )}
                  </>
                )}
              </LineChart>
            ) : (
              <BarChart
                data={series}
                margin={{ top: 20, right: 40, left: 60, bottom: 60 }}
              >
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="quarter"
                  angle={-30}
                  textAnchor="end"
                  interval={6}
                  height={60}
                />
                <YAxis
                  tickFormatter={(v) => Number(v).toLocaleString("en-GB")}
                />
                <Tooltip
                  formatter={(v: any) => Number(v).toLocaleString("en-GB")}
                />
                <Legend />

                {metric === "BOTH" ? (
                  <>
                    <Bar dataKey="licensed" name="Licensed" stackId="a" fill="#4682B4" />
                    <Bar dataKey="sorn" name="SORN" stackId="a" fill="#1F3A5F" />
                  </>
                ) : metric === "LICENSED" ? (
                  <Bar dataKey="licensed" name="Licensed" fill="#4682B4" />
                ) : metric === "SORN" ? (
                  <Bar dataKey="sorn" name="SORN" fill="#1F3A5F" />
                ) : (
                  <Bar dataKey="total" name="Total" fill="#4682B4" />
                )}
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
    </main>
  );
}
