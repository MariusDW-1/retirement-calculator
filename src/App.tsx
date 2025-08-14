import { Routes, Route, Navigate, Link } from "react-router-dom";
import RetirementCalculator from "./RetirementCalculator";
import InvestmentCalculator from "./InvestmentCalculator";

export default function App() {
  return (
    <div style={{ fontFamily: "Arial, sans-serif", padding: "20px" }}>
      <nav style={{ marginBottom: "20px" }}>
        <Link to="/retirement" style={{ marginRight: "15px" }}>
          Retirement Calculator
        </Link>
        <Link to="/investment">Investment Calculator</Link>
      </nav>

      <Routes>
        <Route path="/" element={<Navigate to="/retirement" replace />} />
        <Route path="/retirement" element={<RetirementCalculator />} />
        <Route path="/investment" element={<InvestmentCalculator />} />
      </Routes>
    </div>
  );
}
