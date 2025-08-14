import { Routes, Route, Navigate, Link } from "react-router-dom";
import RetirementCalculator from "./RetirementCalculator";
import InvestmentCalculator from "./InvestmentCalculator";
import "./index.css";

export default function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b bg-white">
        <nav className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <div className="text-lg font-semibold">SmartPlan</div>
          <div className="flex gap-3 text-sm">
            <Link className="rounded-lg px-3 py-1 hover:bg-gray-100" to="/retirement">
              Retirement Calculator
            </Link>
            <Link className="rounded-lg px-3 py-1 hover:bg-gray-100" to="/investment">
              Investment Calculator
            </Link>
          </div>
        </nav>
      </header>

      <main className="mx-auto max-w-7xl p-4">
        <Routes>
          <Route path="/" element={<Navigate to="/retirement" replace />} />
          <Route path="/retirement" element={<RetirementCalculator />} />
          <Route path="/investment" element={<InvestmentCalculator />} />
          <Route path="*" element={<Navigate to="/retirement" replace />} />
        </Routes>
      </main>
    </div>
  );
}
