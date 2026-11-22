import "./storage-migration";
import "./scrollbar-mode";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AccessGate } from "./access-gate";
import { serverBase } from "./server-base";
import { DevStatusBanner } from "./dev-status-banner";
import { SandboxBadge } from "./sandbox-badge";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AccessGate />
    {import.meta.env.DEV ? <DevStatusBanner /> : null}
    <SandboxBadge base={serverBase()} />
  </StrictMode>,
);
