import React, { useState } from "react";
import RetirementCalculator from "./RetirementCalculator";
import InvestmentCalculator from "./InvestmentCalculator";

type Tab = "retirement" | "investment";

export default function App() {
  const [tab, setTab] = useState<Tab>("retirement");

  return (
    <div className="min-h-screen bg-white text-gray-900">
      <div className="mx-auto max-w-7xl px-4 py-6">
        {/* Header */}
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">SmartPlan</h1>
          <div className="rounded-full bg-teal-600 px-4 py-1 text-sm font-medium text-white">
            South Africa
          </div>
        </header>

        {/* Tabs */}
        <nav className="mb-6 flex gap-2 text-sm">
          <button
            className={`rounded-xl px-4 py-2 ${tab === "retirement" ? "bg-teal-600 text-white" : "bg-gray-100"}`}
            onClick={() => setTab("retirement")}
          >
            Retirement Calculator
          </button>
          <button
            className={`rounded-xl px-4 py-2 ${tab === "investment" ? "bg-teal-600 text-white" : "bg-gray-100"}`}
            onClick={() => setTab("investment")}
          >
            Investment Calculator
          </button>
        </nav>

        {/* Page container */}
        <div className="rounded-2xl border shadow-sm">
          {tab === "retirement" ? <RetirementCalculator /> : <InvestmentCalculator />}
        </div>

        <footer className="mt-8 text-xs text-gray-500">
          © {new Date().getFullYear()} SA Financial Planners – Planning tools (estimates only).
        </footer>
      </div>
    </div>
  );
}
