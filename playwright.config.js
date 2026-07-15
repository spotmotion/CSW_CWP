import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  reporter: "list",
  timeout: 60000,
  expect: { timeout: 15000 },
  webServer: {
    command: "node tests/static-server.mjs 4173",
    url: "http://localhost:4173/index.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
  use: {
    baseURL: "http://localhost:4173",
  },
  projects: [
    { name: "chromium-dpr1", use: { ...devices["Desktop Chrome"], deviceScaleFactor: 1 } },
    { name: "chromium-dpr2", use: { ...devices["Desktop Chrome"], deviceScaleFactor: 2 } },
    { name: "webkit-dpr1", use: { ...devices["Desktop Safari"], deviceScaleFactor: 1 } },
    { name: "webkit-dpr2", use: { ...devices["Desktop Safari"], deviceScaleFactor: 2 } },
    { name: "webkit-mobile", use: { ...devices["iPhone 13"] } },
  ],
})
