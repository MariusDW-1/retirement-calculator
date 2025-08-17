import React, { useEffect, useMemo, useState } from "react";

/**
 * Smart Plan – Retirement Gap Forecaster (ZA)
 * Stack: React + TypeScript + Tailwind CSS + custom SVG charting
 * Palette: Teal (#059669, #14B8A6) + Greys (#111827 … #f9fafb)
 * Numbers: whole Rands with comma grouping (no decimals). Ages shown as whole years.
 * Typography: Lato
 */

/* ========================== Helpers =========================== */
const fmtZARWhole = new Intl.NumberFormat("en-ZA", {
  style: "currency",
  currency: "ZAR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
  useGrouping: true,
});
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
const toPV = (nominal: number, years: number, cpi: number) => nominal / Math.pow(1 + cpi, years);
/** Accepts comma-separated input and returns a Number */
const parseNum = (v: string | number) => {
  if (typeof v === "number") return isFinite(v) ? v : 0;
  const s = (v ?? "").toString().replace(/[\s,]/g, "").trim();
  if (s === "" || s === "-") return 0;
  const n = Number(s);
  return isFinite(n) ? n : 0;
};
/** SA ID → age (years). Returns null if invalid. YYMMDD from first 6 chars. */
function ageFromSouthAfricanId(id: string): number | null {
  const s = (id || "").replace(/\D/g, "");
  if (s.length < 6) return null; // need yymmdd
  const yy = Number(s.slice(0, 2));
  const mm = Number(s.slice(2, 4));
  const dd = Number(s.slice(4, 6));
  if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return null;
  const now = new Date();
  const currYY = now.getFullYear() % 100;
  const century = yy <= currYY ? 2000 : 1900; // 00..currYY → 2000+, else 1900+
  const birth = new Date(century + yy, mm - 1, dd);
  if (isNaN(birth.getTime())) return null;
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  if (!isFinite(age) || age < 0 || age > 120) return null;
  return age;
}

/* ========================== Inputs =========================== */
const RIGHT_COL = "9rem"; // default right column width for inputs

function FieldText({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (s: string) => void; placeholder?: string }) {
  return (
    <label className={`grid items-center gap-x-3 gap-y-1 text-[12px]`} style={{ gridTemplateColumns: `1fr ${RIGHT_COL}` }}>
      <span className="text-gray-700 whitespace-nowrap">{label}</span>
      <input
        type="text"
        className="h-7 w-full rounded-md border border-gray-300 bg-white px-1.5 text-left font-normal text-gray-900 focus:border-teal-400 focus:outline-none text-[11px]"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function FieldNumber({ label, value, onChange, disabled = false }: { label: string; value: number; onChange: (n: number) => void; disabled?: boolean }) {
  return (
    <label className={`grid items-center gap-x-3 gap-y-1 text-[12px]`} style={{ gridTemplateColumns: `1fr ${RIGHT_COL}` }}>
      <span className="text-gray-700 whitespace-nowrap">{label}</span>
      <input
        type="text"
        inputMode="numeric"
        disabled={disabled}
        className={`h-7 w-full rounded-md border border-gray-300 bg-white px-1.5 text-right font-normal text-gray-900 focus:border-teal-400 focus:outline-none text-[11px] ${disabled ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''}`}
        value={Number.isFinite(value) ? value.toLocaleString("en-ZA") : "0"}
        onChange={(e) => onChange(parseNum(e.target.value))}
      />
    </label>
  );
}

function FieldPercent({ label, value, onChange, rightCol }: { label: string; value: number; onChange: (n: number) => void; rightCol?: string; }) {
  const display = `${Math.round((value ?? 0) * 100).toLocaleString("en-ZA")}`; // whole percent
  const col = rightCol ?? RIGHT_COL;
  return (
    <label className={`grid items-center gap-x-3 gap-y-1 text-[12px]`} style={{ gridTemplateColumns: `1fr ${col}` }}>
      <span className="text-gray-700 whitespace-nowrap">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        className="h-7 w-full rounded-md border border-gray-300 bg-white px-1.5 text-right font-normal text-gray-900 focus:border-teal-400 focus:outline-none text-[11px]"
        value={display}
        onChange={(e) => {
          const raw = parseNum(e.target.value);
          onChange(isFinite(raw) ? raw / 100 : 0);
        }}
      />
    </label>
  );
}

function FieldReadOnly({ label, value }: { label: string; value: string }) {
  return (
    <div className={`grid items-center gap-x-3 gap-y-1 text-[12px]`} style={{ gridTemplateColumns: `1fr ${RIGHT_COL}` }}>
      <span className="text-gray-700 whitespace-nowrap">{label}</span>
      <div className="h-7 rounded-md border border-teal-300/70 bg-teal-50 px-1.5 text-right font-normal text-teal-700 text-[11px]">{value}</div>
    </div>
  );
}

/* ========================== Core Maths =========================== */
function accumulate({
  years,
  startBalance,
  monthlyStart,
  escalationPA,
  growthPA,
  employerMatchPct = 0,
}: {
  years: number;
  startBalance: number;
  monthlyStart: number;
  escalationPA: number; // annual escalation on contribution
  growthPA: number; // annual fund growth
  employerMatchPct?: number; // as a fraction of employee monthly contribution
}) {
  const months = Math.max(0, Math.round(years * 12));
  let bal = startBalance;
  let mContr = monthlyStart;
  const r = growthPA / 12; // monthly return
  const perYear: number[] = [];
  for (let m = 1; m <= months; m++) {
    if (m > 1 && (m - 1) % 12 === 0) mContr *= 1 + escalationPA; // escalate yearly
    const employer = employerMatchPct * mContr;
    bal = (bal + mContr + employer) * (1 + r);
    if (m % 12 === 0) perYear.push(bal);
  }
  return { fv: bal, series: perYear };
}

function simulateDrawdown({
  startFV,
  startAge,
  retireAge,
  endAge,
  postRetGrowthPA,
  cpiPA,
  monthlyIncomeTodayR,
  capitalNeedsAtRet = 0,
}: {
  startFV: number;
  startAge: number;
  retireAge: number;
  endAge: number;
  postRetGrowthPA: number;
  cpiPA: number;
  monthlyIncomeTodayR: number; // in today's R
  capitalNeedsAtRet?: number; // once-off need at retirement
}) {
  const monthsToEnd = Math.max(0, Math.round((endAge - retireAge) * 12));
  const growthM = postRetGrowthPA / 12;
  const cpiM = cpiPA / 12;
  let bal = Math.max(0, startFV - capitalNeedsAtRet);
  const pts: { age: number; balance: number }[] = [];
  let runOutAge: number | null = null;
  for (let m = 0; m <= monthsToEnd; m++) {
    const age = retireAge + m / 12;
    const monthsFromToday = Math.round((retireAge - startAge) * 12) + m;
    const incomeNominal = monthlyIncomeTodayR * Math.pow(1 + cpiM, monthsFromToday);
    bal *= 1 + growthM; // grow then draw
    const out = Math.min(bal, incomeNominal);
    bal -= out;
    pts.push({ age, balance: bal });
    if (runOutAge === null && bal <= 0) runOutAge = age;
  }
  const pvAtStart = toPV(bal, endAge - startAge, cpiPA);
  return { points: pts, endBalance: bal, pvAtStart, runOutAge };
}

function solveRecommended(
  fn: (m: number) => { runOutAge: number | null; endBalance: number },
  lo = 0,
  hi = 1_000_000,
) {
  const ok = (r: { runOutAge: number | null; endBalance: number }) => r.runOutAge === null && r.endBalance >= 0;
  let rHi = fn(hi), guard = 0;
  while (!ok(rHi) && guard++ < 28) { hi *= 1.5; rHi = fn(hi); }
  for (let i = 0; i < 48; i++) { const mid = (lo + hi) / 2; const rm = fn(mid); if (ok(rm)) hi = mid; else lo = mid; }
  return Math.round((lo + hi) / 2);
}

/* ========================== Charts (plain SVG) =========================== */
function StackedBarChart({
  labels,
  series,
  height = 320,
  pad = { l: 56, r: 16, t: 16, b: 40 },
}: {
  labels: string[];
  series: { name: string; color: string; values: number[] }[];
  height?: number;
  pad?: { l: number; r: number; t: number; b: number };
}) {
  const width = 720; const { l, r, t, b } = pad; const n = Math.max(1, labels.length); const xw = (width - l - r) / n;
  const maxV = Math.max(1, ...Array.from({ length: n }, (_, i) => series.reduce((s, ser) => s + (ser.values[i] ?? 0), 0)));
  const y = (v: number) => height - b - (v / maxV) * (height - t - b);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full">
      <rect x={0} y={0} width={width} height={height} fill="#fff" />
      {Array.from({ length: 5 }, (_, i) => { const yy = y((i / 4) * maxV); return <line key={i} x1={l} y1={yy} x2={width - r} y2={yy} stroke="#E5E7EB" />; })}
      {labels.map((_, i) => { const x = l + i * xw + 6; const w = xw - 12; let acc = 0; return (
        <g key={i}>
          {series.map((s, j) => { const v = s.values[i] ?? 0; const yTop = y(acc + v); const h = Math.max(0, y(acc) - yTop); acc += v; return <rect key={j} x={x} y={yTop} width={w} height={h} rx={3} fill={s.color} />; })}
        </g>
      ); })}
      <line x1={l} y1={height - b} x2={width - r} y2={height - b} stroke="#9CA3AF" />
      {labels.map((tLab, i) => (
        <text key={i} x={l + i * xw + xw / 2} y={height - 10} fontSize={11} textAnchor="middle" className="fill-gray-600">{`Age ${tLab}`}</text>
      ))}
    </svg>
  );
}

function DrawdownChart({
  implemented,
  recommended,
  retireAge,
  endAge,
  runOutAgeImplemented,
  runOutAgeRecommended,
  viewAge,
  height = 320,
  pad = { l: 56, r: 16, t: 16, b: 40 },
}: {
  implemented: { age: number; balance: number }[];
  recommended: { age: number; balance: number }[];
  retireAge: number;
  endAge: number;
  runOutAgeImplemented: number | null;
  runOutAgeRecommended: number | null;
  viewAge: number;
  height?: number;
  pad?: { l: number; r: number; t: number; b: number };
}) {
  const width = 720; const { l, r, t, b } = pad; const all = [...implemented, ...recommended]; const maxY = Math.max(1, ...all.map(p => p.balance)); const minY = Math.min(0, ...all.map(p => p.balance));
  const x = (age: number) => l + ((age - retireAge) / (endAge - retireAge)) * (width - l - r);
  const y = (v: number) => height - b - ((v - minY) / (maxY - minY)) * (height - t - b);
  const path = (pts: { age: number; balance: number }[]) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.age)},${y(p.balance)}`).join(" ");
  const ticks: number[] = []; for (let a = retireAge; a <= endAge; a += 5) ticks.push(a);
  const marker = (age: number | null, color: string, label: string) => age == null ? null : (
    <g>
      <line x1={x(age)} y1={t} x2={x(age)} y2={height - b} stroke={color} strokeDasharray="5 5" />
      <circle cx={x(age)} cy={y(0)} r={4} fill={color} />
      <text x={x(age) + 6} y={y(0) - 6} fontSize={11} className="fill-gray-800">{`${label} @ Age ${Math.round(age)}`}</text>
    </g>
  );
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full">
      <rect x={0} y={0} width={width} height={height} fill="#fff" />
      {ticks.map((ta, i) => <line key={i} x1={x(ta)} y1={t} x2={x(ta)} y2={height - b} stroke="#F3F4F6" />)}
      <line x1={l} y1={height - b} x2={width - r} y2={height - b} stroke="#9CA3AF" />
      <line x1={l} y1={t} x2={l} y2={height - b} stroke="#9CA3AF" />
      <line x1={l} y1={y(0)} x2={width - r} y2={y(0)} stroke="#D1D5DB" />
      <path d={path(implemented)} fill="none" stroke="#3B82F6" strokeWidth={3} />
      <path d={path(recommended)} fill="none" stroke="#10B981" strokeWidth={3} />
      {marker(runOutAgeImplemented, "#3B82F6", "Run‑out")}
      {marker(runOutAgeRecommended, "#10B981", "Run‑out")}
      <line x1={x(viewAge)} y1={t} x2={x(viewAge)} y2={height - b} stroke="#111827" strokeDasharray="4 4" />
      {ticks.map((ta, i) => (
        <text key={i} x={x(ta)} y={height - 10} fontSize={11} textAnchor="middle" className="fill-gray-600">{`Age ${Math.round(ta)}`}</text>
      ))}
      <text x={width - r} y={t + 14} textAnchor="end" fontSize={12} className="fill-gray-700">Implemented (blue)</text>
      <text x={width - r} y={t + 30} textAnchor="end" fontSize={12} className="fill-gray-700">Recommended (green)</text>
    </svg>
  );
}

/* ========================== Main =========================== */
export default function RetirementGapForecaster(): JSX.Element {
  /* --- Personal detail (editable) --- */
  const [clientName, setClientName] = useState<string>("");
  const [clientSurname, setClientSurname] = useState<string>("");
  const [clientEmail, setClientEmail] = useState<string>("");
  const [clientMobile, setClientMobile] = useState<string>("");
  const [clientId, setClientId] = useState<string>("");
  const [autoAgeFromId, setAutoAgeFromId] = useState<boolean>(true);
  const [currentAge, setCurrentAge] = useState<number>(49);
  const [retireAge, setRetireAge] = useState<number>(65);
  const [endAge, setEndAge] = useState<number>(90);

  /* --- Income & capital needs at retirement (editable) --- */
  const [capitalNeedsDebt, setCapitalNeedsDebt] = useState<number>(0);
  const [monthlyIncomeTodayR, setMonthlyIncomeTodayR] = useState<number>(55000);

  /* --- Assumptions (editable) --- */
  const [growthCompany, setGrowthCompany] = useState<number>(0.085);
  const [growthRA, setGrowthRA] = useState<number>(0.09);
  const [growthOther, setGrowthOther] = useState<number>(0.09);
  const [growthPreserve, setGrowthPreserve] = useState<number>(0.085);
  const [salaryIncrease, setSalaryIncrease] = useState<number>(0.06);
  const [cpi, setCpi] = useState<number>(0.055);
  const [postRetGrowth, setPostRetGrowth] = useState<number>(0.065);

  /* --- Current provisions (editable) --- */
  const [companyBal, setCompanyBal] = useState<number>(500000);
  const [companyMonthly, setCompanyMonthly] = useState<number>(9000);
  const [employerMatch, setEmployerMatch] = useState<number>(0);
  const [raBal, setRaBal] = useState<number>(0);
  const [raMonthly, setRaMonthly] = useState<number>(0);
  const [otherBal, setOtherBal] = useState<number>(0);
  const [otherMonthly, setOtherMonthly] = useState<number>(0);
  const [presBal, setPresBal] = useState<number>(0);
  const [presMonthly, setPresMonthly] = useState<number>(0);

  /* --- New provisions (editable) --- */
  const [newLump, setNewLump] = useState<number>(0);
  const [newMonthlyEsc, setNewMonthlyEsc] = useState<number>(0.065);
  const [newMonthlyGrowth, setNewMonthlyGrowth] = useState<number>(0.09);
  const [actualNewMonthly, setActualNewMonthly] = useState<number>(20000);

  const yearsToRet = Math.max(0, Math.round(retireAge - currentAge));

  // --- Auto-calc current age from SA ID ---
  useEffect(() => {
    if (!autoAgeFromId) return;
    const age = ageFromSouthAfricanId(clientId);
    if (age !== null && age > 0 && age < 120) setCurrentAge(age);
  }, [clientId, autoAgeFromId]);

  /* --- Accumulation for existing provisions --- */
  const baseAcc = useMemo(() => {
    const comp = accumulate({ years: yearsToRet, startBalance: companyBal, monthlyStart: companyMonthly, escalationPA: salaryIncrease, growthPA: growthCompany, employerMatchPct: employerMatch });
    const ra = accumulate({ years: yearsToRet, startBalance: raBal, monthlyStart: raMonthly, escalationPA: salaryIncrease, growthPA: growthRA });
    const other = accumulate({ years: yearsToRet, startBalance: otherBal, monthlyStart: otherMonthly, escalationPA: salaryIncrease, growthPA: growthOther });
    const pres = accumulate({ years: yearsToRet, startBalance: presBal, monthlyStart: presMonthly, escalationPA: salaryIncrease, growthPA: growthPreserve });
    const fvBase = comp.fv + ra.fv + other.fv + pres.fv;
    return { comp, ra, other, pres, fvBase };
  }, [yearsToRet, companyBal, companyMonthly, salaryIncrease, growthCompany, employerMatch, raBal, raMonthly, growthRA, otherBal, otherMonthly, growthOther, presBal, presMonthly, growthPreserve]);

  /* --- Auto-solve Recommended new recurring investment (to last to endAge) --- */
  const recommendedMonthly = useMemo(() => {
    if (monthlyIncomeTodayR <= 0) return 0;
    const solver = (m: number) => {
      const stream = accumulate({ years: yearsToRet, startBalance: newLump, monthlyStart: m, escalationPA: newMonthlyEsc, growthPA: newMonthlyGrowth });
      const startFV = baseAcc.fvBase + stream.fv;
      return simulateDrawdown({ startFV, startAge: currentAge, retireAge, endAge, postRetGrowthPA: postRetGrowth, cpiPA: cpi, monthlyIncomeTodayR, capitalNeedsAtRet: capitalNeedsDebt });
    };
    return solveRecommended(solver, 0, 1_000_000);
  }, [baseAcc.fvBase, yearsToRet, newLump, newMonthlyEsc, newMonthlyGrowth, currentAge, retireAge, endAge, postRetGrowth, cpi, monthlyIncomeTodayR, capitalNeedsDebt]);

  /* --- Accumulation for new contributions (Actual vs Recommended) --- */
  const newAccActual = useMemo(() => accumulate({ years: yearsToRet, startBalance: newLump, monthlyStart: actualNewMonthly, escalationPA: newMonthlyEsc, growthPA: newMonthlyGrowth }), [yearsToRet, newLump, actualNewMonthly, newMonthlyEsc, newMonthlyGrowth]);
  const newAccReco = useMemo(() => accumulate({ years: yearsToRet, startBalance: newLump, monthlyStart: recommendedMonthly, escalationPA: newMonthlyEsc, growthPA: newMonthlyGrowth }), [yearsToRet, newLump, recommendedMonthly, newMonthlyEsc, newMonthlyGrowth]);

  /* --- Totals at retirement --- */
  const fvAtRetActual = baseAcc.fvBase + newAccActual.fv; // Implemented (Actual)
  const fvAtRetReco = baseAcc.fvBase + newAccReco.fv;     // Recommended
  const pvAtRetImplemented = toPV(fvAtRetActual, retireAge - currentAge, cpi);

  /* --- Drawdown series --- */
  const drawImpl = useMemo(() => simulateDrawdown({ startFV: fvAtRetActual, startAge: currentAge, retireAge, endAge, postRetGrowthPA: postRetGrowth, cpiPA: cpi, monthlyIncomeTodayR, capitalNeedsAtRet: capitalNeedsDebt }), [fvAtRetActual, currentAge, retireAge, endAge, postRetGrowth, cpi, monthlyIncomeTodayR, capitalNeedsDebt]);
  const drawReco = useMemo(() => simulateDrawdown({ startFV: fvAtRetReco, startAge: currentAge, retireAge, endAge, postRetGrowthPA: postRetGrowth, cpiPA: cpi, monthlyIncomeTodayR, capitalNeedsAtRet: capitalNeedsDebt }), [fvAtRetReco, currentAge, retireAge, endAge, postRetGrowth, cpi, monthlyIncomeTodayR, capitalNeedsDebt]);

  /* --- Slider view marker (initialise safely) --- */
  const [viewAge, setViewAge] = useState<number>(() => clamp(endAge, retireAge, endAge));
  useEffect(() => { setViewAge(clamp(endAge, retireAge, endAge)); }, [endAge, retireAge]);

  // --- Reset inputs to defaults
  const resetAll = () => {
    setClientName(""); setClientSurname(""); setClientEmail(""); setClientMobile(""); setClientId(""); setAutoAgeFromId(true);
    setCurrentAge(49); setRetireAge(65); setEndAge(90);
    setCapitalNeedsDebt(0); setMonthlyIncomeTodayR(55000);
    setGrowthCompany(0.085); setGrowthRA(0.09); setGrowthOther(0.09); setGrowthPreserve(0.085);
    setSalaryIncrease(0.06); setCpi(0.055); setPostRetGrowth(0.065);
    setCompanyBal(500000); setCompanyMonthly(9000); setEmployerMatch(0);
    setRaBal(0); setRaMonthly(0); setOtherBal(0); setOtherMonthly(0); setPresBal(0); setPresMonthly(0);
    setNewLump(0); setNewMonthlyEsc(0.065); setNewMonthlyGrowth(0.09); setActualNewMonthly(20000);
  };

  /* --- Runtime sanity tests (do not remove) --- */
  useEffect(() => {
    const approx = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
    const t1 = accumulate({ years: 1, startBalance: 0, monthlyStart: 1000, escalationPA: 0, growthPA: 0 }); console.assert(approx(t1.fv, 12000), "T1 contributions sum");
    const d3 = simulateDrawdown({ startFV: 120000, startAge: 60, retireAge: 60, endAge: 61, postRetGrowthPA: 0, cpiPA: 0, monthlyIncomeTodayR: 10000 }); console.assert(d3.points.length >= 12, "T2 drawdown points");
    const r4 = solveRecommended((m) => simulateDrawdown({ startFV: m * 12, startAge: 60, retireAge: 60, endAge: 61, postRetGrowthPA: 0.06, cpiPA: 0.05, monthlyIncomeTodayR: 10000 }), 0, 100000); console.assert(Number.isFinite(r4), "T3 solver finite");
  }, []);

  return (
    <>
      {/* Lato font import + root font family */}
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Lato:wght@300;400;700&display=swap');`}</style>
      <div className="min-h-screen bg-gray-50 text-gray-900" style={{ fontFamily: 'Lato, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial' }}>
        <div className="mx-auto max-w-7xl space-y-8 px-6 py-8">
          <header className="flex flex-col items-start gap-3">
            <h1 className="text-2xl font-medium">Retirement Gap Forecaster</h1>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-[12px] font-normal text-gray-700 hover:bg-gray-50"
                onClick={resetAll}
              >
                Reset info
              </button>
              <button
                type="button"
                className="rounded-md bg-teal-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-teal-700"
                onClick={() => window.print()}
              >
                Print / Save PDF
              </button>
              <div className="hidden print:block text-xs text-gray-500">Generated on {new Date().toLocaleString()}</div>
            </div>
          </header>

          {/* Top: two columns side‑by‑side */}
          <section className="grid gap-6 rounded-2xl bg-white p-5 shadow md:grid-cols-2">
            {/* Personal detail */}
            <div>
              <h2 className="mb-3 text-base font-medium text-gray-800">Personal detail</h2>
              <div className="grid gap-y-2">
                <FieldText label="Client Name" value={clientName} onChange={setClientName} />
                <FieldText label="Surname" value={clientSurname} onChange={setClientSurname} />
                <FieldText label="Email" value={clientEmail} onChange={setClientEmail} />
                <FieldText label="Mobile" value={clientMobile} onChange={setClientMobile} />
                <FieldText label="ID Number" value={clientId} onChange={setClientId} />
                <div className="flex items-center gap-3 text-[12px]">
                  <label className="flex items-center gap-2"><input type="checkbox" checked={autoAgeFromId} onChange={(e)=>setAutoAgeFromId(e.target.checked)} /><span className="text-gray-700">Auto‑calculate age from ID</span></label>
                </div>
                <FieldNumber label="Current age" value={currentAge} onChange={setCurrentAge} disabled={autoAgeFromId} />
                <FieldNumber label="Retirement age" value={retireAge} onChange={setRetireAge} />
              </div>
            </div>
            {/* Income & capital needs at retirement */}
            <div>
              <h2 className="mb-3 text-base font-medium text-gray-800">Income and capital needs at retirement</h2>
              <div className="grid gap-y-2">
                <FieldNumber label="Capital needs & debt at retirement (R)" value={capitalNeedsDebt} onChange={setCapitalNeedsDebt} />
                <FieldNumber label="Monthly income (today’s R)" value={monthlyIncomeTodayR} onChange={setMonthlyIncomeTodayR} />
                <FieldNumber label="Income required to age" value={endAge} onChange={setEndAge} />
              </div>
            </div>
          </section>

          {/* Current vs New provisions */}
          <section className="grid gap-6 md:grid-cols-2">
            <div className="rounded-2xl bg-white p-5 shadow">
              <h3 className="mb-3 text-sm font-medium text-gray-800">Current provisions</h3>
              <div className="space-y-1.5">
                <FieldNumber label="Company – current balance (R)" value={companyBal} onChange={setCompanyBal} />
                <FieldNumber label="Company – monthly contribution (R)" value={companyMonthly} onChange={setCompanyMonthly} />
                <FieldNumber label="RA + recurring – current balance (R)" value={raBal} onChange={setRaBal} />
                <FieldNumber label="RA + recurring – monthly (R)" value={raMonthly} onChange={setRaMonthly} />
                <FieldNumber label="Other – current balance (R)" value={otherBal} onChange={setOtherBal} />
                <FieldNumber label="Other – monthly (R)" value={otherMonthly} onChange={setOtherMonthly} />
                <FieldNumber label="Preservation – current balance (R)" value={presBal} onChange={setPresBal} />
                <FieldNumber label="Preservation – monthly (R)" value={presMonthly} onChange={setPresMonthly} />
              </div>
            </div>
            <div className="rounded-2xl bg-white p-5 shadow">
              <h3 className="mb-3 text-sm font-medium text-gray-800">New provisions</h3>
              <div className="space-y-1.5">
                <FieldNumber label="New lump sum (once‑off) (R)" value={newLump} onChange={setNewLump} />
                <FieldReadOnly label="Recommended new recurring investment (auto) (R)" value={fmtZARWhole.format(recommendedMonthly)} />
                <FieldNumber label="Actual new recurring investment (R)" value={actualNewMonthly} onChange={setActualNewMonthly} />
                <FieldPercent rightCol="4.75rem" label="Annual increase of new investment (%)" value={newMonthlyEsc} onChange={setNewMonthlyEsc} />
                <FieldPercent rightCol="4.75rem" label="Fund growth of this new investment (%)" value={newMonthlyGrowth} onChange={setNewMonthlyGrowth} />
              </div>
            </div>
          </section>

          {/* Assumptions */}
          <section className="rounded-2xl bg-white p-5 shadow">
            <h3 className="mb-3 text-sm font-medium text-gray-800">Assumptions</h3>
            <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
              <FieldPercent rightCol="4.75rem" label="Expected salary increases p.a. (%)" value={salaryIncrease} onChange={setSalaryIncrease} />
              <FieldPercent rightCol="4.75rem" label="Consumer price index p.a. (%)" value={cpi} onChange={setCpi} />
              <FieldPercent rightCol="4.75rem" label="Return on capital after retirement p.a. (%)" value={postRetGrowth} onChange={setPostRetGrowth} />
              <FieldPercent rightCol="4.75rem" label="Growth of company fund p.a. (%)" value={growthCompany} onChange={setGrowthCompany} />
              <FieldPercent rightCol="4.75rem" label="Growth of RA + recurring p.a. (%)" value={growthRA} onChange={setGrowthRA} />
              <FieldPercent rightCol="4.75rem" label="Growth of other provisions p.a. (%)" value={growthOther} onChange={setGrowthOther} />
              <FieldPercent rightCol="4.75rem" label="Growth of preservation fund p.a. (%)" value={growthPreserve} onChange={setGrowthPreserve} />
            </div>
          </section>

          {/* Charts */}
          <section className="grid gap-8 lg:grid-cols-2">
            {/* Build‑up */}
            <div className="rounded-2xl bg-white p-5 shadow">
              <h3 className="mb-2 text-sm font-medium text-gray-800">Capital build‑up to retirement</h3>
              <StackedBarChart
                height={320}
                pad={{ l: 56, r: 16, t: 16, b: 40 }}
                labels={Array.from({ length: Math.max(1, yearsToRet) }, (_, i) => `${Math.round(currentAge + i + 1)}`)}
                series={[
                  { name: "Company", color: "#14B8A6", values: baseAcc.comp.series },
                  { name: "RA+Recurring", color: "#059669", values: baseAcc.ra.series },
                  { name: "Other", color: "#6B7280", values: baseAcc.other.series },
                  { name: "Preservation", color: "#9CA3AF", values: baseAcc.pres.series },
                  { name: "New Provision (Actual)", color: "#111827", values: newAccActual.series },
                ]}
              />
              {/* Legend (single line; swatch above name; no wrap) */}
              <div className="mt-3 flex flex-nowrap items-end justify-between gap-5 text-[12px] text-gray-700">
                {[
                  { n: "Company", c: "#14B8A6" },
                  { n: "RA+Recurring", c: "#059669" },
                  { n: "Other", c: "#6B7280" },
                  { n: "Preservation", c: "#9CA3AF" },
                  { n: "New Provision (Actual)", c: "#111827" },
                ].map((it) => (
                  <div key={it.n} className="flex flex-col items-center whitespace-nowrap">
                    <span className="h-2 w-6 rounded" style={{ background: it.c }} />
                    <span className="mt-1">{it.n}</span>
                  </div>
                ))}
              </div>
              {/* Outputs below chart */}
              <div className="mt-4 grid grid-cols-1 gap-2 text-sm text-gray-700">
                <div className="rounded-xl border border-gray-100 p-3">
                  <div className="text-sm text-gray-600">{`Retirement capital at age ${Math.round(retireAge)} (FV)`}</div>
                  <div className="text-base font-medium">{fmtZARWhole.format(fvAtRetActual)}</div>
                </div>
                <div className="rounded-xl border border-gray-100 p-3">
                  <div className="text-sm text-gray-600">{`Retirement capital at age ${Math.round(retireAge)} (PV today’s R)`}</div>
                  <div className="text-base font-medium">{fmtZARWhole.format(pvAtRetImplemented)}</div>
                </div>
              </div>
            </div>

            {/* Drawdown */}
            <div className="rounded-2xl bg-white p-5 shadow">
              <h3 className="mb-2 text-sm font-medium text-gray-800">Capital balance (cash or near cash) after retirement</h3>
              <DrawdownChart
                height={320}
                pad={{ l: 56, r: 16, t: 16, b: 40 }}
                implemented={drawImpl.points}
                recommended={drawReco.points}
                retireAge={retireAge}
                endAge={endAge}
                runOutAgeImplemented={drawImpl.runOutAge}
                runOutAgeRecommended={drawReco.runOutAge}
                viewAge={viewAge}
              />
              <div className="mt-3 rounded-md bg-gray-200 px-3 py-2 text-xs font-medium text-gray-800">
                Capital Balance lines: Blue = Implemented (Actual), Green = Recommended. Dashed line shows the selected "View at age".
              </div>
              {/* View at age slider (age shown at end) */}
              <div className="mt-4">
                <div className="mb-1 flex items-center justify-between text-[13px] text-gray-600">
                  <span>View at age</span>
                  <span className="font-medium text-gray-800">Age {Math.round(viewAge)}</span>
                </div>
                <input
                  type="range"
                  min={retireAge}
                  max={endAge}
                  step={1}
                  value={viewAge}
                  onChange={(e) => setViewAge(clamp(parseNum(e.target.value), retireAge, endAge))}
                  className="w-full"
                />
              </div>
            </div>
          </section>

          <p className="text-xs text-gray-500">Illustrative projections only; not financial advice. Ensure FAIS/FSCA compliance and handle personal data per POPIA.</p>
        </div>
      </div>
    </>
  );
}
