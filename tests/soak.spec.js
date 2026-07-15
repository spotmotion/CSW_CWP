import { test, expect } from "@playwright/test"

// Runs the player through many randomized boot "trials" per browser project,
// hunting for the intermittent failures a single clean load won't show:
// requests that arrive slow/dropped (flaky mobile networks), and a parent
// resizing the iframe at an unpredictable point in the boot sequence (the
// Framer-embed race the sizing bugs came from). Each trial records an outcome
// instead of failing the whole run on the first flake, so a handful of bad
// trials shows up as data ("11/40 slow, 0 stuck") rather than one red X.
//
// Usage:
//   npx playwright test tests/soak.spec.js                  # SOAK_TRIALS default (10)
//   SOAK_TRIALS=50 npx playwright test tests/soak.spec.js    # more trials, longer run
//   SOAK_TRIALS=50 npx playwright test tests/soak.spec.js --project=webkit-mobile

const TRIALS = Number(process.env.SOAK_TRIALS || 10)

// Per-trial cap for reaching player-ready/player-error. Deliberately shorter
// than the app's own 45s boot watchdog (index.html) - if a trial is still
// silent at this point under only mild simulated network conditions, that's
// the "stuck" failure mode we're hunting, not a legitimate slow load.
const TRIAL_TIMEOUT_MS = 20000

const NETWORK_PROFILES = [
  { name: "fast", delayMs: [0, 0], dropRate: 0 },
  { name: "slow-mobile", delayMs: [150, 900], dropRate: 0 },
  { name: "flaky", delayMs: [0, 400], dropRate: 0.12 },
]

function randomBetween(min, max) {
  return Math.random() * (max - min) + min
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)]
}

function isChaosableAsset(url) {
  return /\.(wasm|data|cv|ttf)(\?|$)/.test(url) || url.includes("/CavalryWasm.js")
}

async function installNetworkChaos(page, getProfile) {
  await page.route("**/*", async (route) => {
    const url = route.request().url()
    if (!isChaosableAsset(url)) return route.continue()

    const profile = getProfile()
    if (profile.dropRate > 0 && Math.random() < profile.dropRate) {
      await route.abort("failed")
      return
    }

    const delay = randomBetween(...profile.delayMs)
    if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    await route.continue()
  })
}

async function waitForOutcome(page, timeoutMs) {
  const start = Date.now()
  try {
    const result = await page.waitForFunction(
      () => {
        const ready = window.__messages?.find((m) => m.type === "player-ready")
        const error = window.__messages?.find((m) => m.type === "player-error")
        if (ready) return { kind: "ready" }
        if (error) return { kind: "error", message: error.message }
        return false
      },
      null,
      { timeout: timeoutMs, polling: 100 }
    )
    const value = await result.jsonValue()
    return { ...value, elapsedMs: Date.now() - start }
  } catch {
    return { kind: "stuck", elapsedMs: Date.now() - start }
  }
}

async function readCanvasMetrics(frame) {
  return frame.evaluate(() => {
    const canvas = document.getElementById("canvas")
    const viewport = document.getElementById("viewport")
    const rect = viewport.getBoundingClientRect()
    return {
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      viewportRectWidth: rect.width,
      viewportRectHeight: rect.height,
      dpr: window.devicePixelRatio,
    }
  })
}

test("player survives repeated boots under randomized network and resize conditions", async ({ page }, testInfo) => {
  test.setTimeout(TRIALS * (TRIAL_TIMEOUT_MS + 5000) + 30000)

  let currentProfile = NETWORK_PROFILES[0]
  await installNetworkChaos(page, () => currentProfile)

  const pageErrors = []
  page.on("pageerror", (err) => pageErrors.push(err.message))

  const results = []

  for (let trial = 0; trial < TRIALS; trial++) {
    currentProfile = pick(NETWORK_PROFILES)
    const initialSize = [pick([150, 250, 400, 800]), pick([150, 250, 400, 800])]
    const resizeDelayMs = Math.round(randomBetween(0, 3000))
    const resizeSize = [pick([300, 600, 900]), pick([300, 600, 900])]
    const errorsBefore = pageErrors.length

    await page.setViewportSize({ width: 1024, height: 1024 })
    await page.goto(
      `/tests/fixtures/harness.html?w=${initialSize[0]}&h=${initialSize[1]}`
    )

    // Fire-and-forget: simulates the parent (Framer) settling its own layout
    // at some unpredictable point during or after boot, independent of
    // whichever network profile is slowing the boot itself down.
    page
      .waitForTimeout(resizeDelayMs)
      .then(() => page.evaluate(([w, h]) => window.resizeIframe(w, h), resizeSize))
      .catch(() => {})

    const outcome = await waitForOutcome(page, TRIAL_TIMEOUT_MS)

    let sizingOk = null
    if (outcome.kind === "ready") {
      const frame = page.frame({ name: "player" })
      if (frame) {
        // Give any in-flight ResizeObserver callback a moment to land.
        await page.waitForTimeout(150)
        const metrics = await readCanvasMetrics(frame).catch(() => null)
        if (metrics) {
          const expectedW = Math.round(metrics.viewportRectWidth * metrics.dpr)
          const expectedH = Math.round(metrics.viewportRectHeight * metrics.dpr)
          sizingOk =
            Math.abs(metrics.canvasWidth - expectedW) <= 2 &&
            Math.abs(metrics.canvasHeight - expectedH) <= 2
        }
      }
    }

    results.push({
      trial,
      networkProfile: currentProfile.name,
      initialSize,
      resizeDelayMs,
      resizeSize,
      outcome: outcome.kind,
      elapsedMs: outcome.elapsedMs,
      errorMessage: outcome.message,
      sizingOk,
      newPageErrors: pageErrors.slice(errorsBefore),
    })
  }

  const summary = {
    trials: TRIALS,
    ready: results.filter((r) => r.outcome === "ready").length,
    cleanError: results.filter((r) => r.outcome === "error").length,
    stuck: results.filter((r) => r.outcome === "stuck").length,
    badSizing: results.filter((r) => r.sizingOk === false).length,
    // The "flaky" profile intentionally aborts requests, which the browser
    // always reports as a page-level error even when the app recovers
    // cleanly from it - expected noise, not a bug. Only page errors on trials
    // that weren't supposed to see any dropped requests are suspicious.
    unexpectedPageErrors: results.filter(
      (r) => r.newPageErrors.length > 0 && r.networkProfile !== "flaky"
    ).length,
  }

  await testInfo.attach("soak-results.json", {
    body: JSON.stringify({ summary, results }, null, 2),
    contentType: "application/json",
  })

  console.log(
    `[soak] ${testInfo.project.name}: ${summary.ready} ready, ${summary.cleanError} clean-error, ` +
      `${summary.stuck} STUCK, ${summary.badSizing} bad-sizing, ${summary.unexpectedPageErrors} unexpected page errors ` +
      `(of ${summary.trials} trials)`
  )

  // "stuck" is the failure mode this test exists to catch: no player-ready and
  // no player-error within TRIAL_TIMEOUT_MS - a silently hung boot.
  expect.soft(summary.stuck, `stuck trials: ${JSON.stringify(results.filter((r) => r.outcome === "stuck"))}`).toBe(0)

  // A ready player should always be correctly sized - this is the other bug
  // this suite was built to catch.
  expect.soft(summary.badSizing, `bad-sizing trials: ${JSON.stringify(results.filter((r) => r.sizingOk === false))}`).toBe(0)

  expect
    .soft(summary.unexpectedPageErrors, `unexpected page errors: ${JSON.stringify(pageErrors)}`)
    .toBe(0)
})
