import { test, expect } from "@playwright/test"

const SIZE_TOLERANCE_PX = 2

async function waitForPlayerReady(page) {
  await page.waitForFunction(
    () => window.__messages?.some((m) => m.type === "player-ready"),
    null,
    { timeout: 45000 }
  )
}

function getPlayerFrame(page) {
  const frame = page.frame({ name: "player" })
  if (!frame) throw new Error("player iframe not found")
  return frame
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

test("player boots and reaches ready state without hanging", async ({ page }) => {
  await page.goto("/tests/fixtures/harness.html")
  await waitForPlayerReady(page)

  const messages = await page.evaluate(() => window.__messages)
  expect(messages.some((m) => m.type === "player-error")).toBe(false)
})

test("canvas backing store matches its container after a post-ready iframe resize", async ({ page }) => {
  // Regression test for the "content is 50% the size it should be" bug: the player
  // used to size itself once against window.innerWidth/innerHeight and only correct
  // itself on a native `resize` event, which a CSS-driven resize of the embedding
  // iframe doesn't reliably fire (especially in Safari). It now uses a
  // ResizeObserver on document.documentElement, which fires on any box-size change
  // regardless of cause.
  await page.goto("/tests/fixtures/harness.html")
  await waitForPlayerReady(page)

  const frame = getPlayerFrame(page)

  // Sanity-check the initial (undersized) layout actually rendered small, so the
  // later assertion is proof the resize took effect rather than a no-op.
  const before = await readCanvasMetrics(frame)
  expect(before.canvasWidth).toBeLessThan(210 * before.dpr)

  // Simulate the parent page (Framer) finishing its own layout late, after the
  // player already booted and rendered once.
  await page.evaluate(() => window.resizeIframe(600, 900))

  await expect
    .poll(async () => {
      const metrics = await readCanvasMetrics(frame)
      return Math.round(metrics.viewportRectWidth * metrics.dpr)
    })
    .not.toBeLessThan(590 * (await frame.evaluate(() => window.devicePixelRatio)))

  const after = await readCanvasMetrics(frame)
  const expectedWidth = Math.round(after.viewportRectWidth * after.dpr)
  const expectedHeight = Math.round(after.viewportRectHeight * after.dpr)

  expect(Math.abs(after.canvasWidth - expectedWidth)).toBeLessThanOrEqual(SIZE_TOLERANCE_PX)
  expect(Math.abs(after.canvasHeight - expectedHeight)).toBeLessThanOrEqual(SIZE_TOLERANCE_PX)
})

test("canvas backing store tracks container across repeated resizes", async ({ page }) => {
  await page.goto("/tests/fixtures/harness.html")
  await waitForPlayerReady(page)

  const frame = getPlayerFrame(page)

  for (const [width, height] of [
    [400, 400],
    [900, 500],
    [500, 900],
    [300, 300],
  ]) {
    await page.evaluate(([w, h]) => window.resizeIframe(w, h), [width, height])

    await expect
      .poll(async () => {
        const metrics = await readCanvasMetrics(frame)
        return Math.abs(metrics.canvasWidth - Math.round(metrics.viewportRectWidth * metrics.dpr))
      })
      .toBeLessThanOrEqual(SIZE_TOLERANCE_PX)

    const metrics = await readCanvasMetrics(frame)
    expect(
      Math.abs(metrics.canvasHeight - Math.round(metrics.viewportRectHeight * metrics.dpr))
    ).toBeLessThanOrEqual(SIZE_TOLERANCE_PX)
  }
})
