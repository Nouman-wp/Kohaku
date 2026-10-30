import { StrictMode, lazy, Suspense, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation } from "react-router";
import "@fontsource-variable/inter";
import "@fontsource/instrument-serif/latin-400.css";
import "@fontsource/instrument-serif/latin-400-italic.css";
import "@fontsource-variable/jetbrains-mono";
import "./styles/base.css";
import "./styles/landing.css";
import "./styles/app.css";
import { Header, Footer } from "./components/chrome.tsx";
import Landing from "./pages/Landing.tsx";
import { startLive } from "./lib/api.ts";

const Floor = lazy(() => import("./pages/Floor.tsx"));
const EpochList = lazy(() => import("./pages/Epochs.tsx").then((m) => ({ default: m.EpochList })));
const EpochPage = lazy(() => import("./pages/Epochs.tsx").then((m) => ({ default: m.EpochPage })));
const AgentList = lazy(() => import("./pages/Agents.tsx").then((m) => ({ default: m.AgentList })));
const AgentPage = lazy(() => import("./pages/Agents.tsx").then((m) => ({ default: m.AgentPage })));
const JobPage = lazy(() => import("./pages/Job.tsx"));
const Disputes = lazy(() => import("./pages/Disputes.tsx"));
const Verify = lazy(() => import("./pages/Verify.tsx"));
const Console = lazy(() => import("./pages/Console.tsx"));
const IntentComposer = lazy(() => import("./pages/Intents.tsx").then((m) => ({ default: m.IntentComposer })));
const IntentPage = lazy(() => import("./pages/Intents.tsx").then((m) => ({ default: m.IntentPage })));
const Developers = lazy(() => import("./pages/Developers.tsx").then((m) => ({ default: m.Developers })));
const Status = lazy(() => import("./pages/Developers.tsx").then((m) => ({ default: m.Status })));

function ScrollToTop() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (!hash) window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

// Entrance animations only hide content once this script runs (see base.css).
document.documentElement.classList.add("js-reveal");

function App() {
  return (
    <>
      <ScrollToTop />
      <Header />
      <div id="content" tabIndex={-1}>
        <Suspense fallback={<div className="page" aria-busy="true" />}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/floor" element={<Floor />} />
            <Route path="/epochs" element={<EpochList />} />
            <Route path="/epochs/:id" element={<EpochPage />} />
            <Route path="/agents" element={<AgentList />} />
            <Route path="/agents/:id" element={<AgentPage />} />
            <Route path="/jobs/:id" element={<JobPage />} />
            <Route path="/disputes" element={<Disputes />} />
            <Route path="/verify" element={<Verify />} />
            <Route path="/console" element={<Console />} />
            <Route path="/intents/new" element={<IntentComposer />} />
            <Route path="/intents/:id" element={<IntentPage />} />
            <Route path="/developers" element={<Developers />} />
            <Route path="/status" element={<Status />} />
            <Route path="*" element={<Landing />} />
          </Routes>
        </Suspense>
      </div>
      <Footer />
    </>
  );
}

startLive();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
