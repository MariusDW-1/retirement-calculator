import React, { useMemo, useState } from "react";

/**
 * SmartPlan – Investment Calculator (South Africa)
 * React + TypeScript + Tailwind (single-file / Canvas-ready)
 *
 * Requirements from user:
 * - The following inputs must default to 0 on page load AND reset to 0 when "Reset" is pressed:
 *   • Lump Sum (R)
 *   • Monthly Contribution (R)
 *   • Years
 *   • Target Amount (Today’s R)
 *   • (Lump-sum only mode) Lump Sum (R) and Years (these are the same fields; mode just hides Monthly)
 *
 * Notes:
 * - Monthly compounding
 * - Real values = nominal / (1+inflation)^years
 * - No external images; CSV + Print actions included
 * - Tailwind classes included
 */

// ---------- Utilities ----------
function parseNum(v: string | number) {
  if (typeof v === "number") return v;
  const n = parseFloat((v ?? "").toString().replace(/[^0-9.,-]/g, "").replace(",", "."));
  return isNaN(n) ? 0 : n;
}
const currency = new Intl.NumberFormat("en-ZA", {
  style: "currency",
  currency: "ZAR",
  maximumFractionDigits: 0,
});

const clamp = (x: number, min: number, max: number) => Math.min(max, Math.max(min, x));
const nonNeg = (x: number) => Math.max(0, x);

function fvLumpMonthly(pv: number, annualR: number, months: number) {
  const i = annualR / 12;
  return pv * Math.pow(1 + i, months);
}
function fvGrowingAnnuityMonthly(
  P0Monthly: number,
  annualR: number,
  annualG: number,
  months: number,
  timing: "end" | "begin"
) {
  if (months <= 0 || P0Monthly <= 0) return 0;
  const i = annualR / 12;
  const j = annualG / 12;
  if (Math.abs(i - j) < 1e-10) {
    const fvSame = P0Monthly * months * Math.pow(1 + i, months);
    return timing === "begin" ? fvSame * (1 + i) : fvSame;
  }
  const fv = P0Monthly * ((Math.pow(1 + i, months) - Math.pow(1 + j, months)) / (i - j));
  return timing === "begin" ? fv * (1 + i) : fv;
}

type Timing = "end" | "begin";
type Mode = "lump" | "lump_plus_monthly";

// ---------- Types ----------
interface Inputs {
  mode: Mode;
  // must default to 0 and reset to 0:
  lumpSum: number;
  monthlyContribution: number;
  years: number;
  targetAmountTodayR: number;
  // other assumptions:
  contribEscalationPA: number;
  nominalReturnPA: number;
  inflationPA: number;
  timing: Timing;
  hasTarget: boolean;
}

function defaultInputs(): Inputs {
  return {
    mode: "lump_plus_monthly",
    // >>> Defaults requested as 0 <<<
    lumpSum: 0,
    monthlyContribution: 0,
    years: 0,
    targetAmountTodayR: 0,
    // Other sensible defaults
    contribEscalationPA: 0, // keep 0 so monthly stays flat unless changed
    nominalReturnPA: 0.10,
    inflationPA: 0.055,
    timing: "end",
    hasTarget: true,
  };
}

// ---------- Component ----------
export default function InvestmentCalculator() {
  const [inp, setInp] = useState<Inputs>(defaultInputs());
  const [version, setVersion] = useState(0); // force a light remount on reset for visual refresh

  const months = Math.max(0, Math.round(inp.years * 12));

  const results = useMemo(() => {
    const n = months;

    // Nominal FV components
    const fvLump = fvLumpMonthly(nonNeg(inp.lumpSum || 0), clamp(inp.nominalReturnPA, -0.99, 2), n);
    const fvContrib =
      inp.mode === "lump_plus_monthly"
        ? fvGrowingAnnuityMonthly(
            nonNeg(inp.monthlyContribution || 0),
            clamp(inp.nominalReturnPA, -0.99, 2),
            clamp(inp.contribEscalationPA || 0, -0.99, 2),
            n,
            inp.timing
          )
        : 0;

    const projectedNominal = fvLump + fvContrib;
    const projectedReal =
      projectedNominal / Math.pow(1 + clamp(inp.inflationPA, -0.99, 2), Math.max(0, inp.years));

    const targetReal = inp.hasTarget ? Math.max(0, inp.targetAmountTodayR || 0) : 0;
    const shortfallReal = Math.max(0, targetReal - projectedReal);

    // Extra monthly needed (solve on nominal FV)
    let extraMonthlyToday = 0;
    if (inp.hasTarget && shortfallReal > 0 && n > 0) {
      const fvNeededNominal =
        shortfallReal * Math.pow(1 + clamp(inp.inflationPA, -0.99, 2), Math.max(0, inp.years));
      const f = (P: number) =>
        fvGrowingAnnuityMonthly(
          nonNeg(P),
          clamp(inp.nominalReturnPA, -0.99, 2),
          clamp(inp.contribEscalationPA || 0, -0.99, 2),
          n,
          inp.timing
        ) - fvNeededNominal;

      let x0 = 0,
        x1 = 100000;
      for (let k = 0; k < 40; k++) {
        const y0 = f(x0),
          y1 = f(x1);
        if (!isFinite(y0) || !isFinite(y1)) {
          x0 = 0;
          x1 = Math.max(1000, x1 / 2);
          continue;
        }
        if (Math.abs(y1 - y0) < 1e-6) break;
        const x2 = x1 - (y1 * (x1 - x0)) / (y1 - y0);
        if (!isFinite(x2)) {
          x0 = 0;
          x1 *= 0.5;
          continue;
        }
        x0 = x1;
        x1 = Math.max(0, x2);
      }
      extraMonthlyToday = Math.max(0, x1);
    }

    const ratioLump = projectedNominal > 0 ? fvLump / projectedNominal : 0;
    const ratioContrib = projectedNominal > 0 ? fvContrib / projectedNominal : 0;

    const fundedRatio = inp.hasTarget && targetReal > 0 ? projectedReal / targetReal : 0;
    let health: "good" | "warn" | "bad" = "bad";
    if (!inp.hasTarget || targetReal <= 0) health = "good";
    else if (fundedRatio >= 1) health = "good";
    else if (fundedRatio >= 0.7) health = "warn";

    // Series
    const seriesNominal: number[] = [];
    const seriesReal: number[] = [];
    for (let m = 0; m <= n; m++) {
      const nomL = fvLumpMonthly(nonNeg(inp.lumpSum || 0), clamp(inp.nominalReturnPA, -0.99, 2), m);
      const nomC =
        inp.mode === "lump_plus_monthly"
          ? fvGrowingAnnuityMonthly(
              nonNeg(inp.monthlyContribution || 0),
              clamp(inp.nominalReturnPA, -0.99, 2),
              clamp(inp.contribEscalationPA || 0, -0.99, 2),
              m,
              inp.timing
            )
          : 0;
      const nom = nomL + nomC;
      const yearsFrac = m / 12;
      const real = nom / Math.pow(1 + clamp(inp.inflationPA, -0.99, 2), yearsFrac);
      seriesNominal.push(nom);
      seriesReal.push(real);
    }

    return {
      fvLump,
      fvContrib,
      projectedNominal,
      projectedReal,
      targetReal,
      shortfallReal,
      extraMonthlyToday,
      ratioLump,
      ratioContrib,
      fundedRatio,
      health,
      seriesNominal,
      seriesReal,
    };
  }, [inp, months]);

  // Actions
  const resetInfo = () => {
    // Reset ONLY the specified inputs back to 0; keep other assumptions unchanged
    setInp((prev) => ({
      ...prev,
      lumpSum: 0,
      monthlyContribution: 0,
      years: 0,
      targetAmountTodayR: 0,
    }));
    setVersion((v) => v + 1); // visual refresh for number inputs
  };

  const exportCSV = () => {
    const rows: string[] = [];
    const dt = new Date().toISOString();
    rows.push(`Generated,${dt}`);
    rows.push(`Mode,${inp.mode === "lump" ? "Lump only" : "Lump + Monthly"}`);
    rows.push(`Lump sum (R),${inp.lumpSum}`);
    rows.push(`Monthly contribution (R),${inp.monthlyContribution}`);
    rows.push(`Contribution escalation (% p.a.),${Math.round((inp.contribEscalationPA || 0) * 10000) / 100}`);
    rows.push(`Years,${inp.years}`);
    rows.push(`Expected return (% p.a.),${Math.round((inp.nominalReturnPA || 0) * 10000) / 100}`);
    rows.push(`Inflation (CPI, % p.a.),${Math.round((inp.inflationPA || 0) * 10000) / 100}`);
    rows.push(`Timing,${inp.timing === "begin" ? "Start of month" : "End of month"}`);
    rows.push(`Target enabled,${inp.hasTarget}`);
    rows.push(`Target (today's R),${inp.targetAmountTodayR}`);
    rows.push("--- results ---");
    rows.push(`Projected (Nominal, R),${Math.round(results.projectedNominal)}`);
    rows.push(`Projected (Today’s R),${Math.round(results.projectedReal)}`);
    if (inp.mode === "lump_plus_monthly") {
      rows.push(`From Lump Sum (%),${((results.fvLump / results.projectedNominal) * 100 || 0).toFixed(1)}`);
      rows.push(`From Contributions (%),${((results.fvContrib / results.projectedNominal) * 100 || 0).toFixed(1)}`);
    }
    if (inp.hasTarget) {
      rows.push(`Target (Today’s R),${Math.round(results.targetReal)}`);
      rows.push(`Shortfall (Today’s R),${Math.round(results.shortfallReal)}`);
      rows.push(`Extra monthly needed (Today’s R),${Math.round(results.extraMonthlyToday)}`);
      rows.push(`Funding ratio,${results.fundedRatio.toFixed(3)}`);
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `smartplan_investment_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const printReport = () => window.print();

  // UI helper
  const field = (label: string, children: React.ReactNode) => (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-gray-700">{label}</span>
      {children}
    </label>
  );

  return (
    <div className="min-h-screen bg-white text-gray-900" key={version}>
      <div className="mx-auto max-w-7xl px-4 py-8">
        {/* Header */}
        <header className="mb-6 flex items-center justify-between gap-3">
          <img src="/Images/SAFP_logo_250x400.png" alt="SmartPlan Logo" width={120} height={120} />
          <h1 className="text-2xl font-semibold">New Investment Calculator</h1>
          <div className="rounded-full bg-teal-600 px-4 py-1 text-sm font-medium text-white">South Africa</div>
        </header>

        {/* Quick Actions */}
        <div className="mb-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={resetInfo}
            className="rounded-xl border px-3 py-2 text-sm"
            aria-label="Reset selected investment inputs to zero"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={exportCSV}
            className="rounded-xl border px-3 py-2 text-sm"
            aria-label="Export investment inputs and results to CSV"
          >
            Export CSV
          </button>
          <button
            type="button"
            onClick={printReport}
            className="rounded-xl border px-3 py-2 text-sm"
            aria-label="Print or save PDF"
          >
            Print / Save PDF
          </button>
        </div>

        {/* Status */}
        <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-4">
          <Stat label="Years">{inp.years}</Stat>
          <Stat label="Projected (Nominal)">{currency.format(Math.round(results.projectedNominal))}</Stat>
          <Stat label="Projected (Today’s R)">{currency.format(Math.round(results.projectedReal))}</Stat>
          <Stat label="Funding">
            {inp.hasTarget && results.fundedRatio ? `${(results.fundedRatio * 100).toFixed(1)}%` : "—"}
          </Stat>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Assumptions */}
          <section className="rounded-2xl border p-6 shadow-sm">
            <h2 className="mb-4 text-lg font-semibold">Assumptions</h2>

            <div className="mb-3 flex gap-2">
              <button
                type="button"
                className={`rounded-xl px-3 py-1 text-sm ${
                  inp.mode === "lump" ? "bg-teal-600 text-white" : "bg-gray-100"
                }`}
                onClick={() => setInp((v) => ({ ...v, mode: "lump" }))}
              >
                Lump sum only
              </button>
              <button
                type="button"
                className={`rounded-xl px-3 py-1 text-sm ${
                  inp.mode === "lump_plus_monthly" ? "bg-teal-600 text-white" : "bg-gray-100"
                }`}
                onClick={() => setInp((v) => ({ ...v, mode: "lump_plus_monthly" }))}
              >
                Lump sum + monthly
              </button>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {field(
                "Lump Sum (R)",
                <input
                  aria-label="Lump Sum (R)"
                  type="number"
                  className="rounded-xl border p-2"
                  value={inp.lumpSum}
                  onChange={(e) => setInp((v) => ({ ...v, lumpSum: nonNeg(parseNum(e.target.value)) }))}
                />
              )}

              {inp.mode === "lump_plus_monthly" &&
                field(
                  "Monthly Contribution (R)",
                  <input
                    aria-label="Monthly Contribution (R)"
                    type="number"
                    className="rounded-xl border p-2"
                    value={inp.monthlyContribution}
                    onChange={(e) => setInp((v) => ({ ...v, monthlyContribution: nonNeg(parseNum(e.target.value)) }))}
                  />
                )}

              {inp.mode === "lump_plus_monthly" &&
                field(
                  "Contribution Escalation (% p.a.)",
                  <Percent
                    value={inp.contribEscalationPA}
                    onChange={(val) => setInp((v) => ({ ...v, contribEscalationPA: clamp(val, -0.99, 2) }))}
                  />
                )}

              {inp.mode === "lump_plus_monthly" && (
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-gray-700">Contribution Timing</span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className={`rounded-xl px-3 py-1 text-sm ${
                        inp.timing === "end" ? "bg-teal-600 text-white" : "bg-gray-100"
                      }`}
                      onClick={() => setInp((v) => ({ ...v, timing: "end" }))}
                    >
                      End of month
                    </button>
                    <button
                      type="button"
                      className={`rounded-xl px-3 py-1 text-sm ${
                        inp.timing === "begin" ? "bg-teal-600 text-white" : "bg-gray-100"
                      }`}
                      onClick={() => setInp((v) => ({ ...v, timing: "begin" }))}
                    >
                      Start of month
                    </button>
                  </div>
                </label>
              )}

              {field(
                "Years",
                <input
                  aria-label="Years"
                  type="number"
                  className="rounded-xl border p-2"
                  value={inp.years}
                  onChange={(e) => setInp((v) => ({ ...v, years: nonNeg(parseNum(e.target.value)) }))}
                />
              )}

              {field(
                "Expected Return (% p.a.)",
                <Percent
                  value={inp.nominalReturnPA}
                  onChange={(val) => setInp((v) => ({ ...v, nominalReturnPA: clamp(val, -0.99, 2) }))}
                />
              )}

              {field(
                "Inflation (CPI, % p.a.)",
                <Percent
                  value={inp.inflationPA}
                  onChange={(val) => setInp((v) => ({ ...v, inflationPA: clamp(val, -0.99, 2) }))}
                />
              )}
            </div>
          </section>

          {/* Goal (optional) */}
          <section className="rounded-2xl border p-6 shadow-sm">
            <h2 className="mb-4 text-lg font-semibold">Goal (Optional)</h2>
            <div className="mb-3">
              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={inp.hasTarget}
                  onChange={(e) => setInp((v) => ({ ...v, hasTarget: e.target.checked }))}
                />
                <span>Compare to a Target (today’s Rand)</span>
              </label>
            </div>
            {inp.hasTarget && (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {field(
                  "Target Amount (Today’s R)",
                  <input
                    aria-label="Target Amount (Today’s R)"
                    type="number"
                    className="rounded-xl border p-2"
                    value={inp.targetAmountTodayR}
                    onChange={(e) =>
                      setInp((v) => ({ ...v, targetAmountTodayR: nonNeg(parseNum(e.target.value)) }))
                    }
                  />
                )}
                <div className="rounded-xl bg-gray-50 p-3 text-sm">
                  Extra monthly (today’s R) needed: <b>{currency.format(Math.round(results.extraMonthlyToday))}</b>
                </div>
              </div>
            )}
          </section>

          {/* Results & Visuals */}
          <section className="rounded-2xl border p-6 shadow-sm lg:col-span-2">
            <h2 className="mb-4 text-lg font-semibold">Results</h2>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Stat label="Projected (Nominal)">{currency.format(Math.round(results.projectedNominal))}</Stat>
              <Stat label="Projected (Today’s R)">{currency.format(Math.round(results.projectedReal))}</Stat>
              {inp.mode === "lump_plus_monthly" ? (
                <Stat label="From Lump / From Monthly">
                  {(results.ratioLump * 100).toFixed(1)}% / {(results.ratioContrib * 100).toFixed(1)}%
                </Stat>
              ) : (
                <Stat label="From Lump / From Monthly">100.0% / 0.0%</Stat>
              )}
            </div>

            {/* Line Chart */}
            <div className="mt-6">
              <div className="mb-2 text-sm font-medium">Future Value over time</div>
              <LineChart nominal={results.seriesNominal} real={results.seriesReal} years={inp.years} />
            </div>

            {/* Bar Snapshot */}
            <div className="mt-6">
              <div className="mb-2 text-sm font-medium">Final snapshot (today’s R)</div>
              <BarChartSnapshot
                required={inp.hasTarget ? results.targetReal : 0}
                projected={results.projectedReal}
                shortfall={inp.hasTarget ? Math.max(0, results.targetReal - results.projectedReal) : 0}
                fromLump={results.fvLump / Math.pow(1 + clamp(inp.inflationPA, -0.99, 2), Math.max(0, inp.years))}
                fromMonthly={
                  results.fvContrib / Math.pow(1 + clamp(inp.inflationPA, -0.99, 2), Math.max(0, inp.years))
                }
                showMonthly={inp.mode === "lump_plus_monthly"}
              />
            </div>

            {/* Funding Level */}
            {inp.hasTarget && results.targetReal > 0 && (
              <div className="mt-4">
                <div className="mb-1 text-sm">Funding Level</div>
                <div className="h-4 w-full rounded-full bg-gray-200">
                  <div
                    className={`h-4 rounded-full ${
                      results.health === "good" ? "bg-green-500" : results.health === "warn" ? "bg-yellow-500" : "bg-red-500"
                    }`}
                    style={{ width: `${Math.min(100, results.fundedRatio * 100).toFixed(1)}%` }}
                  />
                </div>
                <div className="mt-1 text-xs text-gray-600">{(results.fundedRatio * 100).toFixed(1)}% funded</div>
              </div>
            )}

            <div className="mt-6 rounded-xl bg-gray-50 p-4 text-xs text-gray-600">
              Disclaimer: Estimates only; not financial advice. Returns and inflation are assumptions and may differ from
              actual outcomes. Verify FSCA/FAIS disclosures and POPIA consent if client data is processed.
            </div>
          </section>
        </div>

        <footer className="mt-8 text-xs text-gray-500">
          © {new Date().getFullYear()} SA Financial Planners – Investment estimator.
        </footer>
      </div>
    </div>
  );
}

// ---------- UI bits ----------
function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-semibold">{children}</div>
    </div>
  );
}

function Percent({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="relative">
      <input
        aria-label="Percentage"
        type="number"
        className="w-full rounded-xl border border-gray-300 p-2 pr-10 focus:outline-none focus:ring-2 focus:ring-teal-500"
        value={Math.round((value || 0) * 10000) / 100}
        step={0.1}
        onChange={(e) => onChange(parseNum(e.target.value) / 100)}
      />
      <span className="absolute right-3 top-2.5 text-gray-500">%</span>
    </div>
  );
}

/** Simple SVG Line Chart (Nominal vs Real, monthly points, no external libs) */
function LineChart({ nominal, real, years }: { nominal: number[]; real: number[]; years: number }) {
  const width = 680,
    height = 220,
    pad = 28;
  const n = Math.max(nominal.length, real.length);

  const maxY = Math.max(1, ...nominal, ...real);
  const denom = Math.max(1, n - 1);
  const scaleX = (i: number) => pad + (i / denom) * (width - pad * 2);
  const scaleY = (v: number) => height - pad - (v / maxY) * (height - pad * 2);

  const pathFrom = (arr: number[]) => {
    if (!arr.length) return "";
    if (arr.length === 1) {
      const x = scaleX(0),
        y = scaleY(arr[0]);
      return `M ${x} ${y} m -1,0 a 1,1 0 1,0 2,0 a 1,1 0 1,0 -2,0`;
    }
    let d = `M ${scaleX(0)} ${scaleY(arr[0])}`;
    for (let i = 1; i < arr.length; i++) d += ` L ${scaleX(i)} ${scaleY(arr[i])}`;
    return d;
  };

  const gridY: number[] = [];
  for (let k = 0; k < 5; k++) gridY.push((k / 4) * maxY);

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} className="rounded-xl border bg-white">
      {gridY.map((gy, idx) => (
        <g key={idx}>
          <line x1={pad} y1={scaleY(gy)} x2={width - pad} y2={scaleY(gy)} stroke="#e5e7eb" strokeWidth="1" />
          <text x={pad - 4} y={scaleY(gy)} textAnchor="end" dominantBaseline="middle" fontSize="10" fill="#6b7280">
            {abbrCurrency(gy)}
          </text>
        </g>
      ))}
      <path d={pathFrom(nominal)} fill="none" stroke="#3b82f6" strokeWidth="2" />
      <path d={pathFrom(real)} fill="none" stroke="#16a34a" strokeWidth="2" />
      <g>
        <rect x={pad} y={8} width="10" height="10" fill="#3b82f6" />
        <text x={pad + 14} y={17} fontSize="11" fill="#374151">
          Nominal
        </text>
        <rect x={pad + 70} y={8} width="10" height="10" fill="#16a34a" />
        <text x={pad + 84} y={17} fontSize="11" fill="#374151">
          Today’s R
        </text>
      </g>
      {[0, Math.max(1, Math.floor(years / 2)), years].map((yr, idx) => {
        const i = years > 0 ? Math.round((yr / years) * Math.max(0, n - 1)) : 0;
        return (
          <text key={idx} x={scaleX(i)} y={height - 6} textAnchor="middle" fontSize="10" fill="#6b7280">
            {yr}y
          </text>
        );
      })}
    </svg>
  );
}

function abbrCurrency(v: number) {
  if (v >= 1_000_000_000) return `R ${(v / 1_000_000_000).toFixed(1)}b`;
  if (v >= 1_000_000) return `R ${(v / 1_000_000).toFixed(1)}m`;
  if (v >= 1_000) return `R ${(v / 1_000).toFixed(1)}k`;
  return `R ${Math.round(v)}`;
}

/** Bar Chart (final snapshot) */
function BarChartSnapshot({
  required,
  projected,
  shortfall,
  fromLump,
  fromMonthly,
  showMonthly,
}: {
  required: number;
  projected: number;
  shortfall: number;
  fromLump: number;
  fromMonthly: number;
  showMonthly: boolean;
}) {
  const items = [
    { label: "Required", value: required, color: "#d22b2b" },
    { label: "Projected", value: projected, color: "#16a34a" },
    { label: "Shortfall", value: shortfall, color: "#f59e0b" },
    { label: "From Lump", value: fromLump, color: "#3b82f6" },
    ...(showMonthly ? ([{ label: "From Monthly", value: fromMonthly, color: "#7c3aed" }] as const) : []),
  ];
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className={`grid gap-4 ${showMonthly ? "grid-cols-5" : "grid-cols-4"}`}>
      {items.map((it) => (
        <div key={it.label} className="flex flex-col items-center">
          <div className="flex h-40 w-12 items-end rounded-md bg-gray-100">
            <div
              className="w-full rounded-md"
              style={{ height: `${Math.min(100, (it.value / max) * 100)}%`, backgroundColor: it.color }}
            />
          </div>
          <div className="mt-2 text-center text-xs text-gray-600">
            <div className="font-medium">{it.label}</div>
            <div>{currency.format(Math.round(it.value))}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
