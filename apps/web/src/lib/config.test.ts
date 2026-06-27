import { afterEach, describe, expect, it, vi } from "vitest";

import {
  apiBaseUrl,
  deriveBrowserApiBaseUrl,
  deriveBrowserWsUrl,
  runtimeEndpointConfigScript,
  wsUrl,
} from "./config";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("endpoint config", () => {
  it("derives same-host browser api/ws URLs from the opened hostname and runtime api port", () => {
    const location = {
      protocol: "http:",
      hostname: "100.101.167.99",
    } as Location;
    const config = { apiPort: "18080" };

    expect(deriveBrowserApiBaseUrl(location, config)).toBe(
      "http://100.101.167.99:18080",
    );
    expect(deriveBrowserWsUrl(location, config)).toBe(
      "ws://100.101.167.99:18080",
    );
  });

  it("uses wss when the browser opened the console over https", () => {
    const location = {
      protocol: "https:",
      hostname: "cap.example.com",
    } as Location;

    expect(deriveBrowserApiBaseUrl(location, { apiPort: "443" })).toBe(
      "https://cap.example.com:443",
    );
    expect(deriveBrowserWsUrl(location, { apiPort: "443" })).toBe(
      "wss://cap.example.com:443",
    );
  });

  it("lets build-time VITE endpoint config override runtime discovery", () => {
    vi.stubEnv("VITE_API_BASE_URL", "https://api.example.com/");
    vi.stubEnv("VITE_WS_URL", "wss://api.example.com/");
    vi.stubGlobal("window", {
      location: { protocol: "http:", hostname: "100.101.167.99" },
      __CAP_RUNTIME_CONFIG__: { apiPort: "18080" },
    });

    expect(apiBaseUrl()).toBe("https://api.example.com");
    expect(wsUrl()).toBe("wss://api.example.com");
  });

  it("injects public runtime endpoint config without leaking undefined keys", () => {
    vi.stubEnv("CAP_PUBLIC_API_PORT", "18080");
    vi.stubEnv("CAP_SERVER_API_BASE_URL", "http://api:8080");

    expect(runtimeEndpointConfigScript()).toBe(
      'window.__CAP_RUNTIME_CONFIG__={"apiPort":"18080"};',
    );
  });

  it("uses the server-side internal api base during SSR", () => {
    vi.stubEnv("VITE_API_BASE_URL", "");
    vi.stubEnv("VITE_WS_URL", "");
    vi.stubEnv("CAP_SERVER_API_BASE_URL", "http://api:8080/");

    expect(apiBaseUrl()).toBe("http://api:8080");
    expect(wsUrl()).toBe("ws://api:8080");
  });
});
