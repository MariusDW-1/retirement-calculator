import { useMemo, useState, type ReactNode, useEffect, useRef } from "react";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";

/** ================= Utilities ================= */
function parseNum(v: string | number) {
  if (typeof v === "number") return v;
  const s = (v ?? "").toString().trim();
  const hasDot = s.includes(".");
  const hasComma = s.includes(",");
  let norm = s.replace(/[^0-9.,-]/g, "");
  if (hasDot && hasComma) {
    if (norm.lastIndexOf(",") > norm.lastIndexOf(".")) {
      norm = norm.replace(/\./g, "").replace(/,/g, ".");
    } else {
      norm = norm.replace(/,/g, "");
    }
  } else if (hasComma && !hasDot) {
    norm = norm.replace(/\./g, "").replace(/,/g, ".");
  } else {
    norm = norm.replace(/,/g, "");
  }
  const n = parseFloat(norm);
  return isNaN(n) ? 0 : n;
}
function safeNum(x: unknown, fallback = 0): number {
  const n = typeof x === "number" ? x : parseFloat(String(x ?? NaN));
  return Number.isFinite(n) ? n : fallback;
}
// Display helpers: NO decimals, SA locale commas only
const fmtR0 = (x: number | null | undefined) => {
  const n = safeNum(x, 0);
  return `R ${n.toLocaleString("en-ZA", { maximumFractionDigits: 0 })}`;
};
function toMoneyStr(n: number) { return safeNum(n, 0).toLocaleString("en-ZA", { maximumFractionDigits: 0 }); }
function toYearsStr(n: number) { return safeNum(n, 0).toLocaleString("en-ZA", { maximumFractionDigits: 0 }); }

// Sanitise modern colour functions (e.g. OKLCH) to safe RGB before rasterising
function sanitizeCssColor(v: string | null): string {
  if (!v) return "";
  return v
    .replace(/oklch\([^)]*\)/gi, "rgb(17,24,39)")
    .replace(/oklab\([^)]*\)/gi, "rgb(17,24,39)")
    .replace(/color\([^)]*\)/gi, "rgb(17,24,39)");
}

/** ================= Financial Maths ================= */
// Lump sum compounded monthly: FV = PV*(1 + r/12)^(months)
function fvLumpMonthly(pv: number, annualR: number, months: number) {
  const i = annualR / 12;
  return pv * Math.pow(1 + i, months);
}
// Ordinary annuity (with option to switch to annuity-due by multiplying (1+i))
function fvOrdinaryAnnuityMonthly(P: number, annualR: number, years: number, timing: "end" | "begin") {
  if (P <= 0 || years <= 0) return 0;
  const r = annualR; const m = 12; const i = r / m; const n = years * m;
  const fv = P * ((Math.pow(1 + i, n) - 1) / i);
  return timing === "begin" ? fv * (1 + i) : fv;
}
// Escalating annual contributions: sum_t C_t*(1+r)^(n-t)
function fvEscalatingAnnualContrib(P0Monthly: number, annualR: number, annualG: number, years: number) {
  if (P0Monthly <= 0 || years <= 0) return 0;
  let total = 0;
  for (let t = 1; t <= years; t++) {
    const annualContrib = P0Monthly * 12 * Math.pow(1 + annualG, t - 1);
    const growYears = years - t + 1; // end-of-year to maturity
    total += annualContrib * Math.pow(1 + annualR, growYears);
  }
  return total;
}

/** ================= Types & Defaults ================= */
type Mode = "lump" | "monthly" | "lump_plus_monthly";
type Timing = "end" | "begin";
type InvestmentType = "Type" | "TFSA" | "Unit Trust" | "ETF" | "Fixed Deposit" | "Endowment" | "Other";

interface ClientInfo { name: string; surname: string; email: string; mobile: string; idNumber: string; }
interface Inputs {
  client: ClientInfo; ageManual: number | null;
  investmentType: InvestmentType;
  mode: Mode; lumpSum: number; monthlyContribution: number; years: number; targetAmountTodayR: number;
  nominalReturnPA: number; inflationPA: number; contribEscalationPA: number; timing: Timing;
  hasTarget: boolean;
}

const INVESTMENT_HELP: Record<InvestmentType, string> = {
  Type: "Select the type of investment.",
  TFSA: "Tax-free investment; SARS annual/lifetime contribution limits apply.",
  "Unit Trust": "Collective investment scheme (pooled funds). Capital gains/dividends taxable.",
  ETF: "Exchange-traded fund tracking an index or theme. Market risk applies.",
  "Fixed Deposit": "Bank deposit with fixed term/rate; limited liquidity; interest taxable.",
  Endowment: "Policy wrapper with 5-year restriction; tax handled within the fund.",
  Other: "Custom product. Confirm fees, liquidity, and tax treatment.",
};

function defaultInputs(): Inputs {
  return {
    client: { name: "", surname: "", email: "", mobile: "", idNumber: "" },
    ageManual: 0,
    investmentType: "Type", // mandatory default
    mode: "lump_plus_monthly",
    lumpSum: 0,
    monthlyContribution: 0,
    years: 1, // mandatory >= 1
    targetAmountTodayR: 0,
    nominalReturnPA: 0.08,      // 8%
    inflationPA: 0.055,         // 5.5%
    contribEscalationPA: 0.10,  // 10%
    timing: "end",
    hasTarget: false,
  };
}

/** ================= Component ================= */
export default function InvestmentCalculator() {
  const [inp, setInp] = useState<Inputs>(defaultInputs());
  const [lumpStr, setLumpStr] = useState<string>(toMoneyStr(0));
  const [monthlyStr, setMonthlyStr] = useState<string>(toMoneyStr(0));
  const [yearsStr, setYearsStr] = useState<string>(toYearsStr(1));
  const [typeTouched, setTypeTouched] = useState(false);
  const [yearsTouched, setYearsTouched] = useState(false);
  const printRef = useRef<HTMLDivElement | null>(null);

  // Validations
  const isTypeValid = inp.investmentType !== "Type";
  const isYearsValid = (inp.years ?? 0) >= 1;

  // PDF export (html2canvas + jsPDF) with OKLCH sanitisation
  const handlePrint = async () => {
    if (!printRef.current) return;
    const sandbox = document.createElement('div');
    sandbox.style.position = 'fixed';
    sandbox.style.left = '-10000px';
    sandbox.style.top = '0';
    sandbox.style.width = (printRef.current.clientWidth || 1024) + 'px';
    sandbox.style.background = '#ffffff';

    const style = document.createElement('style');
    style.textContent = `:root,*{--tw-ring-color: rgba(59,130,246,0.5);--tw-ring-offset-shadow:0 0 #0000;--tw-ring-shadow:0 0 #0000;--tw-shadow:0 0 #0000;--tw-shadow-colored:0 0 #0000;}`;
    sandbox.appendChild(style);

    const src = printRef.current;
    const clone = src.cloneNode(true) as HTMLElement;
    sandbox.appendChild(clone);
    document.body.appendChild(sandbox);

    // Inline key computed styles with RGB fallbacks
    const origEls = src.querySelectorAll('*');
    const cloneEls = clone.querySelectorAll('*');
    const len = Math.min(origEls.length, cloneEls.length);
    for (let i = 0; i < len; i++) {
      const o = origEls[i] as HTMLElement;
      const c = cloneEls[i] as HTMLElement;
      const cs = getComputedStyle(o);
      c.style.display = cs.display;
      c.style.position = cs.position;
      c.style.margin = cs.margin;
      c.style.padding = cs.padding;
      (c.style as any).gap = (cs as any).gap || '';
      c.style.borderWidth = cs.borderWidth;
      c.style.borderStyle = cs.borderStyle;
      c.style.borderColor = sanitizeCssColor(cs.borderColor);
      c.style.borderRadius = cs.borderRadius;
      c.style.backgroundColor = sanitizeCssColor(cs.backgroundColor);
      c.style.color = sanitizeCssColor(cs.color);
      c.style.font = cs.font;
      c.style.textAlign = cs.textAlign;
      c.style.boxShadow = 'none';
      c.style.textShadow = 'none';
      c.style.outlineColor = sanitizeCssColor(cs.outlineColor);
    }

    try {
      const canvas = await html2canvas(clone, {
        backgroundColor: '#ffffff',
        scale: 2,
        useCORS: true,
        onclone: (doc) => {
          doc.querySelectorAll('style').forEach(st => {
            if (st.textContent && /oklch\(/i.test(st.textContent)) {
              st.textContent = st.textContent.replace(/oklch\([^)]*\)/gi, 'rgb(17,24,39)');
            }
          });
        },
      });
      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const imgProps = pdf.getImageProperties(imgData);
      const ratio = Math.min(pageWidth / imgProps.width, (pageHeight - 24) / imgProps.height);
      const imgW = imgProps.width * ratio;
      const imgH = imgProps.height * ratio;
      const x = (pageWidth - imgW) / 2;
      const y = 12;
      pdf.addImage(imgData, 'PNG', x, y, imgW, imgH);
      pdf.save('SmartPlan-Investment-Report.pdf');
    } finally {
      try { document.body.removeChild(sandbox); } catch {}
    }
  };

  // Clear Info -> resets to defaults and clears touched state
  const handleClearInfo = () => {
    setInp(defaultInputs());
    setLumpStr(toMoneyStr(0));
    setMonthlyStr(toMoneyStr(0));
    setYearsStr(toYearsStr(1));
    setTypeTouched(false);
    setYearsTouched(false);
  };

  // Seed string inputs once on mount and run tests
  useEffect(() => {
    setLumpStr(toMoneyStr(inp.lumpSum));
    setMonthlyStr(toMoneyStr(inp.monthlyContribution));
    setYearsStr(toYearsStr(inp.years));
    // Tests / sanity checks
    try {
      console.assert(Math.abs(fvLumpMonthly(1000, 0.12, 12) - 1000*Math.pow(1+0.12/12,12)) < 1e-6, "fvLumpMonthly");
      const i = 0.1/12; const endFV = fvOrdinaryAnnuityMonthly(1000, 0.1, 1, 'end'); const beginFV = fvOrdinaryAnnuityMonthly(1000, 0.1, 1, 'begin');
      console.assert(Math.abs(beginFV - endFV*(1+i)) < 1e-6, "annuity due relation");
      console.assert(parseNum('1,500,000') === 1500000, 'parse thousands');
      console.assert(parseNum('900,000,000') === 900000000, 'parse hundreds of millions');
      // Additional: check escalating reduces to ordinary when g=0
      const a = fvEscalatingAnnualContrib(1000, 0.1, 0, 1);
      console.assert(Math.abs(a - (1000*12)*Math.pow(1+0.1,1)) < 1e-6, 'escalating g=0 base year');
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const months = Math.max(0, Math.round((inp.years || 0) * 12));

  /** -------- Results -------- */
  const results = useMemo(() => {
    const r = inp.nominalReturnPA; const g = inp.contribEscalationPA;
    const fvLump = inp.mode !== 'monthly' ? fvLumpMonthly(Math.max(0, inp.lumpSum || 0), r, months) : 0;
    let fvContrib = 0;
    if (inp.mode !== 'lump') {
      if (g > 0) fvContrib = fvEscalatingAnnualContrib(Math.max(0, inp.monthlyContribution || 0), r, g, inp.years);
      else fvContrib = fvOrdinaryAnnuityMonthly(Math.max(0, inp.monthlyContribution || 0), r, inp.years, inp.timing);
    }
    const projectedNominal = fvLump + fvContrib;

    // Series (yearly)
    const seriesLump: number[] = [];
    const seriesContrib: number[] = [];
    const yrs = Math.max(1, Math.floor(inp.years));
    for (let y = 0; y <= yrs; y++) {
      seriesLump.push(fvLumpMonthly(Math.max(0, inp.lumpSum || 0), r, y * 12));
      seriesContrib.push(g > 0
        ? fvEscalatingAnnualContrib(Math.max(0, inp.monthlyContribution || 0), r, g, y)
        : fvOrdinaryAnnuityMonthly(Math.max(0, inp.monthlyContribution || 0), r, y, inp.timing)
      );
    }
    return { projectedNominal, fvLump, fvContrib, seriesLump, seriesContrib };
  }, [inp, months]);

  /** -------- Chart geometry (labels inside frame) -------- */
  const chart = useMemo(() => {
    const w = 920, h = 400, pad = 56, rightPad = 240;
    const lump = results.seriesLump; const contrib = results.seriesContrib;
    const total = lump.map((v, i) => v + (contrib[i] || 0));
    const n = Math.max(2, lump.length);
    const maxY = Math.max(1, ...total);
    const step = Math.max(500000, Math.pow(10, Math.floor(Math.log10(maxY)) - 1));
    const niceMax = Math.ceil(maxY / step) * step;
    const sx = (i: number) => pad + (i / (n - 1)) * (w - pad - rightPad);
    const sy = (v: number) => h - pad - (v / niceMax) * (h - pad * 2);
    const clampY = (y: number) => Math.min(h - pad - 8, Math.max(pad + 8, y));
    const buildPath = (arr: number[]) => arr.map((vv, ii) => `${ii === 0 ? 'M' : 'L'} ${sx(ii)} ${sy(vv)}`).join(' ');

    const yTickCount = Math.max(3, Math.min(8, Math.round(niceMax / step)));
    const ticks: { y: number; label: string }[] = [];
    for (let k = 0; k <= yTickCount; k++) {
      const val = (niceMax / yTickCount) * k;
      ticks.push({ y: sy(val), label: fmtR0(val) });
    }

    const i = n - 1; const xEnd = sx(i);
    const yT0 = clampY(sy(total[i] || 0));
    let yL0 = clampY(sy(lump[i] || 0));
    let yC0 = clampY(sy(contrib[i] || 0));
    const sep = 16;
    if (Math.abs(yL0 - yT0) < sep) yL0 = yT0 + sep;
    if (Math.abs(yC0 - yT0) < sep) yC0 = yT0 - sep;
    if (Math.abs(yL0 - yC0) < sep) yC0 = yL0 - sep;

    return {
      w, h, pad, rightPad, sx, sy, ticks,
      pathLump: buildPath(lump),
      pathContrib: buildPath(contrib),
      pathTotal: buildPath(total),
      xEnd,
      yTotal: yT0,
      yLump: yL0,
      yContrib: yC0,
      endValues: { total: total[i] || 0, lump: lump[i] || 0, contrib: contrib[i] || 0 },
    };
  }, [results]);

  /** -------- Helpers -------- */
  const field = (label: string, children: ReactNode) => (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-gray-700">{label}</span>
      {children}
    </label>
  );

  // Handlers for free-typing fields (commas allowed)
  const onLumpChange = (s: string) => { setLumpStr(s); setInp(v => ({ ...v, lumpSum: Math.max(0, parseNum(s)) })); };
  const onLumpBlur = () => setLumpStr(toMoneyStr(inp.lumpSum));
  const onMonthlyChange = (s: string) => { setMonthlyStr(s); setInp(v => ({ ...v, monthlyContribution: Math.max(0, parseNum(s)) })); };
  const onMonthlyBlur = () => setMonthlyStr(toMoneyStr(inp.monthlyContribution));
  const onYearsChange = (s: string) => { setYearsStr(s); setInp(v => ({ ...v, years: Math.max(0, parseNum(s)) })); };
  const onYearsBlur = () => { setYearsTouched(true); setYearsStr(toYearsStr(inp.years)); };

  return (
    <div className="min-h-screen bg-white text-gray-900">
      <div className="mx-auto max-w-7xl px-4 py-8" id="print-root" ref={printRef}>
        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-semibold">SmartPlan – Investment Calculator</h1>
          <div className="rounded-full bg-teal-600 px-4 py-1 text-sm font-medium text-white">South Africa</div>
        </header>

        {/* Actions */}
        <div className="mb-4 flex flex-wrap gap-2 no-print">
          <button onClick={handleClearInfo} className="rounded-xl border px-3 py-2 text-sm">Clear Info</button>
          <button onClick={handlePrint} className="rounded-xl border px-3 py-2 text-sm" disabled={!isTypeValid || !isYearsValid} title={!isTypeValid ? 'Select Investment Type' : !isYearsValid ? 'Years must be at least 1' : 'Download PDF'}>Download PDF</button>
          <button onClick={() => window.print()} className="rounded-xl border px-3 py-2 text-sm">Browser Print</button>
        </div>

        {/* Client Details */}
        <section className="rounded-2xl border p-6 shadow-sm mb-6">
          <h2 className="mb-4 text-lg font-semibold">Client Details</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {field("Name", <input className="rounded-xl border p-2" value={inp.client.name} onChange={e=>setInp(v=>({...v, client:{...v.client, name:e.target.value}}))} />)}
            {field("Surname", <input className="rounded-xl border p-2" value={inp.client.surname} onChange={e=>setInp(v=>({...v, client:{...v.client, surname:e.target.value}}))} />)}
            {field("Email", <input className="rounded-xl border p-2" value={inp.client.email} onChange={e=>setInp(v=>({...v, client:{...v.client, email:e.target.value}}))} />)}
            {field("Mobile", <input className="rounded-xl border p-2" value={inp.client.mobile} onChange={e=>setInp(v=>({...v, client:{...v.client, mobile:e.target.value}}))} />)}
            {field("South African ID (13 digits)", <input className="rounded-xl border p-2" value={inp.client.idNumber} onChange={e=>setInp(v=>({...v, client:{...v.client, idNumber:e.target.value.replace(/\D/g, '').slice(0,13)}}))} />)}
          </div>
        </section>

        {/* Assumptions */}
        <section className="rounded-2xl border p-6 shadow-sm mb-6">
          <h2 className="mb-4 text-lg font-semibold">Assumptions</h2>

          {/* Investment Type (same size as others; red only after touch if invalid) */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 mb-3">
            {field("Investment Type",
              <>
                <select
                  required
                  className={`rounded-xl border p-2 ${!isTypeValid && typeTouched ? 'border-red-500' : ''}`}
                  title={INVESTMENT_HELP[inp.investmentType]}
                  value={inp.investmentType}
                  onChange={e=>{ setTypeTouched(true); setInp(v=>({...v, investmentType: e.target.value as InvestmentType})); }}
                >
                  <option value="Type">Type</option>
                  <option value="TFSA">TFSA</option>
                  <option value="Unit Trust">Unit Trust</option>
                  <option value="ETF">ETF</option>
                  <option value="Fixed Deposit">Fixed Deposit</option>
                  <option value="Endowment">Endowment</option>
                  <option value="Other">Other</option>
                </select>
                {!isTypeValid && typeTouched && <div className="mt-1 text-xs text-red-600">Please select an investment type.</div>}
                <div className="mt-1 text-xs text-gray-600">{INVESTMENT_HELP[inp.investmentType]}</div>
              </>
            )}

            {/* Years (mandatory, red only after touch) */}
            {field("Years",
              <div>
                <input
                  type="text"
                  className={`rounded-xl border p-2 w-full ${((inp.years ?? 0) < 1 && yearsTouched) ? 'border-red-500' : ''}`}
                  value={yearsStr}
                  onChange={e=>{ setYearsStr(e.target.value); setInp(v=>({ ...v, years: Math.max(0, parseNum(e.target.value)) })); }}
                  onBlur={()=>{ setYearsTouched(true); setYearsStr(toYearsStr(inp.years)); }}
                  placeholder="e.g. 15"
                />
                {((inp.years ?? 0) < 1 && yearsTouched) && <div className="mt-1 text-xs text-red-600">Years must be at least 1.</div>}
              </div>
            )}
          </div>

          {/* Mode selector */}
          <div className="mb-3 flex flex-wrap gap-2">
            <button className={`rounded-xl px-3 py-1 text-sm ${inp.mode === 'lump' ? 'bg-teal-600 text-white' : 'bg-gray-100'}`} onClick={() => setInp(v => ({ ...v, mode: 'lump' }))}>Lump sum only</button>
            <button className={`rounded-xl px-3 py-1 text-sm ${inp.mode === 'monthly' ? 'bg-teal-600 text-white' : 'bg-gray-100'}`} onClick={() => setInp(v => ({ ...v, mode: 'monthly' }))}>Monthly only</button>
            <button className={`rounded-xl px-3 py-1 text-sm ${inp.mode === 'lump_plus_monthly' ? 'bg-teal-600 text-white' : 'bg-gray-100'}`} onClick={() => setInp(v => ({ ...v, mode: 'lump_plus_monthly' }))}>Lump sum + monthly</button>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {inp.mode !== "monthly" && field("Lump Sum (R)",
              <input type="text" className="rounded-xl border p-2" value={lumpStr} onChange={e=>onLumpChange(e.target.value)} onBlur={onLumpBlur} placeholder="e.g. 500,000" />
            )}
            {inp.mode !== "lump" && field("Monthly Contribution (R)",
              <input type="text" className="rounded-xl border p-2" value={monthlyStr} onChange={e=>onMonthlyChange(e.target.value)} onBlur={onMonthlyBlur} placeholder="e.g. 10,000" />
            )}

            {/* Contribution Timing */}
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-gray-700">Contribution Timing</span>
              <div className="flex gap-2">
                <button className={`rounded-xl px-3 py-1 text-sm ${inp.timing === 'end' ? 'bg-teal-600 text-white' : 'bg-gray-100'}`} onClick={()=>setInp(v=>({...v, timing: 'end'}))}>End of month</button>
                <button className={`rounded-xl px-3 py-1 text-sm ${inp.timing === 'begin' ? 'bg-teal-600 text-white' : 'bg-gray-100'}`} onClick={()=>setInp(v=>({...v, timing: 'begin'}))}>Start of month</button>
              </div>
            </label>

            {field("Contribution Escalation (% p.a.)",
              <input type="number" step="0.1" className="rounded-xl border p-2" value={(safeNum(inp.contribEscalationPA*100, 0)).toString()} onChange={e=>setInp(v=>({...v, contribEscalationPA: parseNum(e.target.value)/100}))} />
            )}
            {field("Expected Return (% p.a.)",
              <input type="number" step="0.1" className="rounded-xl border p-2" value={(safeNum(inp.nominalReturnPA*100, 0)).toString()} onChange={e=>setInp(v=>({...v, nominalReturnPA: parseNum(e.target.value)/100}))} />
            )}
            {field("Inflation (CPI, % p.a.)",
              <input type="number" step="0.1" className="rounded-xl border p-2" value={(safeNum(inp.inflationPA*100, 0)).toString()} onChange={e=>setInp(v=>({...v, inflationPA: parseNum(e.target.value)/100}))} />
            )}
          </div>
        </section>

        {/* Results */}
        <section className="rounded-2xl border p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold">Results</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="rounded-xl border p-4">
              <div className="text-xs text-gray-500">Maturity (Nominal)</div>
              <div className="text-xl font-semibold">{fmtR0(results.projectedNominal)}</div>
            </div>
            <div className="rounded-xl border p-4">
              <div className="text-xs text-gray-500">From Lump / Monthly</div>
              <div className="text-xl font-semibold">{fmtR0(results.fvLump)} / {fmtR0(results.fvContrib)}</div>
            </div>
          </div>

          {/* Growth chart (inside frame; end labels non-overlapping) */}
          <div className="mt-6">
            <h3 className="mb-2 text-sm font-medium">Growth Over Time</h3>
            <svg width="100%" viewBox={`0 0 ${chart.w} ${chart.h}`} className="rounded-xl border bg-white">
              <g>
                {chart.ticks.map((t, idx) => (
                  <g key={idx}>
                    <line x1={56} y1={t.y} x2={chart.w - chart.rightPad} y2={t.y} stroke="#e5e7eb" />
                    <text x={46} y={t.y} textAnchor="end" dominantBaseline="middle" fontSize="11" fill="#6B7280">{t.label}</text>
                  </g>
                ))}

                {/* lines */}
                <path d={chart.pathLump} fill="none" stroke="#10b981" strokeWidth="2.5" />
                <path d={chart.pathContrib} fill="none" stroke="#3b82f6" strokeWidth="2.5" strokeDasharray="6 4" />
                <path d={chart.pathTotal} fill="none" stroke="#111827" strokeWidth="3" />

                {/* end dots & labels */}
                <circle cx={chart.xEnd} cy={chart.yTotal} r={4} fill="#111827" />
                <circle cx={chart.xEnd} cy={chart.yLump} r={3} fill="#10b981" />
                <circle cx={chart.xEnd} cy={chart.yContrib} r={3} fill="#3b82f6" />
                <text x={chart.w - chart.rightPad + 8} y={chart.yTotal} fontSize="12" fill="#111827">Total: {fmtR0(chart.endValues.total)}</text>
                <text x={chart.w - chart.rightPad + 8} y={chart.yLump} fontSize="12" fill="#047857">Lump: {fmtR0(chart.endValues.lump)}</text>
                <text x={chart.w - chart.rightPad + 8} y={chart.yContrib} fontSize="12" fill="#1d4ed8">Contrib: {fmtR0(chart.endValues.contrib)}</text>

                {/* x-axis ticks (0, mid, end) */}
                {(() => {
                  const n = results.seriesLump.length;
                  const years = Math.max(1, Math.floor(inp.years));
                  const midIndex = Math.round((n - 1) / 2);
                  const tick = (i: number, label: string) => (
                    <g key={`x${i}`}>
                      <line x1={chart.sx(i)} y1={chart.h - chart.pad} x2={chart.sx(i)} y2={chart.h - chart.pad + 4} stroke="#9ca3af" />
                      <text x={chart.sx(i)} y={chart.h - chart.pad + 16} textAnchor="middle" fontSize="11" fill="#6b7280">{label}</text>
                    </g>
                  );
                  return (
                    <g>
                      {tick(0, '0y')}
                      {tick(midIndex, `${Math.max(0, Math.floor(years / 2))}y`)}
                      {tick(n - 1, `${years}y`)}
                    </g>
                  );
                })()}
              </g>
            </svg>

            {/* Legend */}
            <div className="mt-2 flex items-center gap-6 text-sm">
              <div className="flex items-center gap-2"><span className="inline-block h-2 w-6 rounded" style={{background:'#111827'}} /> <span>Total</span></div>
              <div className="flex items-center gap-2"><span className="inline-block h-2 w-6 rounded" style={{background:'#10b981'}} /> <span>Lump</span></div>
              <div className="flex items-center gap-2"><span className="inline-block h-2 w-6 rounded border border-dashed" style={{borderColor:'#3b82f6'}} /> <span>Contrib</span></div>
            </div>
          </div>

          <div className="mt-6 rounded-xl bg-gray-50 p-4 text-xs text-gray-600">
            Disclaimer: Estimates only; not financial advice. Verify SARS/FSCA rules and provider terms. Obtain POPIA consent before processing PII.
          </div>
        </section>
      </div>
    </div>
  );
}
