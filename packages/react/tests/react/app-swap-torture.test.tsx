import { act, render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useState, type ReactNode } from "react"

import { App } from "../../src/core/module.js"
import { ModuleStatus } from "../../src/core/module-lifecycle.types.js"
import { AppProvider } from "../../src/react/AppProvider.js"
import { ModuleProvider } from "../../src/react/ModuleProvider.js"
import { useResolveOptional } from "../../src/react/useResolve.js"
import type { Provider } from "../../src/types.js"
import { flush, type HookCounts } from "../setup/helpers.js"
import { assertTreeInvariant } from "../setup/invariants.js"

// Replacing the App under a live tree
// ========================================
//
// AppProvider captures its App on first render and owns it from there: it is inited during render, mounted
// on effect, and unmounted + destroyed on cleanup. Handing a LIVE provider a different App instance is
// therefore not a swap but an error — the captured app is the one the whole subtree was built against.
//
// The factory form (`app={() => new App(...)}`) is exempt from that comparison, because a closure is a new
// reference on every render and would otherwise trip the guard immediately. Once the factory has run, later
// factory props are ignored; a later INSTANCE prop is still compared, and still throws.

// Per-generation tracking
// ========================================

type Life = { gen: number; counts: HookCounts }

type Generational = {
    provider: Provider
    /** One entry per constructed instance, in construction order. */
    lives: Life[]
}

function generational(log: string[], label: string): Generational {
    const lives: Life[] = []

    const Service = class {
        readonly life: Life

        constructor() {
            this.life = { gen: lives.length + 1, counts: { init: 0, mount: 0, unmount: 0, destroy: 0 } }
            lives.push(this.life)
            log.push(`${label}#${this.life.gen}:ctor`)
        }

        onModuleInit(): void {
            this.life.counts.init++
            log.push(`${label}#${this.life.gen}:init`)
        }

        onModuleMount(): void {
            this.life.counts.mount++
            log.push(`${label}#${this.life.gen}:mount`)
        }

        onModuleUnmount(): void {
            this.life.counts.unmount++
            log.push(`${label}#${this.life.gen}:unmount`)
        }

        async onModuleDestroy(): Promise<void> {
            this.life.counts.destroy++
            log.push(`${label}#${this.life.gen}:destroy`)
        }
    }

    return { provider: Service as unknown as Provider, lives }
}

/** Mounted and untouched. */
const LIVE: HookCounts = { init: 1, mount: 1, unmount: 0, destroy: 0 }
/** Went through the full arc exactly once. */
const BURIED: HookCounts = { init: 1, mount: 1, unmount: 1, destroy: 1 }

const counts = (subject: Generational): HookCounts[] => subject.lives.map((life) => life.counts)

// Probes
// ========================================

function silenceReactErrorLog(): () => void {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    return () => spy.mockRestore()
}

function SafeProbe({ token, into }: { token: symbol; into: Array<string | undefined> }): ReactNode {
    const value = useResolveOptional<string>(token)
    if (into.length === 0 || into.at(-1) !== value) into.push(value)
    return null
}

const MARK = Symbol.for("tests.app-swap.mark")
const ONLY_IN_A = Symbol.for("tests.app-swap.only-in-a")

const REPLACEMENT_ERROR = "AppProvider does not support replacing its App instance"

describe("passing a different App to a live <AppProvider>", () => {
    it("throws, naming the unsupported operation", () => {
        const a = new App({ id: "a" })
        const b = new App({ id: "b" })

        function Tree({ app }: { app: App }): ReactNode {
            return (
                <AppProvider app={app}>
                    <div />
                </AppProvider>
            )
        }

        const { rerender } = render(<Tree app={a} />)

        const restore = silenceReactErrorLog()
        expect(() => rerender(<Tree app={b} />)).toThrow(REPLACEMENT_ERROR)
        restore()
    })

    it("throws before the incoming App is touched, and React tears the captured one down", async () => {
        const first = generational([], "A")
        const second = generational([], "B")

        const a = new App({ id: "a", providers: [first.provider] })
        const b = new App({ id: "b", providers: [second.provider] })

        function Tree({ app }: { app: App }): ReactNode {
            return (
                <AppProvider app={app}>
                    <div />
                </AppProvider>
            )
        }

        const { rerender } = render(<Tree app={a} />)

        const restore = silenceReactErrorLog()
        expect(() => rerender(<Tree app={b} />)).toThrow(REPLACEMENT_ERROR)
        restore()

        // The guard runs before anything reads the incoming App, so `b` is untouched — never inited, no
        // instance ever built from it.
        expect(b.status).toBeOneOf([ModuleStatus.Created, ModuleStatus.Failed])
        expect(counts(second)).toEqual([])

        // MEASURED: the throw is a render error, so React unwinds the tree and runs the effect cleanup —
        // which unmounts and SCHEDULES the destroy. Nothing re-runs the setup, so nothing takes it back:
        // one macrotask later the captured app goes down with the tree rather than being stranded.
        await flush()
        expect(counts(first)).toEqual([BURIED])
        expect(a.status).toBeOneOf([ModuleStatus.Destroying, ModuleStatus.Destroyed])
        assertTreeInvariant(a)
        assertTreeInvariant(b)
    })

    it("re-renders with the SAME instance freely", () => {
        const first = generational([], "A")
        const a = new App({ id: "a", providers: [first.provider] })

        function Tree({ app, n }: { app: App; n: number }): ReactNode {
            return (
                <AppProvider app={app}>
                    <span data-testid="n">{n}</span>
                </AppProvider>
            )
        }

        const { rerender, getByTestId } = render(<Tree app={a} n={1} />)
        rerender(<Tree app={a} n={2} />)
        rerender(<Tree app={a} n={3} />)

        expect(getByTestId("n").textContent).toBe("3")
        expect(counts(first)).toEqual([LIVE])
        expect(a.status).toBe(ModuleStatus.Mounted)
    })
})

describe("<AppProvider app={() => new App(...)}>", () => {
    it("constructs once and runs the full cycle", async () => {
        const log: string[] = []
        const tracker = generational(log, "A")
        const apps: App[] = []
        let built = 0

        function Tree(): ReactNode {
            return (
                <AppProvider
                    app={() => {
                        built++
                        const app = new App({ id: "factory", providers: [tracker.provider] })
                        apps.push(app)
                        return app
                    }}
                >
                    <div />
                </AppProvider>
            )
        }

        const { unmount } = render(<Tree />)

        expect(built).toBe(1)
        expect(apps.length).toBe(1)
        expect(apps[0]!.status).not.toBeOneOf([ModuleStatus.Created, ModuleStatus.Failed])
        expect(apps[0]!.status).toBe(ModuleStatus.Mounted)
        expect(counts(tracker)).toEqual([LIVE])
        expect(log).toEqual(["A#1:ctor", "A#1:init", "A#1:mount"])

        unmount()
        await flush()

        expect(built).toBe(1)
        expect(counts(tracker)).toEqual([BURIED])
        expect(log).toEqual(["A#1:ctor", "A#1:init", "A#1:mount", "A#1:unmount", "A#1:destroy"])
        expect(apps[0]!.status).toBeOneOf([ModuleStatus.Destroying, ModuleStatus.Destroyed])
    })

    it("does not throw when the closure identity changes every render", () => {
        const tracker = generational([], "A")
        let built = 0

        function Tree({ n }: { n: number }): ReactNode {
            return (
                <AppProvider
                    app={() => {
                        built++
                        return new App({ id: "factory", providers: [tracker.provider] })
                    }}
                >
                    <span data-testid="n">{n}</span>
                </AppProvider>
            )
        }

        const { rerender, getByTestId } = render(<Tree n={1} />)
        rerender(<Tree n={2} />)
        rerender(<Tree n={3} />)

        expect(getByTestId("n").textContent).toBe("3")
        expect(built).toBe(1)
        expect(counts(tracker)).toEqual([LIVE])
    })

    it("throws when a later render passes an instance instead of the factory", async () => {
        const factoryTracker = generational([], "F")
        const otherTracker = generational([], "O")
        const other = new App({ id: "other", providers: [otherTracker.provider] })

        function Tree({ app }: { app: App | (() => App) }): ReactNode {
            return (
                <AppProvider app={app}>
                    <div />
                </AppProvider>
            )
        }

        const { rerender } = render(
            <Tree app={() => new App({ id: "factory", providers: [factoryTracker.provider] })} />
        )

        const restore = silenceReactErrorLog()
        expect(() => rerender(<Tree app={other} />)).toThrow(REPLACEMENT_ERROR)
        restore()

        // The exemption is for FACTORY props only: once an instance shows up it is compared like any other,
        // and it does not match what the factory built.
        expect(other.status).toBeOneOf([ModuleStatus.Created, ModuleStatus.Failed])

        await flush()
        expect(counts(factoryTracker)).toEqual([BURIED])
    })
})

// Nested apps
// ========================================

describe("an <AppProvider> nested inside another app's tree", () => {
    it("keeps the two trees parentless and independent", async () => {
        const log: string[] = []
        const outer = generational(log, "Outer")
        const inner = generational(log, "Inner")
        const outerSeen: Array<string | undefined> = []
        const innerSeen: Array<string | undefined> = []
        const innerOnlyInA: Array<string | undefined> = []
        let hide: () => void = () => {}

        const a = new App({
            id: "a",
            providers: [outer.provider, { provide: MARK, useValue: "from-a" }, { provide: ONLY_IN_A, useValue: "a" }],
        })
        const b = new App({ id: "b", providers: [inner.provider, { provide: MARK, useValue: "from-b" }] })

        function Harness(): ReactNode {
            const [nested, setNested] = useState(true)
            hide = () => setNested(false)
            return (
                <AppProvider app={a}>
                    <ModuleProvider id="outer">
                        <SafeProbe token={MARK} into={outerSeen} />
                        {nested ? (
                            <AppProvider app={b}>
                                <ModuleProvider id="inner">
                                    <SafeProbe token={MARK} into={innerSeen} />
                                    <SafeProbe token={ONLY_IN_A} into={innerOnlyInA} />
                                </ModuleProvider>
                            </AppProvider>
                        ) : null}
                    </ModuleProvider>
                </AppProvider>
            )
        }

        render(<Harness />)

        // Two roots, not a parent and a child: `new App(...)` pins `parent = null`, so nesting in JSX buys
        // no container relationship at all. The inner tree resolves from b and cannot see a's bindings.
        expect(b.parent).toBeNull()
        expect([...a.children]).not.toContain(b)
        expect(a.children.size).toBe(1)
        expect(outerSeen).toEqual(["from-a"])
        expect(innerSeen).toEqual(["from-b"])
        expect(innerOnlyInA).toEqual([undefined])
        expect(counts(outer)).toEqual([LIVE])
        expect(counts(inner)).toEqual([LIVE])

        log.length = 0
        await act(async () => hide())
        await flush()

        expect(log).toEqual(["Inner#1:unmount", "Inner#1:destroy"])
        expect(counts(inner)).toEqual([BURIED])
        expect(counts(outer)).toEqual([LIVE])
        expect(a.status).toBe(ModuleStatus.Mounted)
        expect(b.status).not.toBe(ModuleStatus.Mounted)
        expect(b.status).toBeOneOf([ModuleStatus.Destroying, ModuleStatus.Destroyed])
    })
})
