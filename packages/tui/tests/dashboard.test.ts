import { afterEach, describe, expect, test } from "bun:test"
import type { TestRendererSetup } from "@opentui/core/testing"
import { type RalphTuiLocale, type RunDashboardController, testRenderRunDashboard } from "../src"
import { EVALUATION_FIELDS, populatedSnapshot } from "./fixture"

const active: TestRendererSetup[] = []

afterEach(() => {
  for (const setup of active.splice(0)) {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
  }
})

async function renderAt(
  width: number,
  height: number,
  locale: RalphTuiLocale = "en",
): Promise<TestRendererSetup> {
  const setup = await testRenderRunDashboard(
    { snapshot: populatedSnapshot(), evaluationFields: EVALUATION_FIELDS, locale },
    { width, height },
  )
  active.push(setup)
  await setup.renderOnce()
  await Bun.sleep(0)
  return setup
}

describe("OpenTUI run dashboard", () => {
  test("renders the wide dashboard with a panel-width progress bar", async () => {
    const setup = await renderAt(112, 35)
    const frame = setup.captureCharFrame()

    expect(frame).toContain("RALPH · Vertical slice delivery")
    expect(frame).toContain("6/12 · 50%")
    expect(frame).toContain("Current task")
    expect(frame).toContain("executor")
    expect(frame).toContain("provider-final")
    expect(frame).toContain("ENGINE / TOOLS / GATES / JUDGE")
    expect(frame).toContain("74/85")

    const progressLine = frame.split("\n").find((line) => line.includes("████"))
    expect(progressLine).toBeDefined()
    expect(progressLine?.match(/█/g)?.length).toBe(53)
    expect(progressLine?.match(/░/g)?.length).toBe(53)
  })

  test("renders a narrow terminal without losing status and role usage", async () => {
    const setup = await renderAt(48, 40)
    const frame = setup.captureCharFrame()

    expect(frame).toContain("6/12 · 50%")
    expect(frame).toContain("STATUS / USAGE / WATCHDOG")
    expect(frame).toContain("executor")
    expect(frame).toContain("judge")
    const progressLine = frame.split("\n").find((line) => line.includes("████"))
    expect(progressLine?.match(/█/g)?.length).toBe(21)
    expect(progressLine?.match(/░/g)?.length).toBe(21)
  })

  test("reacts to a new snapshot and terminal resize", async () => {
    const initialSnapshot = populatedSnapshot()
    let controller: RunDashboardController | undefined
    const setup = await testRenderRunDashboard(
      {
        snapshot: initialSnapshot,
        evaluationFields: EVALUATION_FIELDS,
        controllerRef: (nextController) => {
          controller = nextController
        },
      },
      { width: 112, height: 35 },
    )
    active.push(setup)
    await setup.renderOnce()

    controller?.updateSnapshot({
      ...initialSnapshot,
      status: "completed",
      progress: { completed: 12, total: 12 },
    })
    setup.resize(48, 40)
    await setup.flush()
    const frame = setup.captureCharFrame()

    expect(frame).toContain("completed")
    expect(frame).toContain("006")
    expect(frame).toContain("12/12 · 100%")
    const progressLine = frame.split("\n").find((line) => line.includes("████"))
    expect(progressLine?.match(/█/g)?.length).toBe(42)
    expect(progressLine).not.toContain("░")
  })

  test("opens a read-only evaluation popup, changes feedback tab, and closes on Esc", async () => {
    const setup = await renderAt(96, 38)

    await setup.mockInput.typeText("e", 0)
    await Bun.sleep(10)
    await setup.flush()
    let frame = setup.captureCharFrame()
    expect(frame).toContain("EVALUATION · READ ONLY")
    expect(frame).toContain("Evaluation mode: external")
    expect(frame).toContain("origin=cli (cli:--evaluation)")
    expect(frame).toContain("config=evaluation.mode")
    expect(frame).toContain("CLI=--evaluation-mode")
    expect(frame).toContain("Judge threshold: 85")
    expect(frame).toContain("origin=workspace (workspace:evaluation.threshold)")
    expect(frame).toContain("Credential: [secret hidden]")
    expect(frame).not.toContain("must-never-render")
    expect(frame).toContain("[adequate]")
    expect(frame).toContain("UI reads a provider-neutral snapshot")
    expect(frame).not.toMatch(/\bapply\b|\bsave\b/i)

    setup.mockInput.pressTab()
    await Bun.sleep(10)
    await setup.flush()
    frame = setup.captureCharFrame()
    expect(frame).toContain("[problems]")
    expect(frame).toContain("Missing narrow-terminal evidence")

    setup.mockInput.pressEscape()
    await Bun.sleep(100)
    await setup.flush()
    expect(setup.captureCharFrame()).not.toContain("EVALUATION · READ ONLY")
  })

  test("q destroys the renderer when no quit override is supplied", async () => {
    const setup = await renderAt(80, 30)
    await setup.mockInput.typeText("q", 0)
    await Bun.sleep(20)
    expect(setup.renderer.isDestroyed).toBeTrue()
  })

  test("renders stable semantic terminal snapshots in EN and PT-BR", async () => {
    const english = (await renderAt(112, 35, "en")).captureCharFrame()
    const portuguese = (await renderAt(112, 35, "pt-BR")).captureCharFrame()

    expect({
      currentTask: english.includes("Current task"),
      progress: english.includes("Progress"),
      usage: english.includes("STATUS / USAGE / WATCHDOG"),
      details: english.includes("ENGINE / TOOLS / GATES / JUDGE"),
      revisions: english.includes("revisions 1/3"),
      noPortugueseHeading: !english.includes("STATUS / USO / WATCHDOG"),
    }).toEqual({
      currentTask: true,
      progress: true,
      usage: true,
      details: true,
      revisions: true,
      noPortugueseHeading: true,
    })
    expect({
      currentTask: portuguese.includes("Task atual"),
      progress: portuguese.includes("Progresso"),
      usage: portuguese.includes("STATUS / USO / WATCHDOG"),
      details: portuguese.includes("ENGINE / FERRAMENTAS / GATES / JUIZ"),
      revisions: portuguese.includes("revisões 1/3"),
      noEnglishHeading: !portuguese.includes("STATUS / USAGE / WATCHDOG"),
    }).toEqual({
      currentTask: true,
      progress: true,
      usage: true,
      details: true,
      revisions: true,
      noEnglishHeading: true,
    })
  })
})
