import React, { useMemo, useState, useEffect } from "react";

/**
 * SmartPlan – Comprehensive Retirement Calculator (South Africa)
 * React + TypeScript + Tailwind (single-file)
 *
 * Includes:
 * - "Pensionable Salary (Monthly)" label
 * - Auto-age from SA ID (manual hidden once valid)
 * - Reset Info (clears client, salary, affordability, %s, products; results reset)
 * - Auto "Employer Fund (Auto)" product when Employee/Employer % > 0 (supports comma inputs like 7,5)
 * - Export to Excel (CSV) + Print / Save PDF
 * - Results graph + **Funding Level** progress bar under the graph
 *
 * Disclaimer: Estimates only; not financial advice. Follow FAIS/POPIA.
 */

// ---------- Utilities ----------
function parseNum(v: string | number) {
  if (typeof v === "number") return v;
  const n = parseFloat((v ?? "").toString().replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? 0 : n;
}
const currency = new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", maximumFractionDigits: 0 });

function digitsOnly(id: string) { return (id || "").replace(/\D/g, ""); }
function dobFromSouthAfricanID(id: string): Date | null {
  const clean = digitsOnly(id);
  if (clean.length < 6) return null;
  const yy = parseInt(clean.slice(0, 2), 10);
  const mm = parseInt(clean.slice(2, 4), 10);
  const dd = parseInt(clean.slice(4, 6), 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const curYY = new Date().getFullYear() % 100;
  const century = yy > curYY ? 1900 : 2000;
  const d = new Date(century + yy, mm - 1, dd);
  return isNaN(d.getTime()) ? null : d;
}
function ageFromDOB(dob: Date | null): number | null {
  if (!dob) return null;
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
  return age;
}

function realAnnuityFactor(d: number, L: number) {
  if (L <= 0) return 0;
  if (Math.abs(d) < 1e-8) return L;
  return (1 - Math.pow(1 / (1 + d), L)) / d;
}
function fvLump(pv: number, r: number, n: number) { return pv * Math.pow(1 + r, n); }
function fvGrowingAnnuity(P0: number, r: number, g: number, n: number) {
  if (n <= 0) return 0;
  if (Math.abs(r - g) < 1e-8) return P0 * n * Math.pow(1 + r, n);
  const top = Math.pow(1 + r, n) - Math.pow(1 + g, n);
  const fv = P0 * (top / (r - g));
  return fv * (1 + r);
}

// ---------- Types ----------
type ProductType = "RA" | "Pension/Provident" | "Preservation" | "Discretionary";
interface RetirementProduct {
  id: string; type: ProductType; provider: string;
  currentBalance: number; monthlyContribution: number; annualContributionEscalation: number; nominalReturn: number; annualFees: number;
}

interface ClientInfo { name: string; surname: string; email: string; mobile: string; idNumber: string; }
interface Inputs {
  client: ClientInfo; ageManual: number | null; retireAge: number; lifeExpectancy: number;
  monthlySalary: number; otherMonthlyIncome: number; monthlyExpenses: number; salaryGrowth: number;
  employeeContribPct: number; employerContribPct: number; contribEscalation: number;
  inflation: number; preReturnFallback: number; postReturn: number;
  incomeMode: "replacement" | "absolute"; targetReplacementRatio: number; targetMonthlyIncomeToday: number;
  products: RetirementProduct[];
}

function uid() { return Math.random().toString(36).slice(2, 9); }

function defaultInputs(): Inputs {
  return {
    client: { name: "", surname: "", email: "", mobile: "", idNumber: "" },
    ageManual: null,
    retireAge: 65,
    lifeExpectancy: 90,

    monthlySalary: 0, // Pensionable Salary (Monthly)
    otherMonthlyIncome: 0,
    monthlyExpenses: 0,
    salaryGrowth: 0.065,

    employeeContribPct: 0,
    employerContribPct: 0,
    contribEscalation: 0.065,

    inflation: 0.055,
    preReturnFallback: 0.09,
    postReturn: 0.065,

    incomeMode: "replacement",
    targetReplacementRatio: 0.75,
    targetMonthlyIncomeToday: 35000,

    products: [],
  };
}

const AUTO_ID = "__AUTO_EMPLOYER__";

export default function RetirementCalculator() {
  const [inp, setInp] = useState<Inputs>(defaultInputs());

  // Auto age from ID (sync manual age once available)
  const dob = dobFromSouthAfricanID(inp.client.idNumber);
  const autoAge = ageFromDOB(dob);
  const age = autoAge ?? (inp.ageManual ?? 0);
  useEffect(() => {
    if (autoAge != null && autoAge !== inp.ageManual) setInp(v => ({ ...v, ageManual: autoAge }));
  }, [autoAge]);

  // Employee/Employer contribution rands (from pensionable salary)
  const employeeMonthly = useMemo(() => inp.monthlySalary * inp.employeeContribPct, [inp.monthlySalary, inp.employeeContribPct]);
  const employerMonthly = useMemo(() => inp.monthlySalary * inp.employerContribPct, [inp.monthlySalary, inp.employerContribPct]);
  const totalMonthlyContrib = useMemo(() => employeeMonthly + employerMonthly, [employeeMonthly, employerMonthly]);

  // Auto-manage an Employer Fund product using payroll contributions
  useEffect(() => {
    setInp(v => {
      const hasAuto = v.products.some(p => p.id === AUTO_ID);
      const total = employeeMonthly + employerMonthly; // monthly R
      const anyPct = (v.employeeContribPct ?? 0) > 0 || (v.employerContribPct ?? 0) > 0;
      if (anyPct) {
        const prevAuto = v.products.find(p => p.id === AUTO_ID);
        const product: RetirementProduct = {
          id: AUTO_ID,
          type: "Pension/Provident",
          provider: "Employer Fund (Auto)",
          currentBalance: prevAuto ? prevAuto.currentBalance : 0,
          monthlyContribution: Math.round(total),
          annualContributionEscalation: v.contribEscalation,
          nominalReturn: v.preReturnFallback,
          annualFees: 0.01,
        };
        return hasAuto
          ? { ...v, products: v.products.map(p => (p.id === AUTO_ID ? product : p)) }
          : { ...v, products: [product, ...v.products] };
      } else if (hasAuto) {
        return { ...v, products: v.products.filter(p => p.id !== AUTO_ID) };
      }
      return v;
    });
    // Trigger on salary and % changes so the product appears as soon as %s are entered
  }, [employeeMonthly, employerMonthly, inp.employeeContribPct, inp.employerContribPct]);

  // Core projections
  const yearsToRetire = Math.max(0, Math.round(inp.retireAge - (age || 0)));
  const yearsInRetirement = Math.max(0, Math.round(inp.lifeExpectancy - inp.retireAge));

  const results = useMemo(() => {
    const n = yearsToRetire; const L = yearsInRetirement; const inflation = inp.inflation;
    const preR = Math.max(-0.99, inp.preReturnFallback); const postR = Math.max(-0.99, inp.postReturn);

    // Grow existing balances + product contributions only (no separate payroll term to avoid double counting)
    let assetsNominal = 0;
    inp.products.forEach(p => {
      const rNet = Math.max(-0.99, (p.nominalReturn || preR) - (p.annualFees || 0));
      const fvBal = fvLump(p.currentBalance || 0, rNet, n);
      const fvContrib = fvGrowingAnnuity((p.monthlyContribution || 0) * 12, rNet, p.annualContributionEscalation ?? inflation, n);
      assetsNominal += fvBal + fvContrib;
    });

    const assetsReal = assetsNominal / Math.pow(1 + inflation, n);

    // Income target
    const annualSalary0 = inp.monthlySalary * 12;
    const finalSalary = annualSalary0 * Math.pow(1 + inp.salaryGrowth, n);
    const targetAnnualToday = inp.incomeMode === "replacement"
      ? (finalSalary * inp.targetReplacementRatio) / Math.pow(1 + inflation, n)
      : inp.targetMonthlyIncomeToday * 12;

    const realPostR = (1 + postR) / (1 + inflation) - 1; const annuityFactor = realAnnuityFactor(realPostR, L);
    const requiredCapitalReal = targetAnnualToday * annuityFactor; const requiredCapitalNominal = requiredCapitalReal * Math.pow(1 + inflation, n);

    const shortfallReal = Math.max(0, requiredCapitalReal - assetsReal);

    // Extra monthly (today's R) needed, assuming CPI escalation of the extra
    const realPreR = (1 + preR) / (1 + inflation) - 1;
    const denom = ((Math.pow(1 + realPreR, n) - 1) / (realPreR || 1e-9)) * (1 + realPreR);
    const addAnnualToday = denom > 0 ? shortfallReal / denom : 0; const addMonthlyToday = addAnnualToday / 12;

    const fundedRatio = requiredCapitalReal > 0 ? assetsReal / requiredCapitalReal : 0;
    let health: "good" | "warn" | "bad" = "bad"; if (fundedRatio >= 1) health = "good"; else if (fundedRatio >= 0.7) health = "warn";

    const monthlySurplus = inp.monthlySalary + inp.otherMonthlyIncome - inp.monthlyExpenses;

    return { n, L, assetsNominal, assetsReal, finalSalary, targetAnnualToday, requiredCapitalReal, requiredCapitalNominal, shortfallReal, addMonthlyToday, fundedRatio, health, monthlySurplus };
  }, [inp, yearsToRetire, yearsInRetirement]);

  // Reset – full clean slate (also resets results because state is defaulted)
  const resetInfo = () => setInp(defaultInputs());

  // Export to Excel (CSV) & Print to PDF
  const exportToExcel = () => {
    const rows: string[] = [];
    const dt = new Date().toISOString();
    rows.push(`Generated,${dt}`);
    rows.push(`Client,${inp.client.name} ${inp.client.surname}`);
    rows.push(`Email,${inp.client.email}`);
    rows.push(`Mobile,${inp.client.mobile}`);
    rows.push(`ID,${inp.client.idNumber}`);
    rows.push(`Age,${autoAge ?? inp.ageManual ?? ''}`);
    rows.push(`Retirement age,${inp.retireAge}`);
    rows.push(`Life expectancy,${inp.lifeExpectancy}`);
    rows.push(`Pensionable salary monthly,${inp.monthlySalary}`);
    rows.push(`Other income monthly,${inp.otherMonthlyIncome}`);
    rows.push(`Expenses monthly,${inp.monthlyExpenses}`);
    rows.push(`Employee monthly contribution,${Math.round(employeeMonthly)}`);
    rows.push(`Employer monthly contribution,${Math.round(employerMonthly)}`);
    rows.push(`Total monthly contribution,${Math.round(totalMonthlyContrib)}`);
    rows.push(`Inflation,${inp.inflation}`);
    rows.push(`Pre-ret return,${inp.preReturnFallback}`);
    rows.push(`Post-ret return,${inp.postReturn}`);
    rows.push(`Target mode,${inp.incomeMode}`);

    inp.products.forEach((p, i) => {
      rows.push(`Product ${i+1} type,${p.type}`);
      rows.push(`Product ${i+1} provider,${p.provider}`);
      rows.push(`Product ${i+1} balance,${p.currentBalance}`);
      rows.push(`Product ${i+1} monthly contr,${p.monthlyContribution}`);
      rows.push(`Product ${i+1} contr escal,${p.annualContributionEscalation}`);
      rows.push(`Product ${i+1} return,${p.nominalReturn}`);
      rows.push(`Product ${i+1} fees,${p.annualFees}`);
    });

    rows.push("--- results ---");
    const r = {
      years_to_retirement: results.n,
      years_in_retirement: results.L,
      assets_nominal: Math.round(results.assetsNominal),
      assets_real: Math.round(results.assetsReal),
      target_income_annual_today: Math.round(results.targetAnnualToday),
      required_capital_real: Math.round(results.requiredCapitalReal),
      required_capital_nominal: Math.round(results.requiredCapitalNominal),
      funded_ratio: results.fundedRatio.toFixed(3),
      addl_saving_month_today: Math.round(results.addMonthlyToday),
      monthly_surplus_now: Math.round(results.monthlySurplus),
    } as const;
    Object.entries(r).forEach(([k,v])=>rows.push(`${k},${v}`));

    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = `smartplan_retirement_${Date.now()}.csv`; a.click(); URL.revokeObjectURL(url);
  };

  const exportToPDF = () => window.print();

  const field = (label: string, children: React.ReactNode) => (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-gray-700">{label}</span>
      {children}
    </label>
  );

  // -------- UI --------
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <div className="mx-auto max-w-7xl px-4 py-8">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <img src="/Images/SAFP_logo_250x400" alt="SmartPlan Logo" width={40} height={40} />
          <h1 className="text-2xl font-semibold">SmartPlan – Comprehensive Retirement Calculator</h1>
          <div className="rounded-full bg-teal-600 px-4 py-1 text-sm font-medium text-white">South Africa</div>
        </header>

        {/* Quick Actions */}
        <div className="mb-4 flex flex-wrap gap-2">
          <button onClick={resetInfo} className="rounded-xl border px-3 py-2 text-sm">Reset Info</button>
          <button onClick={exportToExcel} className="rounded-xl border px-3 py-2 text-sm">Export to Excel</button>
          <button onClick={exportToPDF} className="rounded-xl border px-3 py-2 text-sm">Print / Save PDF</button>
        </div>

        {/* Status */}
        <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
          <Stat label="Years to Retirement">{results.n}</Stat>
          <Stat label="Funding level">{(results.fundedRatio * 100).toFixed(1)}%</Stat>
          <Stat label="Monthly Surplus Now">{currency.format(Math.round(results.monthlySurplus))}</Stat>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Client Details */}
          <section className="rounded-2xl border p-6 shadow-sm">
            <h2 className="mb-4 text-lg font-semibold">Client Details</h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {field("Name", <input className="rounded-xl border p-2" value={inp.client.name} onChange={e=>setInp(v=>({...v, client:{...v.client, name:e.target.value}}))} />)}
              {field("Surname", <input className="rounded-xl border p-2" value={inp.client.surname} onChange={e=>setInp(v=>({...v, client:{...v.client, surname:e.target.value}}))} />)}
              {field("Email", <input type="email" className="rounded-xl border p-2" value={inp.client.email} onChange={e=>setInp(v=>({...v, client:{...v.client, email:e.target.value}}))} />)}
              {field("Mobile", <input className="rounded-xl border p-2" value={inp.client.mobile} onChange={e=>setInp(v=>({...v, client:{...v.client, mobile:e.target.value}}))} />)}
              {field("South African ID (13 digits)", <input className="rounded-xl border p-2" value={inp.client.idNumber} onChange={e=>setInp(v=>({...v, client:{...v.client, idNumber:e.target.value}}))} />)}
              <div className="flex flex-col gap-1 text-sm">
                <span className="text-gray-700">Age</span>
                <div className="flex items-center gap-2">
                  {autoAge != null ? (
                    <div className="rounded-xl border px-3 py-2 text-sm">{autoAge}</div>
                  ) : (
                    <>
                      <span className="text-xs text-gray-500">Auto from ID. If blank, specify:</span>
                      <input type="number" className="w-24 rounded-xl border p-2" value={inp.ageManual ?? 0} onChange={e=>setInp(v=>({...v, ageManual: parseNum(e.target.value)}))} />
                    </>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* Horizon & Assumptions */}
          <section className="rounded-2xl border p-6 shadow-sm">
            <h2 className="mb-4 text-lg font-semibold">Retirement Horizon & Assumptions</h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {field("Planned Retirement Age", <input type="number" className="rounded-xl border p-2" value={inp.retireAge} onChange={e=>setInp(v=>({...v, retireAge: parseNum(e.target.value)}))} />)}
              {field("Life Expectancy", <input type="number" className="rounded-xl border p-2" value={inp.lifeExpectancy} onChange={e=>setInp(v=>({...v, lifeExpectancy: parseNum(e.target.value)}))} />)}

              {field("Pensionable Salary (Monthly)", <input type="number" className="rounded-xl border p-2" value={inp.monthlySalary} onChange={e=>setInp(v=>({...v, monthlySalary: parseNum(e.target.value)}))} />)}
              {field("Salary Growth (% p.a.)", <Percent value={inp.salaryGrowth} onChange={val=>setInp(v=>({...v, salaryGrowth: val}))} />)}

              {field("Employee Contrib (% of salary)", <Percent value={inp.employeeContribPct} onChange={val=>setInp(v=>({...v, employeeContribPct: val}))} />)}
              {field("Employer Contrib (% of salary)", <Percent value={inp.employerContribPct} onChange={val=>setInp(v=>({...v, employerContribPct: val}))} />)}
              {field("Contrib Escalation (% p.a.)", <Percent value={inp.contribEscalation} onChange={val=>setInp(v=>({...v, contribEscalation: val}))} />)}

              {field("Inflation (CPI, % p.a.)", <Percent value={inp.inflation} onChange={val=>setInp(v=>({...v, inflation: val}))} />)}
              {field("Fallback Pre‑ret Return (% p.a.)", <Percent value={inp.preReturnFallback} onChange={val=>setInp(v=>({...v, preReturnFallback: val}))} />)}
              {field("Post‑ret Return (% p.a.)", <Percent value={inp.postReturn} onChange={val=>setInp(v=>({...v, postReturn: val}))} />)}

              <div className="col-span-1 md:col-span-2">
                <div className="mb-2 flex gap-3">
                  <button className={`rounded-xl px-3 py-1 text-sm ${inp.incomeMode==='replacement' ? 'bg-teal-600 text-white' : 'bg-gray-100'}`} onClick={()=>setInp(v=>({...v, incomeMode:'replacement'}))}>Target: Replacement %</button>
                  <button className={`rounded-xl px-3 py-1 text-sm ${inp.incomeMode==='absolute' ? 'bg-teal-600 text-white' : 'bg-gray-100'}`} onClick={()=>setInp(v=>({...v, incomeMode:'absolute'}))}>Target: Absolute R/month</button>
                </div>
                {inp.incomeMode==='replacement' ? (
                  field("Target Replacement Ratio", <Percent value={inp.targetReplacementRatio} onChange={val=>setInp(v=>({...v, targetReplacementRatio: val}))} />)
                ) : (
                  field("Target Income at Retirement (Today’s R/month)", <input type="number" className="rounded-xl border p-2" value={inp.targetMonthlyIncomeToday} onChange={e=>setInp(v=>({...v, targetMonthlyIncomeToday: parseNum(e.target.value)}))} />)
                )}
              </div>
            </div>
          </section>

          {/* Retirement Products */}
          <section className="rounded-2xl border p-6 shadow-sm lg:col-span-2">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Retirement Products</h2>
              <button className="rounded-xl bg-teal-600 px-3 py-2 text-sm text-white" onClick={()=>setInp(v=>({...v, products:[...v.products, { id: uid(), type: 'RA', provider: '', currentBalance: 0, monthlyContribution: 0, annualContributionEscalation: v.contribEscalation, nominalReturn: v.preReturnFallback, annualFees: 0.01 }]}))}>Add product</button>
            </div>

            {/* Employer/Employee contribution summary */}
            <div className="mb-3 grid grid-cols-1 gap-2 rounded-xl bg-gray-50 p-3 text-sm md:grid-cols-3">
              <div>Employee monthly contribution: <b>{currency.format(Math.round(employeeMonthly))}</b></div>
              <div>Employer monthly contribution: <b>{currency.format(Math.round(employerMonthly))}</b></div>
              <div>Total monthly contribution: <b>{currency.format(Math.round(totalMonthlyContrib))}</b></div>
            </div>

            <div className="grid grid-cols-1 gap-4">
              {inp.products.map(p => (
                <div key={p.id} className="rounded-xl border p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm">
                      <select className="rounded-lg border px-2 py-1" value={p.type} onChange={e=>{ const type = e.target.value as ProductType; setInp(v=>({...v, products: v.products.map(x=>x.id===p.id?{...x, type}:x)})); }}>
                        <option>RA</option>
                        <option>Pension/Provident</option>
                        <option>Preservation</option>
                        <option>Discretionary</option>
                      </select>
                      <input placeholder="Provider / Policy name" className="rounded-lg border px-2 py-1" value={p.provider} onChange={e=>setInp(v=>({...v, products: v.products.map(x=>x.id===p.id?{...x, provider:e.target.value}:x)}))} />
                    </div>
                    {p.id !== AUTO_ID && (
                      <button className="text-sm text-red-600" onClick={()=>setInp(v=>({...v, products: v.products.filter(x=>x.id!==p.id)}))}>Remove</button>
                    )}
                  </div>

                  <div className="grid grid-cols-1 gap-3 md:grid-cols-6">
                    {field("Current Balance (R)", <input type="number" className="rounded-xl border p-2" value={p.currentBalance} onChange={e=>setInp(v=>({...v, products: v.products.map(x=>x.id===p.id?{...x, currentBalance: parseNum(e.target.value)}:x)}))} />)}
                    {field("Monthly Contribution (R)", <input type="number" className="rounded-xl border p-2" value={p.monthlyContribution} onChange={e=>setInp(v=>({...v, products: v.products.map(x=>x.id===p.id?{...x, monthlyContribution: parseNum(e.target.value)}:x)}))} />)}
                    {field("Contribution Esc. (% p.a.)", <Percent value={p.annualContributionEscalation} onChange={val=>setInp(v=>({...v, products: v.products.map(x=>x.id===p.id?{...x, annualContributionEscalation: val}:x)}))} />)}
                    {field("Return (% p.a.)", <Percent value={p.nominalReturn} onChange={val=>setInp(v=>({...v, products: v.products.map(x=>x.id===p.id?{...x, nominalReturn: val}:x)}))} />)}
                    {field("Fees (TER+advice, % p.a.)", <Percent value={p.annualFees} onChange={val=>setInp(v=>({...v, products: v.products.map(x=>x.id===p.id?{...x, annualFees: val}:x)}))} />)}
                    <div className="flex flex-col justify-end"><small className="text-gray-500">Escalations apply annually.</small></div>
                  </div>

                  {p.id === AUTO_ID && (
                    <div className="mt-2 text-xs text-gray-600">This auto product reflects payroll contributions at the current Employee/Employer rates.</div>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* Affordability */}
          <section className="rounded-2xl border p-6 shadow-sm">
            <h2 className="mb-4 text-lg font-semibold">Affordability</h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {field("Other Monthly Income", <input type="number" className="rounded-xl border p-2" value={inp.otherMonthlyIncome} onChange={e=>setInp(v=>({...v, otherMonthlyIncome: parseNum(e.target.value)}))} />)}
              {field("Total Monthly Expenses (incl. debt)", <input type="number" className="rounded-xl border p-2" value={inp.monthlyExpenses} onChange={e=>setInp(v=>({...v, monthlyExpenses: parseNum(e.target.value)}))} />)}
            </div>
            <div className="mt-4 rounded-xl bg-gray-50 p-3 text-sm">Monthly surplus now: <b>{currency.format(Math.round(results.monthlySurplus))}</b></div>
          </section>

          {/* Results */}
          <section className="rounded-2xl border p-6 shadow-sm lg:col-span-2">
            <h2 className="mb-4 text-lg font-semibold">Results</h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Stat label="Projected Assets @ Retirement (Nominal)">{currency.format(Math.round(results.assetsNominal))}</Stat>
              <Stat label="Projected Assets @ Retirement (Today’s)">{currency.format(Math.round(results.assetsReal))}</Stat>
              <Stat label="Annual Target Income (Today’s)">{currency.format(Math.round(results.targetAnnualToday))}</Stat>
              <Stat label="Required Capital (Today’s)">{currency.format(Math.round(results.requiredCapitalReal))}</Stat>
              <Stat label="Required Capital (Nominal in Year)">{currency.format(Math.round(results.requiredCapitalNominal))}</Stat>
              <Stat label="Extra Monthly Savings Needed (Today’s R)">{currency.format(Math.round(results.addMonthlyToday))}</Stat>
            </div>

            <div className="mt-4">
              <div className="mb-2 text-sm font-medium">Required vs Current vs Shortfall (today’s R)</div>
              <BarGraph
                required={results.requiredCapitalReal}
                current={results.assetsReal}
                shortfall={Math.max(0, results.requiredCapitalReal - results.assetsReal)}
                extraMonthly={results.addMonthlyToday}
              />
            </div>

            {/* Funding Level progress bar under the graph */}
            <div className="mt-4">
              <div className="mb-1 text-sm">Funding Level</div>
              <div className="w-full rounded-full bg-gray-200 h-4">
                <div
                  className={`h-4 rounded-full ${results.health === 'good' ? 'bg-green-500' : results.health === 'warn' ? 'bg-yellow-500' : 'bg-red-500'}`}
                  style={{ width: `${Math.min(100, results.fundedRatio * 100).toFixed(1)}%` }}
                />
              </div>
              <div className="mt-1 text-xs text-gray-600">{(results.fundedRatio * 100).toFixed(1)}% funded</div>
            </div>

            <div className="mt-6 rounded-xl bg-gray-50 p-4 text-xs text-gray-600">
              Disclaimer: Estimates only; not financial advice. Provide FAIS‑compliant disclosures and POPIA consent before processing personal information.
            </div>
          </section>
        </div>

        <footer className="mt-8 text-xs text-gray-500">© {new Date().getFullYear()} SA Financial Planners – Estimator for planning purposes.</footer>
      </div>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-semibold">{children}</div>
    </div>
  );
}

function Percent({ value, onChange }: { value: number; onChange: (v: number)=>void }) {
  return (
    <div className="relative">
      <input
        type="number"
        className="w-full rounded-xl border border-gray-300 p-2 pr-10 focus:outline-none focus:ring-2 focus:ring-teal-500"
        value={Math.round((value || 0) * 10000)/100}
        step={0.1}
        min={0}
        onChange={(e) => {
          // accept comma or dot
          const raw = (e.target.value || '').replace(',', '.');
          onChange(parseNum(raw) / 100);
        }}
      />
      <span className="absolute right-3 top-2.5 text-gray-500">%</span>
    </div>
  );
}

/** Simple bar graph (no external libs) **/
function BarGraph({ required, current, shortfall, extraMonthly }:{ required:number; current:number; shortfall:number; extraMonthly:number; }){
  const max = Math.max(1, required, current, shortfall);
  const items = [
    { label: 'Required', value: required, color: '#d22b2b' },
    { label: 'Current', value: current, color: '#16a34a' },
    { label: 'Shortfall', value: shortfall, color: '#f59e0b' },
    { label: 'Extra Monthly (R)', value: extraMonthly, color: '#3b82f6' },
  ];
  return (
    <div className="grid grid-cols-4 gap-4">
      {items.map((it) => (
        <div key={it.label} className="flex flex-col items-center">
          <div className="flex h-40 w-12 items-end rounded-md bg-gray-100">
            <div className="w-full rounded-md" style={{ height: `${Math.min(100, (it.value / max) * 100)}%`, backgroundColor: it.color }} />
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
