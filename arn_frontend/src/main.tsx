import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "./index.css";
import App from "./App.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { SubmitPage } from "./pages/SubmitPage.tsx";
import { Submissions } from "./pages/Submissions.tsx";
import { SubmissionDetail } from "./pages/SubmissionDetail.tsx";
import { Settings } from "./pages/Settings.tsx";
import { RunDetail } from "./pages/RunDetail.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />}>
          <Route index element={<Dashboard />} />
          <Route path="submit" element={<SubmitPage />} />
          <Route path="submissions" element={<Submissions />} />
          <Route path="submissions/:id" element={<SubmissionDetail />} />
          <Route path="settings" element={<Settings />} />
          <Route path="runs/:id" element={<RunDetail />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>
);
