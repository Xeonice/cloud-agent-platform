import * as React from "react";
import { createRoot } from "react-dom/client";

import "../../../src/styles/app.css";
import "./styles.css";
import { CodexDeviceLoginStoryApp } from "./story-app";

const root = document.getElementById("root");
if (!root) throw new Error("Codex device-login story root is missing");

createRoot(root).render(<CodexDeviceLoginStoryApp />);
