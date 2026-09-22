import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { TmuxApp } from "./TmuxApp.js";
import "./styles.css";

const appName = document.querySelector<HTMLMetaElement>("meta[name=bridge-app]")?.content;
const isTmuxVerifier = appName === "tmux-verifier" || window.location.pathname.startsWith("/tmux");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isTmuxVerifier ? <TmuxApp /> : <App />}
  </StrictMode>,
);
