import { createBrowserRouter, Navigate } from "react-router"
import AppShell from "./components/AppShell"
import RouteError from "./components/RouteError"
import AlertsPage from "./pages/AlertsPage"
import AllocatorPage from "./pages/AllocatorPage"
import ExecutorPage from "./pages/ExecutorPage"
import HubPage from "./pages/HubPage"
import IndexerPage from "./pages/IndexerPage"
import OraclePage from "./pages/OraclePage"
import ChainsPage from "./pages/ChainsPage"
import PoolsPage from "./pages/PoolsPage"
import PricesPage from "./pages/PricesPage"
import TokenPage from "./pages/TokenPage"
import WalletPage from "./pages/WalletPage"

export const router = createBrowserRouter([
  {
    Component: AppShell,
    ErrorBoundary: RouteError,
    children: [
      {
        ErrorBoundary: RouteError,
        children: [
          { Component: IndexerPage, index: true },
          { Component: HubPage, path: "hub" },
          { Component: TokenPage, path: "hub/tokens/:tokenId" },
          { Component: WalletPage, path: "hub/wallets/:address" },
          { Component: ChainsPage, path: "chains/:chain?/:depository?" },
          { Component: PricesPage, path: "prices" },
          { Component: OraclePage, path: "oracle" },
          { Component: AllocatorPage, path: "allocator" },
          { Component: ExecutorPage, path: "executor" },
          { Component: PoolsPage, path: "pools/:pool?" },
          { Component: AlertsPage, path: "alerts" },
          { element: <Navigate to="/" replace />, path: "*" },
        ],
      },
    ],
  },
])
