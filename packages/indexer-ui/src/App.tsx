import { Routes, Route, Navigate } from "react-router-dom"
import Home from "./pages/Home"
import TokenPage from "./pages/TokenPage"
import AddressPage from "./pages/AddressPage"

export default function App() {
  return (
    <div className="app-root">
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/token/:id" element={<TokenPage />} />
        <Route path="/address/:address" element={<AddressPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <div className="refresh-indicator">
        <span className="refresh-dot" aria-hidden="true" />
        <span>Data refreshes every 5 seconds</span>
      </div>
    </div>
  )
}
