import * as React from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "../../../src/styles/app.css";
import "./styles.css";
import { ProviderTerminalStoryApp } from "./provider-terminal-story-app";

createRoot(document.getElementById("root")!).render(<ProviderTerminalStoryApp />);
