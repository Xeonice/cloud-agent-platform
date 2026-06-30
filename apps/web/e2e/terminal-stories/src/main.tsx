import * as React from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "../../../src/styles/app.css";
import "./styles.css";

import { TerminalStoryApp } from "./terminal-story-app";

const root = document.getElementById("root");
if (!root) {
  throw new Error("terminal story root is missing");
}

createRoot(root).render(<TerminalStoryApp />);
