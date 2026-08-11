import { act, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Activity, StrictMode, useState, type ReactNode } from "react"

import type { Provider } from "../../src/core/provider.types.js"
import { App, type Module } from "../../src/core/module.js"
import { ModuleStatus } from "../../src/core/module-lifecycle.types.js"
import { AppProvider } from "../../src/react/AppProvider.js"
import { ModuleProvider } from "../../src/react/ModuleProvider.js"
import { useModuleContext } from "../../src/react/useModuleContext.js"
import { Root } from "../setup/react.js"
import { flush, refuses } from "../setup/helpers.js"

// react-dom entry points
// ========================================
//
// `@types/react-dom` is not a dependency of this package — nothing in `src` imports react-dom, and this is
// the first test to need its server/client entry points. Rather than pull a types package in for two
// functions, they are imported dynamically and typed locally to exactly the surface used here. The
// suppressions go away on their own the day someone adds `@types/react-dom`: the directive would then be
// unused and `typecheck:tests` would say so.

type ReactDomServer = { renderToString: (element: ReactNode) => string }
type ReactDomClient = {
    hydrateRoot: (container: Element | DocumentFragment, children: ReactNode) => { unmount: () => void }
}

// @ts-expect-error -- untyped without @types/react-dom; the local type above is the contract used here.
const { renderToString } = (await import("react-dom/server")) as unknown as ReactDomServer
// @ts-expect-error -- untyped without @types/react-dom; the local type above is the contract used here.
const { hydrateRoot } = (await import("react-dom/client")) as unknown as ReactDomClient

// Environment torture — SSR, StrictMode and <Activity>
// ========================================
//
// Three environments the package makes no promises about, isolated here because they need their own
// renderers and their own console handling. Everything below is the CURRENT measured behavior
// (React 19.2 + jsdom), asserted exactly, so a change to it fails a test instead of drifting unnoticed.
//
// SSR comes out clean and is worth having as a floor. StrictMode and `<Activity>` do NOT — both are
// unsupported, and those tests exist to document the failure mode, not to bless it. They share one root
// cause: both simulate a remount by running effect cleanups and then re-running the setups, and the module
// lifecycle's cleanup is terminal — `ModuleProvider` destroys on cleanup, and a destroyed module refuses
// every later signal.

// Tracking
// ========================================

type Generation = { init: number; mount: number; unmount: number; destroy: number }

type Tracker = {
    provider: Provider
    /** One entry per constructed instance — i.e. per module generation — in construction order. */
    generations: Generation[]
}

function genTracker(log: string[] = [], label = "S"): Tracker {
    const generations: Generation[] = []

    const Service = class {
        readonly gen: Generation = { init: 0, mount: 0, unmount: 0, destroy: 0 }
        readonly n: number

        constructor() {
            this.n = generations.push(this.gen)
            log.push(`${label}${this.n}:ctor`)
        }

        onModuleInit() {
            this.gen.init++
            log.push(`${label}${this.n}:init`)
        }

        onModuleMount() {
            this.gen.mount++
            log.push(`${label}${this.n}:mount`)
        }

        onModuleUnmount() {
            this.gen.unmount++
            log.push(`${label}${this.n}:unmount`)
        }

        async onModuleDestroy() {
            this.gen.destroy++
            log.push(`${label}${this.n}:destroy`)
        }
    }

    return { provider: Service as unknown as Provider, generations }
}

function captureConsoleError(): { calls: unknown[][]; restore: () => void } {
    const calls: unknown[][] = []
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        calls.push(args)
    })
    return { calls, restore: () => spy.mockRestore() }
}

const text = (calls: unknown[][]): string => calls.map((call) => call.map(String).join(" ")).join("\n")

// SSR
// ========================================

function silenceReactErrorLog(): () => void {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    return () => spy.mockRestore()
}

describe("server rendering", () => {
    it("renders <AppProvider><ModuleProvider> to a string without crashing", () => {
        const console = captureConsoleError()
        const tracker = genTracker()
        const app = new App({ id: "ssr-app" })

        const html = renderToString(
            <AppProvider app={app}>
                <ModuleProvider id="ssr-module" providers={[tracker.provider]}>
                    <span>server content</span>
                </ModuleProvider>
            </AppProvider>
        )

        console.restore()

        expect(html).toContain("server content")

        // Init is render-phase work, so it DOES run on the server: the module is built and inited.
        expect(app.status).not.toBeOneOf([ModuleStatus.Created, ModuleStatus.Failed])
        expect(tracker.generations.length).toBe(1)

        // Mount is an effect, and effects never run on the server. Nothing mounts, nothing is destroyed —
        // so a server-rendered module is an inited object that is garbage the moment the response is sent.
        // Same abandonment constraint as a suspended render: keep onModuleInit free of resource acquisition.
        expect(tracker.generations[0]).toEqual({ init: 1, mount: 0, unmount: 0, destroy: 0 })
        expect(app.status).not.toBe(ModuleStatus.Mounted)
    })

    it("renders clean — no warning, not even about layout effects on the server", () => {
        const console = captureConsoleError()
        const app = new App()

        renderToString(
            <AppProvider app={app}>
                <ModuleProvider>
                    <span>content</span>
                </ModuleProvider>
            </AppProvider>
        )

        console.restore()

        // Worth pinning because it is not free: ModuleProvider's rebuild plumbing goes through
        // `useIsomorphicLayoutEffect`, which branches on `typeof window === "undefined"` — and under jsdom
        // `window` exists even while rendering to a string, so the LAYOUT branch is what runs here. It stays
        // silent, so the isomorphic branch is not load-bearing for a clean server render.
        expect(console.calls).toEqual([])
    })

    it("survives nested ModuleProviders and resolves through the forked containers", () => {
        const console = captureConsoleError()
        const outer = genTracker([], "Outer")
        const inner = genTracker([], "Inner")
        const app = new App()

        const html = renderToString(
            <AppProvider app={app}>
                <ModuleProvider id="outer" providers={[outer.provider]}>
                    <ModuleProvider id="inner" providers={[inner.provider]}>
                        <span>nested</span>
                    </ModuleProvider>
                </ModuleProvider>
            </AppProvider>
        )

        console.restore()

        expect(html).toContain("nested")
        expect(outer.generations).toEqual([{ init: 1, mount: 0, unmount: 0, destroy: 0 }])
        expect(inner.generations).toEqual([{ init: 1, mount: 0, unmount: 0, destroy: 0 }])

        // Attachment happens on mount, which never ran, so the server-side tree is structurally unlinked.
        expect(app.children.size).toBe(0)
    })

    it("hydrates the server markup on a fresh app without a mismatch", async () => {
        const server = genTracker([], "Server")
        const client = genTracker([], "Client")

        const tree = (app: App, tracker: Tracker): ReactNode => (
            <AppProvider app={app}>
                <ModuleProvider id="hydrated" providers={[tracker.provider]}>
                    <span data-testid="content">hydrate me</span>
                </ModuleProvider>
            </AppProvider>
        )

        const ssrConsole = captureConsoleError()
        const html = renderToString(tree(new App(), server))
        ssrConsole.restore()

        const host = document.createElement("div")
        host.innerHTML = html
        document.body.appendChild(host)

        const clientApp = new App()
        const hydrationConsole = captureConsoleError()
        let root: ReturnType<typeof hydrateRoot> | null = null
        await act(async () => {
            root = hydrateRoot(host, tree(clientApp, client))
        })
        hydrationConsole.restore()

        // No hydration warning, and the client took ownership: the client module ran the full render-phase
        // init AND the effect-phase mount.
        expect(text(hydrationConsole.calls)).not.toMatch(/hydrat|did not match|Text content does not match/i)
        expect(host.querySelector("[data-testid='content']")?.textContent).toBe("hydrate me")
        expect(client.generations).toEqual([{ init: 1, mount: 1, unmount: 0, destroy: 0 }])
        expect(clientApp.status).toBe(ModuleStatus.Mounted)

        // The server generation is a different object and stayed exactly where SSR left it.
        expect(server.generations).toEqual([{ init: 1, mount: 0, unmount: 0, destroy: 0 }])

        await act(async () => {
            root?.unmount()
        })
        await flush()
        host.remove()

        expect(client.generations).toEqual([{ init: 1, mount: 1, unmount: 1, destroy: 1 }])
    })
})

// StrictMode
// ========================================
//
// StrictMode LEAVES A LIVING TREE. It used to leave a corpse, and the flip is the whole point of the
// deferred destroy: StrictMode's simulated remount runs every effect cleanup and then re-runs every setup
// on the SAME fibers, and the module lifecycle's cleanup used to be terminal. Now the cleanup unmounts and
// only SCHEDULES the destroy, and the re-run cancels the timer and remounts the same module.
//
// What StrictMode still costs is the RENDER half of the double-invocation, which no lifecycle change can
// touch: the `useState` initializer that builds and inits a module runs twice, so a second module is built
// and inited per boundary and then abandoned by React mid-render. It is never mounted and never destroyed —
// keep `onModuleInit` free of resource acquisition, the same constraint SSR and a suspended render impose.

describe("StrictMode", () => {
    it("leaves a mounted tree ALIVE: the simulated remount cancels the destroy and mounts again", async () => {
        const log: string[] = []
        const appTracker = genTracker(log, "App")
        const tracker = genTracker(log)
        const modules: Module[] = []

        function Probe(): ReactNode {
            modules.push(useModuleContext().module)
            return null
        }

        const { unmount } = render(
            <StrictMode>
                <Root providers={[appTracker.provider]}>
                    <ModuleProvider providers={[tracker.provider]}>
                        <Probe />
                    </ModuleProvider>
                </Root>
            </StrictMode>
        )
        await flush()

        // MEASURED, EXACT — and the App is pinned alongside the module now, because AppProvider survives
        // the same way ModuleProvider does. Both levels take mount → unmount → mount and no destroy.
        //
        // 1. The render initializer runs twice, so TWO modules are built and inited (S1, S2). React keeps
        //    the first; S2 is abandoned mid-render — inited, never mounted, therefore never destroyed.
        // 2. Effects fire child-first, so S1 only COMMITS on the first pass (its App is not mounted yet)
        //    and the App's cascade is what runs its mount hook.
        // 3. The cleanup pass unmounts both and schedules two destroys; the setup pass cancels both timers
        //    and remounts, and the App's cascade carries S1 back up with it.
        expect(log).toEqual([
            "App1:ctor",
            "App1:init",
            "S1:ctor",
            "S1:init",
            "S2:ctor",
            "S2:init",
            "App1:mount",
            "S1:mount",
            "S1:unmount",
            "App1:unmount",
            "App1:mount",
            "S1:mount",
        ])

        expect(tracker.generations.length).toBe(2)
        expect(tracker.generations[0]).toEqual({ init: 1, mount: 2, unmount: 1, destroy: 0 })
        expect(tracker.generations[1]).toEqual({ init: 1, mount: 0, unmount: 0, destroy: 0 })
        expect(appTracker.generations).toEqual([{ init: 1, mount: 2, unmount: 1, destroy: 0 }])

        // The live tree is holding a module that is mounted, attached, and the one React committed.
        const committed = modules.at(-1)!
        expect(new Set(modules).size).toBe(1)
        expect(committed.status).toBe(ModuleStatus.Mounted)

        // And the real unmount is a real unmount: it still has both teardown phases left to run.
        log.length = 0
        unmount()
        await flush()
        expect(log).toEqual(["S1:unmount", "App1:unmount", "S1:destroy", "App1:destroy"])
        expect(tracker.generations[0]).toEqual({ init: 1, mount: 2, unmount: 2, destroy: 1 })
    })

    it("is the same story for a nested boundary — both levels come back mounted", async () => {
        const log: string[] = []
        const parent = genTracker(log, "P")
        const child = genTracker(log, "C")

        render(
            <StrictMode>
                <Root>
                    <ModuleProvider providers={[parent.provider]}>
                        <ModuleProvider providers={[child.provider]}>
                            <div />
                        </ModuleProvider>
                    </ModuleProvider>
                </Root>
            </StrictMode>
        )
        await flush()

        // Two generations at each level; the committed one at each level mounts twice and is never
        // destroyed, and the second (abandoned) one at each level is inited and then dropped.
        expect(parent.generations).toEqual([
            { init: 1, mount: 2, unmount: 1, destroy: 0 },
            { init: 1, mount: 0, unmount: 0, destroy: 0 },
        ])
        expect(child.generations).toEqual([
            { init: 1, mount: 2, unmount: 1, destroy: 0 },
            { init: 1, mount: 0, unmount: 0, destroy: 0 },
        ])
    })

    it("survives the FACTORY form of <AppProvider> too, which mints a second App and abandons it", async () => {
        const log: string[] = []
        const tracker = genTracker(log, "App")
        const apps: Module[] = []

        function Probe(): ReactNode {
            apps.push(useModuleContext().module)
            return null
        }

        render(
            <StrictMode>
                <AppProvider app={() => new App({ providers: [tracker.provider] })}>
                    <Probe />
                </AppProvider>
            </StrictMode>
        )
        await flush()

        // IMPROVED when arming moved out of the `useState` initializer. The factory still runs twice under
        // StrictMode, so a second App object is still minted and abandoned — but nothing inits it any more,
        // so it constructs no providers and runs no user hook. The abandoned generation is now inert rather
        // than half-alive, which is why it has vanished from this log entirely and from the generation list
        // below. The one React kept survives the effect double-invocation exactly as the instance form does.
        expect(log).toEqual(["App1:ctor", "App1:init", "App1:mount", "App1:unmount", "App1:mount"])
        expect(tracker.generations).toEqual([{ init: 1, mount: 2, unmount: 1, destroy: 0 }])

        const live = apps.at(-1)!
        expect(new Set(apps).size).toBe(1)
        expect(live.status).toBe(ModuleStatus.Mounted)
        expect(live.status).not.toBe(ModuleStatus.Destroyed)
    })
})

// <Activity>
// ========================================
//
// `<Activity>` is UNSUPPORTED, and these tests document the current failure mode rather than bless it —
// same framing as the StrictMode block above. It is stable in the installed React (19.2.4 exports
// `Activity`, not `unstable_Activity`), so the behavior is measurable rather than a doc line.
//
// The premise of `<Activity mode="hidden">` is that state SURVIVES while effects do not: React runs every
// effect cleanup in the subtree on hide and re-runs every setup on reveal, keeping the fibers and their
// hook state. The deferred destroy honours that premise for as long as the timer takes to fire — a QUICK
// toggle is now indistinguishable from a module that never left. What it cannot honour is a LONG hide:
// once the timer fires the module is claimed, and nothing in React says "this subtree is coming back", so
// there is no signal to hold the destroy open on. That case is still a burial, and it is pinned as one.

describe("<Activity>", () => {
    it("survives a quick hide/reveal — the destroy is cancelled and the SAME module remounts", async () => {
        const log: string[] = []
        const tracker = genTracker(log)
        const modules: Module[] = []

        function Probe(): ReactNode {
            modules.push(useModuleContext().module)
            return null
        }

        let setMode: (mode: "visible" | "hidden") => void = () => {}
        function Harness(): ReactNode {
            const [mode, set] = useState<"visible" | "hidden">("visible")
            setMode = set
            return (
                <Root>
                    <Activity mode={mode}>
                        <ModuleProvider providers={[tracker.provider]}>
                            <Probe />
                        </ModuleProvider>
                    </Activity>
                </Root>
            )
        }

        render(<Harness />)
        log.length = 0

        // Hide and reveal inside the window — no `flush()` between them, so the scheduled destroy never
        // gets a turn. The reveal cancels it and the module takes the `unmounted → mount()` cell.
        await act(async () => setMode("hidden"))
        await act(async () => setMode("visible"))
        await flush()

        expect(log).toEqual(["S1:unmount", "S1:mount"])
        expect(tracker.generations).toEqual([{ init: 1, mount: 2, unmount: 1, destroy: 0 }])

        // Same instance, not a rebuild: nothing was reconstructed and nothing was re-inited.
        const survivor = modules.at(-1)!
        expect(new Set(modules).size).toBe(1)
        expect(survivor.status).toBe(ModuleStatus.Mounted)
        expect(survivor.status).not.toBe(ModuleStatus.Destroyed)
    })

    it("buries the module when the hide OUTLASTS the timer, and the reveal is then a silent no-op", async () => {
        const log: string[] = []
        const tracker = genTracker(log)
        const modules: Module[] = []

        function Probe(): ReactNode {
            modules.push(useModuleContext().module)
            return null
        }

        let setMode: (mode: "visible" | "hidden") => void = () => {}
        function Harness(): ReactNode {
            const [mode, set] = useState<"visible" | "hidden">("visible")
            setMode = set
            return (
                <Root>
                    <Activity mode={mode}>
                        <ModuleProvider providers={[tracker.provider]}>
                            <Probe />
                            <span data-testid="content">content</span>
                        </ModuleProvider>
                    </Activity>
                </Root>
            )
        }

        const { queryByTestId } = render(<Harness />)
        expect(log).toEqual(["S1:ctor", "S1:init", "S1:mount"])
        log.length = 0

        // Hide, then let the timer fire: the module is unmounted by the cleanup and destroyed a macrotask
        // later — while the subtree is still rendered and its DOM is still in the document.
        await act(async () => setMode("hidden"))
        await flush()

        expect(log).toEqual(["S1:unmount", "S1:destroy"])
        expect(queryByTestId("content")).toBeInTheDocument()

        const buried = modules.at(-1)!
        expect(buried.status).toBeOneOf([ModuleStatus.Destroying, ModuleStatus.Destroyed])
        expect(buried.status).not.toBe(ModuleStatus.Mounted)
        expect(buried.status).not.toBeOneOf([ModuleStatus.Created, ModuleStatus.Failed])
        log.length = 0

        // ==================== MEASURED — the reveal is a no-op ====================
        //
        // React re-runs ModuleProvider's effect setup on the SAME module it preserved, and the window is
        // shut: the module is claimed, so `mount()` would THROW there. `useModuleLifecycle` checks
        // `destroyed` first and declines rather than crashing the commit — a corpse under a live tree is
        // bad, a hard error on every Activity reveal is worse. Nothing is rebuilt (the `useState`
        // initializer is not re-run), nothing mounts, nothing errors. The subtree renders normally over a
        // module whose providers have already had their destroy hooks, so every service in it is holding
        // released resources.
        await act(async () => setMode("visible"))
        await flush()

        expect(log).toEqual([])
        expect(tracker.generations).toEqual([{ init: 1, mount: 1, unmount: 1, destroy: 1 }])
        expect(new Set(modules).size).toBe(1)
        expect(modules.at(-1)).toBe(buried)
        expect(buried.status).not.toBe(ModuleStatus.Mounted)
        expect(queryByTestId("content")).toBeInTheDocument()
    })

    it("survives exactly one visible period when the boundary starts hidden", async () => {
        const log: string[] = []
        const tracker = genTracker(log)

        let setMode: (mode: "visible" | "hidden") => void = () => {}
        function Harness(): ReactNode {
            const [mode, set] = useState<"visible" | "hidden">("hidden")
            setMode = set
            return (
                <Root>
                    <Activity mode={mode}>
                        <ModuleProvider providers={[tracker.provider]}>
                            <span data-testid="content">content</span>
                        </ModuleProvider>
                    </Activity>
                </Root>
            )
        }

        const { queryByTestId } = render(<Harness />)
        await flush()

        // A hidden boundary still RENDERS its children — so the module is built and inited, and only the
        // effect-phase mount is withheld. Same abandonment shape as SSR or a suspended render.
        expect(log).toEqual(["S1:ctor", "S1:init"])
        expect(queryByTestId("content")).toBeInTheDocument()
        log.length = 0

        // The first reveal is the one that works: the effect setup finally runs and the module mounts.
        await act(async () => setMode("visible"))
        await flush()
        expect(log).toEqual(["S1:mount"])
        log.length = 0

        // And the first hide that outlasts the timer spends it. Everything after this is the dead tree of
        // the test above; a hide short enough to stay inside the window would not have cost it anything.
        await act(async () => setMode("hidden"))
        await flush()
        expect(log).toEqual(["S1:unmount", "S1:destroy"])
        expect(tracker.generations).toEqual([{ init: 1, mount: 1, unmount: 1, destroy: 1 }])
    })

    it("buries the App when Activity wraps <AppProvider> over a long hide, and reveal is a no-op", async () => {
        const log: string[] = []
        const tracker = genTracker(log, "App")
        const apps: Module[] = []

        function Probe(): ReactNode {
            apps.push(useModuleContext().module)
            return null
        }

        let setMode: (mode: "visible" | "hidden") => void = () => {}
        function Harness(): ReactNode {
            const [mode, set] = useState<"visible" | "hidden">("visible")
            setMode = set
            return (
                <Activity mode={mode}>
                    <Root providers={[tracker.provider]}>
                        <Probe />
                    </Root>
                </Activity>
            )
        }

        render(<Harness />)
        log.length = 0

        // Hide unmounts the App and schedules its destroy; the flush is what makes this a LONG hide, and
        // the App is buried while its subtree is still rendered.
        await act(async () => setMode("hidden"))
        await flush()
        expect(log).toEqual(["App1:unmount", "App1:destroy"])
        log.length = 0

        // FLIPPED from a silent no-op to a loud refusal. `useModuleLifecycle` still declines to mount a
        // buried module — that part is unchanged, and the counts below prove it — but the reveal no longer
        // gets that far: `AppProvider` now reads the App's status on the way through and refuses to render
        // over a corpse at all. The guarantee the cell was written for ("reveal does not revive it") is
        // strictly stronger now; what changed is that a consumer is told, instead of being handed a tree
        // wired to a dead App.
        const app = apps.at(-1)!
        expect(app.status).toBeOneOf([ModuleStatus.Destroying, ModuleStatus.Destroyed])

        const restore = silenceReactErrorLog()
        await expect(act(async () => setMode("visible"))).rejects.toThrow(
            "App was destroyed. Provide a fresh App."
        )
        restore()

        expect(log).toEqual([])
        expect(tracker.generations).toEqual([{ init: 1, mount: 1, unmount: 1, destroy: 1 }])
        expect(app.status).not.toBe(ModuleStatus.Mounted)
    })

    it("comes back from a LONG hide only through an explicit rebuild(), which mints a fresh generation", async () => {
        const log: string[] = []
        const tracker = genTracker(log)
        let rebuild: () => void = () => {}

        function Probe(): ReactNode {
            rebuild = useModuleContext().rebuild
            return null
        }

        let setMode: (mode: "visible" | "hidden") => void = () => {}
        function Harness(): ReactNode {
            const [mode, set] = useState<"visible" | "hidden">("visible")
            setMode = set
            return (
                <Root>
                    <Activity mode={mode}>
                        <ModuleProvider providers={[tracker.provider]}>
                            <Probe />
                        </ModuleProvider>
                    </Activity>
                </Root>
            )
        }

        render(<Harness />)

        // The flush between hide and reveal is what makes this a LONG hide — without it the module would
        // simply come back, and there would be nothing for rebuild() to repair.
        await act(async () => setMode("hidden"))
        await flush()
        await act(async () => setMode("visible"))
        await flush()
        log.length = 0

        // The documented escape hatch, if an app insists on outliving the window: rebuild() replaces the
        // buried module wholesale, and the new generation goes through init and mount normally.
        await act(async () => rebuild())
        await flush()

        expect(log).toEqual(["S2:ctor", "S2:init", "S2:mount"])
        expect(tracker.generations).toEqual([
            { init: 1, mount: 1, unmount: 1, destroy: 1 },
            { init: 1, mount: 1, unmount: 0, destroy: 0 },
        ])
    })
})

// The deferred-destroy window
// ========================================
//
// The two tests above depend on the window being open or shut, and both express that through `flush()` —
// which is honest but implicit. These two pin the window itself, on FAKE timers, so the boundary is the
// clock rather than a happens-to-be-true ordering between two macrotasks.

describe("the deferred-destroy window", () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    /** An Activity boundary over one ModuleProvider, plus handles on the mode and the committed module. */
    function windowHarness(log: string[]): {
        tracker: Tracker
        modules: Module[]
        setMode: (mode: "visible" | "hidden") => void
    } {
        const tracker = genTracker(log)
        const modules: Module[] = []
        let setMode: (mode: "visible" | "hidden") => void = () => {}

        function Probe(): ReactNode {
            modules.push(useModuleContext().module)
            return null
        }

        function Harness(): ReactNode {
            const [mode, set] = useState<"visible" | "hidden">("visible")
            setMode = set
            return (
                <Root>
                    <Activity mode={mode}>
                        <ModuleProvider providers={[tracker.provider]}>
                            <Probe />
                        </ModuleProvider>
                    </Activity>
                </Root>
            )
        }

        render(<Harness />)
        log.length = 0

        return { tracker, modules, setMode: (mode) => setMode(mode) }
    }

    it("OPEN: unmount → mount before the timer keeps the same instance and fires no destroy hook", () => {
        const log: string[] = []
        const { tracker, modules, setMode } = windowHarness(log)

        act(() => setMode("hidden"))
        expect(log).toEqual(["S1:unmount"])

        // Not one tick of the clock has passed, so the scheduled destroy is still cancellable.
        act(() => setMode("visible"))
        expect(log).toEqual(["S1:unmount", "S1:mount"])

        // And the timer is GONE, not merely outrun: draining the whole queue produces nothing.
        act(() => vi.runAllTimers())

        expect(log).toEqual(["S1:unmount", "S1:mount"])
        expect(tracker.generations).toEqual([{ init: 1, mount: 2, unmount: 1, destroy: 0 }])
        expect(new Set(modules).size).toBe(1)
        expect(modules.at(-1)!.status).toBe(ModuleStatus.Mounted)
    })

    it("SHUT: once the timer fires the module is claimed, and a later mount() is REFUSED", async () => {
        const log: string[] = []
        const { tracker, modules, setMode } = windowHarness(log)

        act(() => setMode("hidden"))
        expect(log).toEqual(["S1:unmount"])

        act(() => vi.runAllTimers())

        expect(log).toEqual(["S1:unmount", "S1:destroy"])
        expect(tracker.generations).toEqual([{ init: 1, mount: 1, unmount: 1, destroy: 1 }])

        // The claim is synchronous and the drain is not, so the window is already shut here while the status
        // is still `destroying`: `claimed` covers both halves, `destroyed` is the settled one.
        const buried = modules.at(-1)!
        expect(buried.status).toBeOneOf([ModuleStatus.Destroying, ModuleStatus.Destroyed])
        expect(buried.status).not.toBe(ModuleStatus.Destroyed)

        // The reveal stays silent — but only because the HOOK checks before it signals. `useModuleLifecycle`
        // mounts on setup just from `initialized | unmounted`, and a claimed module is neither, so the
        // re-entering effect sends nothing at all. React sees no error; the module is simply not revived.
        act(() => setMode("visible"))
        expect(log).toEqual(["S1:unmount", "S1:destroy"])

        // The module itself is not silent. A caller reaching past the hook is refused, in both windows —
        // this is the owner's loud-refusal ruling for mounting a corpse, landed.
        expect(() => buried.mount()).toThrow(refuses("mount", "destroying"))

        await act(async () => {})

        expect(buried.status).toBe(ModuleStatus.Destroyed)
        expect(() => buried.mount()).toThrow(refuses("mount", "destroyed"))
        expect(log).toEqual(["S1:unmount", "S1:destroy"])
    })
})
