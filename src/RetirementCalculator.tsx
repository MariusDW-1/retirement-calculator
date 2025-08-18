import { useEffect, useMemo, useState } from "react";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";

/**
 * Smart Plan – Retirement Gap Forecaster (ZA)
 * Stack: React + TypeScript + Tailwind + custom SVG charting
 * Font: Load Google Fonts Lato in index.html (this file uses `font-sans`).
 * Numbers: Whole Rand values only (comma-separated). Ages are whole years.
 * Percent inputs: show one decimal using ZA locale (e.g., 6,5) and accept comma/dot input.
 * PDF Export: html2canvas + jsPDF single-page capture (WYSIWYG).
 */

/* =============================== Utilities =============================== */
const fmtZARWhole = new Intl.NumberFormat("en-ZA", {
  style: "currency",
  currency: "ZAR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
const toPV = (nominal: number, years: number, cpi: number) => nominal / Math.pow(1 + cpi, Math.max(0, years));

function safeParseNumber(str: string): number {
  if (str == null) return 0;
  const cleaned = String(str).replace(/[^0-9-]/g, "").trim();
  if (cleaned === "" || cleaned === "-") return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function ageFromSouthAfricanId(id: string): number | null {
  const s = (id || "").replace(/\D/g, "");
  if (s.length < 6) return null;
  const yy = Number(s.slice(0, 2));
  const mm = Number(s.slice(2, 4));
  const dd = Number(s.slice(4, 6));
  if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return null;
  const now = new Date();
  const currYY = now.getFullYear() % 100;
  const century = yy <= currYY ? 2000 : 1900;
  const birth = new Date(century + yy, mm - 1, dd);
  if (isNaN(birth.getTime())) return null;
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  if (!isFinite(age) || age < 0 || age > 120) return null;
  return Math.round(age);
}

/* =============================== PDF Export =============================== */
async function exportMainToPdf(containerId = "print-area") {
  const el = document.getElementById(containerId);
  if (!el) return;

  const canvas = await html2canvas(el, {
    background: "#ffffff",
    scale: 2,
    useCORS: true,
    onclone: (doc: Document) => {
      doc.querySelectorAll("style").forEach((st: HTMLStyleElement) => {
        // keep styles; customise if needed
      });
    },
  });

  const imgData = canvas.toDataURL("image/png");
  const pdf = new jsPDF({ orientation: "p", unit: "pt", format: "a4", compress: true });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = (canvas.height * pageWidth) / canvas.width;
  pdf.addImage(imgData, "PNG", 0, 0, pageWidth, pageHeight);
  pdf.save("retirement-gap-forecaster.pdf");
}

/* =============================== Core Maths =============================== */
type AccumulateArgs = {
  years: number;
  startBalance: number;
  monthlyStart: number;
  escalationPA: number;
  growthPA: number;
  employerMatchPct?: number;
};

type AccumulateResult = { fv: number; series: number[] };

function accumulate({ years, startBalance, monthlyStart, escalationPA, growthPA, employerMatchPct = 0 }: AccumulateArgs): AccumulateResult {
  const months = Math.max(0, Math.round(years * 12));
  let bal = startBalance;
  let mContr = monthlyStart;
  const r = growthPA / 12;
  const perYear: number[] = [];
  for (let m = 1; m <= months; m++) {
    if (m > 1 && (m - 1) % 12 === 0) mContr *= 1 + escalationPA;
    const employer = employerMatchPct * mContr;
    bal = (bal + mContr + employer) * (1 + r);
    if (m % 12 === 0) perYear.push(bal);
  }
  return { fv: bal, series: perYear };
}

type DrawdownArgs = {
  startFV: number;
  startAge: number;
  retireAge: number;
  endAge: number;
  postRetGrowthPA: number;
  cpiPA: number;
  monthlyIncomeTodayR: number;
  capitalNeedsAtRet?: number;
};

type DrawdownPoint = { age: number; balance: number };

function simulateDrawdown({ startFV, startAge, retireAge, endAge, postRetGrowthPA, cpiPA, monthlyIncomeTodayR, capitalNeedsAtRet = 0 }: DrawdownArgs) {
  const monthsToEnd = Math.max(0, Math.round((endAge - retireAge) * 12));
  const growthM = postRetGrowthPA / 12;
  const cpiM = cpiPA / 12;
  let bal = Math.max(0, startFV - capitalNeedsAtRet);
  const pts: DrawdownPoint[] = [];
  let runOutAge: number | null = null;
  for (let m = 0; m <= monthsToEnd; m++) {
    const age = retireAge + m / 12;
    const monthsFromToday = Math.round((retireAge - startAge) * 12) + m;
    const incomeNominal = monthlyIncomeTodayR * Math.pow(1 + cpiM, Math.max(0, monthsFromToday));
    bal *= 1 + growthM;
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

/* ========================== Field Components =========================== */
const INPUT_WIDTH_SHORT = "w-28"; // compact width (~40% narrower)
const INPUT_HEIGHT_SHORT = "h-8";
const INPUT_BASE_SHORT = `${INPUT_WIDTH_SHORT} ${INPUT_HEIGHT_SHORT} rounded-md border border-gray-300 px-2 py-1 text-base text-gray-900 focus:border-teal-500 focus:outline-none justify-self-end`;

const INPUT_WIDTH = "w-48";
const INPUT_HEIGHT = "h-10";
const INPUT_BASE = `${INPUT_WIDTH} ${INPUT_HEIGHT} rounded-md border border-gray-300 px-2 py-1 text-base text-gray-900 focus:border-teal-500 focus:outline-none`;

type FieldCommon = { label: string; small?: boolean; rightAlign?: boolean };

function FieldText({ label, value, onChange, placeholder, small, rightAlign }: FieldCommon & { value: string; onChange: (s: string) => void; placeholder?: string }) {
  return (
    <label className="grid grid-cols-1 sm:grid-cols-2 items-center gap-4 text-sm max-w-full">
      <span className="text-gray-700 whitespace-nowrap text-left">{label}</span>
      <input
        type="text"
        className={`${small ? INPUT_BASE_SHORT : INPUT_BASE} ${rightAlign ? "justify-self-end" : ""}`}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function FieldNumber({ label, value, onChange, disabled = false, small, rightAlign }: FieldCommon & { value: number; onChange: (n: number) => void; disabled?: boolean }) {
  return (
    <label className="grid grid-cols-1 sm:grid-cols-2 items-center gap-4 text-sm max-w-full">
      <span className="text-gray-700 whitespace-nowrap text-left">{label}</span>
      <input
        type="text"
        inputMode="numeric"
        disabled={disabled}
        className={`${small ? INPUT_BASE_SHORT : INPUT_BASE} text-right ${rightAlign ? "justify-self-end" : ""} ${disabled ? "bg-gray-100 text-gray-500 cursor-not-allowed" : ""}`}
        value={Number.isFinite(value) ? Math.trunc(value).toLocaleString("en-ZA") : "0"}
        onChange={(e) => onChange(safeParseNumber(e.target.value))}
      />
    </label>
  );
}

function FieldPercent({ label, value, onChange, small, rightAlign }: FieldCommon & { value: number; onChange: (n: number) => void }) {
  // Show one decimal with ZA locale (comma decimal), e.g. 6,5
  const display = (Number.isFinite(value) ? value * 100 : 0).toLocaleString("en-ZA", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return (
    <label className="grid grid-cols-1 sm:grid-cols-2 items-center gap-2 text-sm max-w-full">
      <span className="text-gray-700 whitespace-nowrap text-left">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        className={`${small ? INPUT_BASE_SHORT : INPUT_BASE} text-right ${rightAlign ? "justify-self-end" : ""}`}
        value={display}
        onChange={(e) => {
          // Accept comma/dot; strip spaces and NBSP
          const raw = e.target.value
            .replaceAll(" ", "")
            .replaceAll("\u00A0", "")
            .replaceAll(",", ".");
          const num = parseFloat(raw);
          onChange(Number.isFinite(num) ? num / 100 : 0);
        }}
      />
    </label>
  );
}

function FieldReadOnly({ label, value, small, rightAlign }: FieldCommon & { value: string }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 items-center gap-4 text-sm max-w-full">
      <span className="text-gray-700 whitespace-nowrap text-left">{label}</span>
      <div className={`${small ? INPUT_BASE_SHORT : INPUT_BASE} text-right bg-teal-50 border-teal-300/70 text-teal-700 ${rightAlign ? "justify-self-end" : ""}`}>{value}</div>
    </div>
  );
}

/* =============================== Charts (SVG) ============================== */
function StackedBarChart({ labels, series, height = 320, pad = { l: 56, r: 16, t: 16, b: 40 } }: { labels: string[]; series: { name: string; color: string; values: number[] }[]; height?: number; pad?: { l: number; r: number; t: number; b: number } }) {
  const width = 920; const { l, r, t, b } = pad; const n = Math.max(1, labels.length); const xw = (width - l - r) / n;
  const maxV = Math.max(1, ...Array.from({ length: n }, (_, i) => series.reduce((s, ser) => s + (ser.values[i] ?? 0), 0)));
  const y = (v: number) => height - b - (v / maxV) * (height - t - b);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full rounded-xl border bg-white">
      <rect x={0} y={0} width={width} height={height} fill="#ffffff" />
      {Array.from({ length: 5 }, (_, i) => { const yy = y((i / 4) * maxV); return <line key={i} x1={l} y1={yy} x2={width - r} y2={yy} stroke="#E5E7EB" />; })}
      {labels.map((_, i) => { const x = l + i * xw + 6; const w = xw - 12; let acc = 0; return (
        <g key={i}>
          {series.map((s, j) => { const v = s.values[i] ?? 0; const yTop = y(acc + v); const h = Math.max(0, y(acc) - yTop); acc += v; return <rect key={j} x={x} y={yTop} width={w} height={h} rx={3} fill={s.color} />; })}
        </g>
      ); })}
      <line x1={l} y1={height - b} x2={width - r} y2={height - b} stroke="#9CA3AF" />
      {labels.map((tLab, i) => (
        <text key={i} x={l + i * xw + xw / 2} y={height - 10} fontSize={12} textAnchor="middle" fill="#374151">{`Age ${tLab}`}</text>
      ))}
    </svg>
  );
}

function DrawdownChart({ implemented, recommended, retireAge, endAge, runOutAgeImplemented = null, runOutAgeRecommended = null, viewAge, height = 340, pad = { l: 60, r: 200, t: 40, b: 50 } }: { implemented?: DrawdownPoint[] | null; recommended?: DrawdownPoint[] | null; retireAge: number; endAge: number; runOutAgeImplemented?: number | null; runOutAgeRecommended?: number | null; viewAge: number; height?: number; pad?: { l: number; r: number; t: number; b: number } }) {
  const impl: DrawdownPoint[] = Array.isArray(implemented) ? implemented : [];
  const reco: DrawdownPoint[] = Array.isArray(recommended) ? recommended : [];
  const width = 920; const { l, r, t, b } = pad; const ageSpan = Math.max(1e-6, endAge - retireAge);
  const x = (age: number) => l + ((age - retireAge) / ageSpan) * (width - l - r);
  const all = [...impl, ...reco]; const maxY = Math.max(1, ...all.map(p => p.balance), 1); const minY = Math.min(0, ...all.map(p => p.balance), 0);
  const y = (v: number) => height - b - ((v - minY) / (maxY - minY || 1)) * (height - t - b);
  const path = (pts: DrawdownPoint[]) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.age)},${y(p.balance)}`).join(" ");
  const ticks: number[] = []; for (let a = Math.ceil(retireAge / 5) * 5; a <= endAge; a += 5) ticks.push(a); if (ticks.length === 0) ticks.push(retireAge, endAge);
  const keep = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
  const marker = (age: number | null, color: string, label: string) => age == null ? null : (
    <g>
      <line x1={x(age)} y1={t} x2={x(age)} y2={height - b} stroke={color} strokeDasharray="5 5" />
      <circle cx={x(age)} cy={y(0)} r={5} fill={color} />
      <text x={keep(x(age) + 8, l + 4, width - r - 120)} y={keep(y(0) - 8, t + 14, height - b - 6)} fontSize={13} fontWeight={500} fill="#111827">{`${label} @ Age ${Math.round(age)}`}</text>
    </g>
  );
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full rounded-xl border bg-white">
      <rect x={0} y={0} width={width} height={height} fill="#ffffff" />
      {ticks.map((ta, i) => (<line key={i} x1={x(ta)} y1={t} x2={x(ta)} y2={height - b} stroke="#F3F4F6" />))}
      <line x1={l} y1={height - b} x2={width - r} y2={height - b} stroke="#9CA3AF" />
      <line x1={l} y1={t} x2={l} y2={height - b} stroke="#9CA3AF" />
      <line x1={l} y1={y(0)} x2={width - r} y2={y(0)} stroke="#D1D5DB" />
      {impl.length > 0 && <path d={path(impl)} fill="none" stroke="#3B82F6" strokeWidth={3} />}
      {reco.length > 0 && <path d={path(reco)} fill="none" stroke="#10B981" strokeWidth={3} />}
      {marker(runOutAgeImplemented, "#3B82F6", "Run-out")}
      {marker(runOutAgeRecommended, "#10B981", "Run-out")}
      <line x1={x(viewAge)} y1={t} x2={x(viewAge)} y2={height - b} stroke="#111827" strokeDasharray="4 4" />
      {ticks.map((ta, i) => (<text key={i} x={x(ta)} y={height - 10} fontSize={13} fontWeight={500} textAnchor="middle" fill="#374151">{`Age ${Math.round(ta)}`}</text>))}
      <g transform={`translate(${width - r - 160},${t + 10})`}>
        <rect width={14} height={14} fill="#3B82F6" />
        <text x={20} y={12} fontSize={13} fill="#111827">Implemented (blue)</text>
        <rect y={22} width={14} height={14} fill="#10B981" />
        <text x={20} y={34} fontSize={13} fill="#111827">Recommended (green)</text>
      </g>
    </svg>
  );
}

/* ================================ Main UI ================================= */
export default function RetirementGapForecaster() {
  // Personal detail
  const [clientName, setClientName] = useState("");
  const [clientSurname, setClientSurname] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [clientMobile, setClientMobile] = useState("");
  const [clientId, setClientId] = useState("");
  const [autoAgeFromId, setAutoAgeFromId] = useState(true);

  const [currentAge, setCurrentAge] = useState(49);
  const [retireAge, setRetireAge] = useState(65);
  const [endAge, setEndAge] = useState(90);

  // Income & capital needs at retirement
  const [capitalNeedsDebt, setCapitalNeedsDebt] = useState(0);
  const [monthlyIncomeTodayR, setMonthlyIncomeTodayR] = useState(55000);

  // Assumptions
  const [growthCompany, setGrowthCompany] = useState(0.085);
  const [growthRA, setGrowthRA] = useState(0.09);
  const [growthOther, setGrowthOther] = useState(0.09);
  const [growthPreserve, setGrowthPreserve] = useState(0.085);
  const [salaryIncrease, setSalaryIncrease] = useState(0.06);
  const [cpi, setCpi] = useState(0.055);
  const [postRetGrowth, setPostRetGrowth] = useState(0.065);

  // Current provisions
  const [companyBal, setCompanyBal] = useState(500000);
  const [companyMonthly, setCompanyMonthly] = useState(9000);
  const [employerMatch, setEmployerMatch] = useState(0);
  const [raBal, setRaBal] = useState(0);
  const [raMonthly, setRaMonthly] = useState(0);
  const [otherBal, setOtherBal] = useState(0);
  const [otherMonthly, setOtherMonthly] = useState(0);
  const [presBal, setPresBal] = useState(0);
  const [presMonthly, setPresMonthly] = useState(0);

  // New provisions
  const [newLump, setNewLump] = useState(0);
  const [newMonthlyEsc, setNewMonthlyEsc] = useState(0.065);
  const [newMonthlyGrowth, setNewMonthlyGrowth] = useState(0.09);
  const [actualNewMonthly, setActualNewMonthly] = useState(20000);

  const yearsToRet = Math.max(0, Math.round(retireAge - currentAge));

  useEffect(() => {
    if (!autoAgeFromId) return;
    const age = ageFromSouthAfricanId(clientId);
    if (age !== null) setCurrentAge(age);
  }, [clientId, autoAgeFromId]);

  // Accumulation for current provisions
  const baseAcc = useMemo(() => {
    const comp = accumulate({ years: yearsToRet, startBalance: companyBal, monthlyStart: companyMonthly, escalationPA: salaryIncrease, growthPA: growthCompany, employerMatchPct: employerMatch });
    const ra = accumulate({ years: yearsToRet, startBalance: raBal, monthlyStart: raMonthly, escalationPA: salaryIncrease, growthPA: growthRA });
    const other = accumulate({ years: yearsToRet, startBalance: otherBal, monthlyStart: otherMonthly, escalationPA: salaryIncrease, growthPA: growthOther });
    const pres = accumulate({ years: yearsToRet, startBalance: presBal, monthlyStart: presMonthly, escalationPA: salaryIncrease, growthPA: growthPreserve });
    const fvBase = comp.fv + ra.fv + other.fv + pres.fv;
    return { comp, ra, other, pres, fvBase };
  }, [yearsToRet, companyBal, companyMonthly, salaryIncrease, growthCompany, employerMatch, raBal, raMonthly, growthRA, otherBal, otherMonthly, growthOther, presBal, presMonthly, growthPreserve]);

  // Auto-solve Recommended new recurring investment
  const recommendedMonthly = useMemo(() => {
    if (monthlyIncomeTodayR <= 0) return 0;
    const solver = (m: number) => {
      const stream = accumulate({ years: yearsToRet, startBalance: newLump, monthlyStart: m, escalationPA: newMonthlyEsc, growthPA: newMonthlyGrowth });
      const startFV = baseAcc.fvBase + stream.fv;
      return simulateDrawdown({ startFV, startAge: currentAge, retireAge, endAge, postRetGrowthPA: postRetGrowth, cpiPA: cpi, monthlyIncomeTodayR, capitalNeedsAtRet: capitalNeedsDebt });
    };
    return solveRecommended(solver, 0, 1_000_000);
  }, [baseAcc.fvBase, yearsToRet, newLump, newMonthlyEsc, newMonthlyGrowth, currentAge, retireAge, endAge, postRetGrowth, cpi, monthlyIncomeTodayR, capitalNeedsDebt]);

  // New contributions accumulation
  const newAccActual = useMemo(() => accumulate({ years: yearsToRet, startBalance: newLump, monthlyStart: actualNewMonthly, escalationPA: newMonthlyEsc, growthPA: newMonthlyGrowth }), [yearsToRet, newLump, actualNewMonthly, newMonthlyEsc, newMonthlyGrowth]);
  const newAccReco = useMemo(() => accumulate({ years: yearsToRet, startBalance: newLump, monthlyStart: recommendedMonthly, escalationPA: newMonthlyEsc, growthPA: newMonthlyGrowth }), [yearsToRet, newLump, recommendedMonthly, newMonthlyEsc, newMonthlyGrowth]);

  // Totals at retirement (Implemented/Actual)
  const fvAtRetActual = baseAcc.fvBase + newAccActual.fv;
  const pvAtRetImplemented = toPV(fvAtRetActual, retireAge - currentAge, cpi);

  // Drawdown series
  const drawImpl = useMemo(() => simulateDrawdown({ startFV: fvAtRetActual, startAge: currentAge, retireAge, endAge, postRetGrowthPA: postRetGrowth, cpiPA: cpi, monthlyIncomeTodayR, capitalNeedsAtRet: capitalNeedsDebt }), [fvAtRetActual, currentAge, retireAge, endAge, postRetGrowth, cpi, monthlyIncomeTodayR, capitalNeedsDebt]);
  const fvAtRetReco = baseAcc.fvBase + newAccReco.fv;
  const drawReco = useMemo(() => simulateDrawdown({ startFV: fvAtRetReco, startAge: currentAge, retireAge, endAge, postRetGrowthPA: postRetGrowth, cpiPA: cpi, monthlyIncomeTodayR, capitalNeedsAtRet: capitalNeedsDebt }), [fvAtRetReco, currentAge, retireAge, endAge, postRetGrowth, cpi, monthlyIncomeTodayR, capitalNeedsDebt]);

  // View-at-age marker
  const [viewAge, setViewAge] = useState<number>(() => clamp(endAge, retireAge, endAge));
  useEffect(() => { setViewAge(clamp(endAge, retireAge, endAge)); }, [endAge, retireAge]);

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

  return (
    <div className="min-h-screen bg-white text-gray-900 font-sans" id="print-area">
      <div className="mx-auto max-w-7xl space-y-8 px-4 py-8">
        {/* Header */}
        <header className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-medium">Retirement Gap Forecaster</h1>
            <div className="flex flex-wrap items-center gap-2 print:hidden">
              <button type="button" className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50" onClick={resetAll}>Reset info</button>
              <button type="button" className="rounded-xl bg-teal-600 px-3 py-2 text-sm font-medium text-white hover:bg-teal-700" onClick={() => exportMainToPdf()}>Print / Save PDF</button>
            </div>
          </div>
        </header>

        {/* Personal + Income */}
        <section className="grid grid-cols-1 gap-4 md:grid-cols-2 rounded-2xl border border-gray-200 p-6 shadow-sm bg-white">
          {/* Personal detail */}
          <div>
            <h2 className="mb-3 text-lg font-medium text-gray-800">Personal detail</h2>
            <div className="grid grid-cols-1 gap-y-4">
              <FieldText label="Client Name" value={clientName} onChange={setClientName} small />
              <FieldText label="Surname" value={clientSurname} onChange={setClientSurname} small />
              <FieldText label="Email" value={clientEmail} onChange={setClientEmail} small />
              <FieldText label="Mobile" value={clientMobile} onChange={setClientMobile} small />
              <FieldText label="ID Number" value={clientId} onChange={setClientId} small />
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={autoAgeFromId} onChange={(e) => setAutoAgeFromId(e.target.checked)} /><span className="text-gray-700">Auto‑calculate age from ID</span></label>
              <FieldNumber label="Current age" value={currentAge} onChange={setCurrentAge} disabled={autoAgeFromId} />
              <FieldNumber label="Retirement age" value={retireAge} onChange={setRetireAge} />
            </div>
          </div>
          {/* Income & capital needs */}
          <div>
            <h2 className="mb-3 text-lg font-medium text-gray-800">Income and capital needs at retirement</h2>
            <div className="grid grid-cols-1 gap-y-4">
              <FieldNumber label="Capital needs & debt at retirement (R)" value={capitalNeedsDebt} onChange={setCapitalNeedsDebt} />
              <FieldNumber label="Monthly income (today’s R)" value={monthlyIncomeTodayR} onChange={setMonthlyIncomeTodayR} />
              <FieldNumber label="Income required to age" value={endAge} onChange={setEndAge} />
            </div>
          </div>
        </section>

        {/* Current vs New provisions */}
        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-gray-200 p-6 shadow-sm bg-white">
            <h3 className="mb-3 text-lg font-medium text-gray-800">Current provisions</h3>
            <div className="grid grid-cols-1 gap-y-4 max-w-full">
              <FieldNumber small rightAlign label="Company – current balance (R)" value={companyBal} onChange={setCompanyBal} />
              <FieldNumber small rightAlign label="Company – monthly contribution (R)" value={companyMonthly} onChange={setCompanyMonthly} />
              <FieldNumber small rightAlign label="RA + recurring – current balance (R)" value={raBal} onChange={setRaBal} />
              <FieldNumber small rightAlign label="RA + recurring – monthly (R)" value={raMonthly} onChange={setRaMonthly} />
              <FieldNumber small rightAlign label="Other – current balance (R)" value={otherBal} onChange={setOtherBal} />
              <FieldNumber small rightAlign label="Other – monthly (R)" value={otherMonthly} onChange={setOtherMonthly} />
              <FieldNumber small rightAlign label="Preservation – current balance (R)" value={presBal} onChange={setPresBal} />
              <FieldNumber small rightAlign label="Preservation – monthly (R)" value={presMonthly} onChange={setPresMonthly} />
            </div>
          </div>
          <div className="rounded-2xl border border-gray-200 p-6 shadow-sm bg-white">
            <h3 className="mb-3 text-lg font-medium text-gray-800">New provisions</h3>
            <div className="grid grid-cols-1 gap-y-4 max-w-full">
              <FieldNumber small rightAlign label="New lump sum (once‑off) (R)" value={newLump} onChange={setNewLump} />
              <FieldReadOnly small rightAlign label="Recommended new recurring investment (auto) (R)" value={fmtZARWhole.format(recommendedMonthly)} />
              <FieldNumber small rightAlign label="Actual new recurring investment (R)" value={actualNewMonthly} onChange={setActualNewMonthly} />
              <FieldPercent small rightAlign label="Annual increase of new investment (%)" value={newMonthlyEsc} onChange={setNewMonthlyEsc} />
              <FieldPercent small rightAlign label="Fund growth of this new investment (%)" value={newMonthlyGrowth} onChange={setNewMonthlyGrowth} />
            </div>
          </div>
        </section>

        {/* Assumptions (collapsed by default, two columns) */}
        <section className="rounded-2xl border border-gray-200 p-6 shadow-sm bg-white">
          <details className="w-full">{/* collapsed by default */}
            <summary className="cursor-pointer mb-3 text-lg font-medium text-gray-800">Assumptions</summary>
            <div className="grid grid-cols-1 gap-y-3 md:grid-cols-2 gap-x-6 max-w-full">
              <FieldPercent small rightAlign label="Expected salary increases p.a. (%)" value={salaryIncrease} onChange={setSalaryIncrease} />
              <FieldPercent small rightAlign label="Consumer price index p.a. (%)" value={cpi} onChange={setCpi} />
              <FieldPercent small rightAlign label="Return on capital after retirement p.a. (%)" value={postRetGrowth} onChange={setPostRetGrowth} />
              <FieldPercent small rightAlign label="Growth of company fund p.a. (%)" value={growthCompany} onChange={setGrowthCompany} />
              <FieldPercent small rightAlign label="Growth of RA + recurring p.a. (%)" value={growthRA} onChange={setGrowthRA} />
              <FieldPercent small rightAlign label="Growth of other provisions p.a. (%)" value={growthOther} onChange={setGrowthOther} />
              <FieldPercent small rightAlign label="Growth of preservation fund p.a. (%)" value={growthPreserve} onChange={setGrowthPreserve} />
            </div>
          </details>
        </section>

        {/* Charts */}
        <section className="grid grid-cols-1 gap-8 lg:grid-cols-2">
          {/* Build‑up */}
          <div className="rounded-2xl border border-gray-200 p-6 shadow-sm bg-white">
            <h3 className="mb-2 text-lg font-medium text-gray-800">Capital build‑up to retirement</h3>
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
            {/* One-line legend */}
            <div className="mt-3 flex flex-nowrap items-end justify-between gap-5 text-sm text-gray-700">
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
            {/* Outputs */}
            <div className="mt-4 grid grid-cols-1 gap-2 text-sm text-gray-700">
              <div className="rounded-xl border border-gray-200 p-4">
                <div className="text-xs text-gray-500">{`Retirement capital at age ${Math.round(retireAge)} (FV)`}</div>
                <div className="text-xl font-semibold">{fmtZARWhole.format(fvAtRetActual)}</div>
              </div>
              <div className="rounded-xl border border-gray-200 p-4">
                <div className="text-xs text-gray-500">{`Retirement capital at age ${Math.round(retireAge)} (PV today’s R)`}</div>
                <div className="text-xl font-semibold">{fmtZARWhole.format(pvAtRetImplemented)}</div>
              </div>
            </div>
          </div>

          {/* Drawdown */}
          <div className="rounded-2xl border border-gray-200 p-6 shadow-sm bg-white">
            <h3 className="mb-2 text-lg font-medium text-gray-800">Capital balance (cash or near cash) after retirement</h3>
            <DrawdownChart
              implemented={drawImpl.points}
              recommended={drawReco.points}
              retireAge={retireAge}
              endAge={endAge}
              runOutAgeImplemented={drawImpl.runOutAge}
              runOutAgeRecommended={drawReco.runOutAge}
              viewAge={viewAge}
            />
            <div className="mt-3 rounded-xl bg-gray-100 px-4 py-2 text-sm font-medium text-gray-800">
              Capital Balance lines: Blue = Implemented (Actual), Green = Recommended. Dashed line shows the selected "View at age".
            </div>
            {/* View at age slider */}
            <div className="mt-4">
              <div className="mb-1 flex items-center justify-between text-sm text-gray-600">
                <span>View at age</span>
                <span className="font-medium text-gray-800">Age {Math.round(viewAge)}</span>
              </div>
              <input
                type="range"
                min={retireAge}
                max={endAge}
                step={1}
                value={viewAge}
                onChange={(e) => setViewAge(clamp(safeParseNumber(e.target.value), retireAge, endAge))}
                className="w-full"
              />
            </div>
          </div>
        </section>

        <p className="text-xs text-gray-500">Illustrative projections only; not financial advice. Ensure FAIS/FSCA compliance and handle personal data per POPIA.</p>
      </div>
    </div>
  );
}
