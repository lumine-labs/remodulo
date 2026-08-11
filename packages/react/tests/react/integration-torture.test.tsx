import { act, render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import {
    Component,
    Suspense,
    createContext,
    lazy,
    use,
    useContext,
    useState,
    type ComponentType,
    type ReactNode,
} from "react"

import type { Provider } from "../../src/core/provider.types.js"
import type { Module } from "../../src/core/module.js"
import { ModuleTraversal } from "../../src/core/module-traversal.js"
import { ModuleProvider } from "../../src/react/ModuleProvider.js"
import { useModuleContext } from "../../src/react/useModuleContext.js"
import { Root } from "../setup/react.js"
import { flush } from "../setup/helpers.js"

// React integration torture
// ========================================
//
// Everything here is about what the RENDERER does to a module boundary: conditional mounting, keys,
// rapid toggling, dynamic nesting, context above the boundary, Suspense and error boundaries. The
// per-cycle counts are the point — `tracked()` in the shared helpers aggregates across every module that
// ever registered it, and the questions below are all "what happened to *that* generation", so this file
// uses its own per-instance tracker.
//
// Where a number is pinned rather than derived, it was MEASURED (React 19.2 + jsdom) and is pinned so a
// change in it is noticed. Two measured facts are flagged inline as leaks; both come from the same root
// cause — the module is constructed and inited in ModuleProvider's render-phase `useState` initializer,
// so a render attempt that never commits produces a module nothing will ever unmount or destroy.

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

/** Built, inited, mounted, still live. */
const ALIVE: Generation = { init: 1, mount: 1, unmount: 0, destroy: 0 }
/** Built, inited, mounted, torn all the way down. */
const DISPOSED: Generation = { init: 1, mount: 1, unmount: 1, destroy: 1 }
/** Built and inited by a render attempt that never committed — never mounts, so never unmounts. */
const ABANDONED: Generation = { init: 1, mount: 0, unmount: 0, destroy: 0 }

function silenceReactErrorLog(): () => void {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    return () => spy.mockRestore()
}

// Probes
// ========================================

function moduleProbe(sink: Module[]) {
    return function Probe(): ReactNode {
        sink.push(useModuleContext().module)
        return null
    }
}

// Error boundary
// ========================================

type BoundaryProps = { children?: ReactNode; onError?: (error: Error) => void }
type BoundaryState = { error: Error | null }

class Boundary extends Component<BoundaryProps, BoundaryState> {
    state: BoundaryState = { error: null }

    static getDerivedStateFromError(error: Error): BoundaryState {
        return { error }
    }

    componentDidCatch(error: Error): void {
        this.props.onError?.(error)
    }

    render(): ReactNode {
        if (this.state.error) return <span data-testid="fallback">{this.state.error.message}</span>
        return this.props.children
    }
}

// Conditional mount / unmount cycling
// ========================================

describe("conditional mount/unmount cycling", () => {
    it("runs exactly one full four-phase life per cycle, on a fresh module each time", async () => {
        const tracker = genTracker()
        const modules: Module[] = []
        const Probe = moduleProbe(modules)
        let show: (visible: boolean) => void = () => {}

        function Harness(): ReactNode {
            const [visible, setVisible] = useState(false)
            show = setVisible
            return (
                <Root>
                    {visible ? (
                        <ModuleProvider providers={[tracker.provider]}>
                            <Probe />
                        </ModuleProvider>
                    ) : null}
                </Root>
            )
        }

        render(<Harness />)
        expect(tracker.generations).toEqual([])

        const CYCLES = 3
        for (let cycle = 0; cycle < CYCLES; cycle++) {
            // eslint-disable-next-line no-await-in-loop
            await act(async () => show(true))
            expect(tracker.generations.length).toBe(cycle + 1)
            expect(tracker.generations[cycle]).toEqual(ALIVE)

            // eslint-disable-next-line no-await-in-loop
            await act(async () => show(false))
            // eslint-disable-next-line no-await-in-loop
            await flush()
            expect(tracker.generations[cycle]).toEqual(DISPOSED)
        }

        // Every phase ran exactly once per cycle, and no generation outlived its cycle.
        expect(tracker.generations.length).toBe(CYCLES)
        for (const generation of tracker.generations) expect(generation).toEqual(DISPOSED)

        // A fresh module per cycle — no instance and no id is reused.
        expect(modules.length).toBe(CYCLES)
        expect(new Set(modules).size).toBe(CYCLES)
        expect(new Set(modules.map((module) => module.id)).size).toBe(CYCLES)
        expect(new Set(modules.map((module) => module.container)).size).toBe(CYCLES)
    })

    it("leaves the app untouched by the cycling below it", async () => {
        const app = genTracker([], "App")
        const child = genTracker([], "Child")
        let show: (visible: boolean) => void = () => {}

        function Harness(): ReactNode {
            const [visible, setVisible] = useState(true)
            show = setVisible
            return (
                <Root providers={[app.provider]}>
                    {visible ? (
                        <ModuleProvider providers={[child.provider]}>
                            <div />
                        </ModuleProvider>
                    ) : null}
                </Root>
            )
        }

        render(<Harness />)
        for (let cycle = 0; cycle < 3; cycle++) {
            // eslint-disable-next-line no-await-in-loop
            await act(async () => show(false))
            // eslint-disable-next-line no-await-in-loop
            await act(async () => show(true))
        }
        await flush()

        expect(app.generations.length).toBe(1)
        expect(app.generations[0]).toEqual(ALIVE)
        expect(child.generations.length).toBe(4)
    })
})

// Keys
// ========================================

describe("<ModuleProvider key={…}>", () => {
    it("disposes the keyed-out module through all four phases and builds a fresh one", async () => {
        const log: string[] = []
        const tracker = genTracker(log)
        const modules: Module[] = []
        const Probe = moduleProbe(modules)

        function Tree({ tenant }: { tenant: string }): ReactNode {
            return (
                <Root>
                    <ModuleProvider key={tenant} id={`tenant:${tenant}`} providers={[tracker.provider]}>
                        <Probe />
                    </ModuleProvider>
                </Root>
            )
        }

        const { rerender } = render(<Tree tenant="a" />)
        expect(tracker.generations).toEqual([ALIVE])
        log.length = 0

        rerender(<Tree tenant="b" />)
        await flush()

        // MEASURED order: the new generation is built during render, the deleted fiber's cleanup runs first
        // in the commit that follows — but that cleanup only UNMOUNTS and schedules the destroy, so the new
        // generation mounts while the old one is still an intact, retired module.
        expect(log).toEqual(["S2:ctor", "S2:init", "S1:unmount", "S2:mount", "S1:destroy"])
        expect(tracker.generations.length).toBe(2)
        expect(tracker.generations[0]).toEqual(DISPOSED)
        expect(tracker.generations[1]).toEqual(ALIVE)

        expect(modules.length).toBe(2)
        expect(modules[0]).not.toBe(modules[1])
        expect(modules[0]?.id).toBe("tenant:a")
        expect(modules[1]?.id).toBe("tenant:b")
    })

    it("does nothing of the sort on a plain re-render with the key unchanged", async () => {
        const log: string[] = []
        const tracker = genTracker(log)
        const modules: Module[] = []
        const Probe = moduleProbe(modules)

        function Tree({ tenant, label }: { tenant: string; label: string }): ReactNode {
            return (
                <Root>
                    <ModuleProvider key={tenant} id={`tenant:${tenant}`} providers={[tracker.provider]}>
                        <Probe />
                        <span data-testid="label">{label}</span>
                    </ModuleProvider>
                </Root>
            )
        }

        const { rerender, getByTestId } = render(<Tree tenant="a" label="one" />)
        log.length = 0

        rerender(<Tree tenant="a" label="two" />)
        rerender(<Tree tenant="a" label="three" />)
        await flush()

        expect(getByTestId("label").textContent).toBe("three")
        expect(log).toEqual([])
        expect(tracker.generations).toEqual([ALIVE])
        expect(new Set(modules).size).toBe(1)
    })

    it("cycles a key back and forth without accumulating live modules", async () => {
        const tracker = genTracker()

        function Tree({ tenant }: { tenant: string }): ReactNode {
            return (
                <Root>
                    <ModuleProvider key={tenant} providers={[tracker.provider]}>
                        <div />
                    </ModuleProvider>
                </Root>
            )
        }

        const { rerender } = render(<Tree tenant="a" />)
        rerender(<Tree tenant="b" />)
        rerender(<Tree tenant="a" />)
        rerender(<Tree tenant="b" />)
        await flush()

        expect(tracker.generations.length).toBe(4)
        expect(tracker.generations.slice(0, 3)).toEqual([DISPOSED, DISPOSED, DISPOSED])
        expect(tracker.generations[3]).toEqual(ALIVE)
    })
})

// Rapid mount / unmount
// ========================================

describe("rapid mount/unmount", () => {
    it("collapses a mount and an unmount inside one act into no module at all", async () => {
        const tracker = genTracker()
        let show: (visible: boolean) => void = () => {}

        function Harness(): ReactNode {
            const [visible, setVisible] = useState(false)
            show = setVisible
            return (
                <Root>
                    {visible ? (
                        <ModuleProvider providers={[tracker.provider]}>
                            <div />
                        </ModuleProvider>
                    ) : null}
                </Root>
            )
        }

        render(<Harness />)

        await act(async () => {
            show(true)
            show(false)
        })
        await flush()

        // React batches both updates into a single render whose result is "not there", so the boundary
        // never renders and no module is built. Nothing to leak.
        expect(tracker.generations).toEqual([])
    })

    it("settles every generation as fully-alive or fully-destroyed across un-flushed toggles", async () => {
        const tracker = genTracker()
        let show: (visible: boolean) => void = () => {}

        function Harness(): ReactNode {
            const [visible, setVisible] = useState(false)
            show = setVisible
            return (
                <Root>
                    {visible ? (
                        <ModuleProvider providers={[tracker.provider]}>
                            <div />
                        </ModuleProvider>
                    ) : null}
                </Root>
            )
        }

        render(<Harness />)

        // Consecutive acts with no flush between them: each act commits, but the async destroy of the
        // previous generation is still an unsettled promise when the next generation is built.
        act(() => show(true))
        act(() => show(false))
        act(() => show(true))
        act(() => show(false))
        act(() => show(true))
        await flush()

        expect(tracker.generations.length).toBe(3)
        expect(tracker.generations[0]).toEqual(DISPOSED)
        expect(tracker.generations[1]).toEqual(DISPOSED)
        expect(tracker.generations[2]).toEqual(ALIVE)

        // The invariant, stated as a sum: three built, three inited, three mounted, two torn down.
        const total = (key: keyof Generation) => tracker.generations.reduce((sum, gen) => sum + gen[key], 0)
        expect(total("init")).toBe(3)
        expect(total("mount")).toBe(3)
        expect(total("unmount")).toBe(2)
        expect(total("destroy")).toBe(2)
    })

    it("destroys the last generation too when the tree unmounts mid-cycle", async () => {
        const tracker = genTracker()
        let show: (visible: boolean) => void = () => {}

        function Harness(): ReactNode {
            const [visible, setVisible] = useState(true)
            show = setVisible
            return (
                <Root>
                    {visible ? (
                        <ModuleProvider providers={[tracker.provider]}>
                            <div />
                        </ModuleProvider>
                    ) : null}
                </Root>
            )
        }

        const { unmount } = render(<Harness />)
        act(() => show(false))
        act(() => show(true))
        unmount()
        await flush()

        expect(tracker.generations.length).toBe(2)
        for (const generation of tracker.generations) expect(generation).toEqual(DISPOSED)
    })
})

// Dynamic nesting
// ========================================

describe("nested modules appearing and disappearing", () => {
    it("attaches on appearance, detaches and destroys on disappearance, and leaves the parent alone", async () => {
        const parent = genTracker([], "P")
        const child = genTracker([], "C")
        const parents: Module[] = []
        const children: Module[] = []
        const ParentProbe = moduleProbe(parents)
        const ChildProbe = moduleProbe(children)
        let show: (visible: boolean) => void = () => {}

        function Harness(): ReactNode {
            const [visible, setVisible] = useState(false)
            show = setVisible
            return (
                <Root>
                    <ModuleProvider id="parent" providers={[parent.provider]}>
                        <ParentProbe />
                        {visible ? (
                            <ModuleProvider id="child" providers={[child.provider]}>
                                <ChildProbe />
                            </ModuleProvider>
                        ) : null}
                    </ModuleProvider>
                </Root>
            )
        }

        render(<Harness />)
        const parentModule = parents[0]!
        expect([...parentModule.children]).toEqual([])
        expect(parent.generations).toEqual([ALIVE])

        // Appearing: the child builds, inits, mounts, and registers itself with the parent.
        await act(async () => show(true))
        expect(child.generations).toEqual([ALIVE])
        expect([...parentModule.children]).toEqual([children[0]])
        expect(parentModule.container.resolve(ModuleTraversal).children()).toEqual([children[0]])
        expect(children[0]?.parent).toBe(parentModule)

        // Disappearing: unlinked from the parent's children and torn all the way down.
        await act(async () => show(false))
        await flush()
        expect(child.generations).toEqual([DISPOSED])
        expect([...parentModule.children]).toEqual([])
        expect(parentModule.container.resolve(ModuleTraversal).children()).toEqual([])

        // Reappearing: a genuinely new child module, attached again.
        await act(async () => show(true))
        expect(child.generations.length).toBe(2)
        expect(child.generations[1]).toEqual(ALIVE)
        expect(children.length).toBe(2)
        expect(children[1]).not.toBe(children[0])
        expect([...parentModule.children]).toEqual([children[1]])

        // Through all of it the parent module was never rebuilt or re-phased.
        expect(parent.generations).toEqual([ALIVE])
        expect(new Set(parents).size).toBe(1)
    })

    it("keeps sibling children independent as one of them comes and goes", async () => {
        const stable = genTracker([], "Stable")
        const flapping = genTracker([], "Flapping")
        const parents: Module[] = []
        const ParentProbe = moduleProbe(parents)
        let show: (visible: boolean) => void = () => {}

        function Harness(): ReactNode {
            const [visible, setVisible] = useState(true)
            show = setVisible
            return (
                <Root>
                    <ModuleProvider id="parent">
                        <ParentProbe />
                        <ModuleProvider id="stable" providers={[stable.provider]}>
                            <div />
                        </ModuleProvider>
                        {visible ? (
                            <ModuleProvider id="flapping" providers={[flapping.provider]}>
                                <div />
                            </ModuleProvider>
                        ) : null}
                    </ModuleProvider>
                </Root>
            )
        }

        render(<Harness />)
        const parentModule = parents[0]!
        expect(parentModule.children.size).toBe(2)

        await act(async () => show(false))
        await flush()
        expect(parentModule.children.size).toBe(1)
        expect([...parentModule.children][0]?.id).toBe("stable")
        expect(stable.generations).toEqual([ALIVE])
        expect(flapping.generations).toEqual([DISPOSED])

        await act(async () => show(true))
        expect(parentModule.children.size).toBe(2)
        expect(stable.generations).toEqual([ALIVE])
    })
})

// Context around the boundary
// ========================================

describe("a React context above <ModuleProvider>", () => {
    it("re-renders consumers below without rebuilding the module", async () => {
        const Theme = createContext("light")
        const tracker = genTracker()
        const modules: Module[] = []
        const seen: string[] = []
        let setTheme: (theme: string) => void = () => {}

        function Consumer(): ReactNode {
            seen.push(useContext(Theme))
            modules.push(useModuleContext().module)
            return <span data-testid="theme">{useContext(Theme)}</span>
        }

        function Harness(): ReactNode {
            const [theme, set] = useState("light")
            setTheme = set
            return (
                <Root>
                    <Theme.Provider value={theme}>
                        <ModuleProvider providers={[tracker.provider]}>
                            <Consumer />
                        </ModuleProvider>
                    </Theme.Provider>
                </Root>
            )
        }

        const { getByTestId } = render(<Harness />)

        await act(async () => setTheme("dark"))
        await act(async () => setTheme("solarized"))
        await flush()

        // The consumer saw every value...
        expect(seen).toEqual(["light", "dark", "solarized"])
        expect(getByTestId("theme").textContent).toBe("solarized")

        // ...while the module underneath never moved: one generation, one instance, no re-init.
        expect(tracker.generations).toEqual([ALIVE])
        expect(new Set(modules).size).toBe(1)
        expect(new Set(modules.map((module) => module.container)).size).toBe(1)
    })

    it("survives a context provider that is itself remounted around a stable module id", async () => {
        const Theme = createContext("light")
        const tracker = genTracker()
        let setTheme: (theme: string) => void = () => {}

        function Harness(): ReactNode {
            const [theme, set] = useState("light")
            setTheme = set
            return (
                <Root>
                    {/* The context provider changes value AND identity of the element every render. */}
                    <Theme.Provider value={theme}>
                        <ModuleProvider id="stable" providers={[tracker.provider]}>
                            <span data-testid="value">{theme}</span>
                        </ModuleProvider>
                    </Theme.Provider>
                </Root>
            )
        }

        const { getByTestId } = render(<Harness />)
        for (const value of ["a", "b", "c", "d"]) {
            // eslint-disable-next-line no-await-in-loop
            await act(async () => setTheme(value))
        }
        await flush()

        expect(getByTestId("value").textContent).toBe("d")
        expect(tracker.generations).toEqual([ALIVE])
    })
})

// Suspense
// ========================================

// The supported Suspense shapes
// ========================================
//
// THE RULE: a ModuleProvider must never be hidden after it has committed; anything that only delays its
// first mount is supported. The two shapes below are the legal ones, pinned as regressions. The illegal one
// — suspendable content directly inside a module, suspending a boundary ABOVE the provider — is doctrine
// rather than a target, and the cost of doing it anyway is measured in "Suspense at module level" below.

describe("the supported Suspense shapes", () => {
    /** A lazy component whose chunk this test resolves by hand, so nothing depends on timing. */
    function chunkOf(render: () => ReactNode): { Lazy: ComponentType; release: () => void } {
        let release!: () => void
        const chunk = new Promise<{ default: ComponentType }>((resolve) => {
            release = () => resolve({ default: () => render() })
        })
        return { Lazy: lazy(() => chunk), release }
    }

    it("LEGAL: an inner boundary absorbs the suspension, and the module around it is never hidden", async () => {
        const log: string[] = []
        const tracker = genTracker(log)
        const { Lazy, release } = chunkOf(() => <span data-testid="content">content</span>)

        let view!: ReturnType<typeof render>
        await act(async () => {
            view = render(
                <Root>
                    <Suspense fallback={<span data-testid="outer">outer</span>}>
                        <ModuleProvider providers={[tracker.provider]}>
                            <Suspense fallback={<span data-testid="inner">inner</span>}>
                                <Lazy />
                            </Suspense>
                        </ModuleProvider>
                    </Suspense>
                </Root>
            )
        })
        const { getByTestId, queryByTestId } = view

        // The inner boundary catches it, so the provider COMMITS while its content is still pending — the
        // outer fallback is never reached, and the module is mounted the whole time.
        expect(getByTestId("inner")).toBeInTheDocument()
        expect(queryByTestId("outer")).toBeNull()
        expect(tracker.generations).toEqual([{ init: 1, mount: 1, unmount: 0, destroy: 0 }])

        await act(async () => {
            release()
            await flush()
        })

        // Child arrives, and the module is untouched by its suspension: one generation, still mounted,
        // never unmounted. Compare "Suspense at module level", where the boundary sits ABOVE the provider
        // and every retry compounds an abandoned generation.
        expect(getByTestId("content")).toBeInTheDocument()
        expect(tracker.generations).toEqual([{ init: 1, mount: 1, unmount: 0, destroy: 0 }])
        expect(log).toEqual(["S1:ctor", "S1:init", "S1:mount"])
    })

    it("LEGAL: a lazy wrapper delays the first mount, and no module exists while it waits", async () => {
        const log: string[] = []
        const tracker = genTracker(log)
        const { Lazy, release } = chunkOf(() => (
            <ModuleProvider providers={[tracker.provider]}>
                <span data-testid="content">content</span>
            </ModuleProvider>
        ))

        let view!: ReturnType<typeof render>
        await act(async () => {
            view = render(
                <Root>
                    <Suspense fallback={<span data-testid="fallback">…</span>}>
                        <Lazy />
                    </Suspense>
                </Root>
            )
        })
        const { getByTestId } = view

        // The suspension happens BEFORE the provider exists: the ModuleProvider is inside the chunk, so
        // there is no module to hide and nothing to abandon. Zero constructions while the fallback shows.
        expect(getByTestId("fallback")).toBeInTheDocument()
        expect(tracker.generations).toHaveLength(0)
        expect(log).toEqual([])

        await act(async () => {
            release()
            await flush()
        })

        // Exactly one generation, mounted once — a delayed first mount, which is the supported half of the
        // rule.
        expect(getByTestId("content")).toBeInTheDocument()
        expect(tracker.generations).toEqual([{ init: 1, mount: 1, unmount: 0, destroy: 0 }])

        await act(async () => {
            view.unmount()
            await flush()
        })

        expect(tracker.generations).toEqual([{ init: 1, mount: 1, unmount: 1, destroy: 1 }])
    })
})

describe("Suspense at module level", () => {
    it("re-runs construction and init on every abandoned render attempt, but mounts exactly once", async () => {
        const log: string[] = []
        const tracker = genTracker(log)
        let release: () => void = () => {}
        const ready = new Promise<void>((resolve) => {
            release = resolve
        })

        function Suspender(): ReactNode {
            use(ready)
            return <span data-testid="content">content</span>
        }

        // The initial render must happen inside an AWAITED act: a render that suspends inside a synchronous
        // act scope never gets its retry flushed (React warns about exactly this), and the boundary would
        // stay on the fallback forever no matter how many times the promise resolves.
        let view!: ReturnType<typeof render>
        await act(async () => {
            view = render(
                <Root>
                    <Suspense fallback={<span data-testid="fallback">…</span>}>
                        <ModuleProvider providers={[tracker.provider]}>
                            <Suspender />
                        </ModuleProvider>
                    </Suspense>
                </Root>
            )
        })
        const { getByTestId, queryByTestId } = view

        expect(getByTestId("fallback")).toBeInTheDocument()
        expect(queryByTestId("content")).toBeNull()

        await act(async () => {
            release()
            await flush()
        })

        expect(getByTestId("content")).toBeInTheDocument()

        // ==================== MEASURED — the transferable finding ====================
        //
        // The module is built and inited in ModuleProvider's render-phase `useState` initializer, and React
        // re-runs that initializer on every render ATTEMPT. A child that suspends makes the boundary retry,
        // so construction and init COMPOUND while the tree is suspended. The abandoned generations never
        // commit, so they never mount — and because ModuleProvider only unmounts/destroys what its effect
        // mounted, they are never unmounted or destroyed either. They are simply garbage.
        //
        // MEASURED at plain ModuleProvider level: 3 constructions / 3 inits / 1 mount / 0 unmount /
        // 0 destroy — two attempts while suspended plus the committing one. The same numbers the
        // experimental component wrapper produced, which confirms the finding belongs to ModuleProvider
        // and not to that wrapper.
        //
        // CONSTRAINT: init-phase side effects must be abandonment-safe. A resource acquired in
        // `onModuleInit` on an abandoned attempt is NEVER released — there is no onModuleDestroy for a
        // module that never committed. Acquire in `onModuleMount`, which only fires for the committed
        // generation.
        expect(tracker.generations.length).toBe(3)
        for (const generation of tracker.generations.slice(0, -1)) expect(generation).toEqual(ABANDONED)
        expect(tracker.generations.at(-1)).toEqual(ALIVE)

        // Exact log, so a change to the retry count is a failing test rather than a silent drift.
        expect(log).toEqual([
            "S1:ctor",
            "S1:init",
            "S2:ctor",
            "S2:init",
            "S3:ctor",
            "S3:init",
            "S3:mount",
        ])
    })

    it("keeps the committed module identical across a suspension that happens after commit", async () => {
        const log: string[] = []
        const tracker = genTracker(log)
        const modules: Module[] = []
        const Probe = moduleProbe(modules)
        let release: () => void = () => {}
        const ready = new Promise<void>((resolve) => {
            release = resolve
        })
        let suspend: (wait: Promise<void> | null) => void = () => {}

        function Child({ wait }: { wait: Promise<void> | null }): ReactNode {
            if (wait) use(wait)
            return <span data-testid="content">content</span>
        }

        function Harness(): ReactNode {
            const [wait, setWait] = useState<Promise<void> | null>(null)
            suspend = setWait
            return (
                <Root>
                    <Suspense fallback={<span data-testid="fallback">…</span>}>
                        <ModuleProvider id="survivor" providers={[tracker.provider]}>
                            <Probe />
                            <Child wait={wait} />
                        </ModuleProvider>
                    </Suspense>
                </Root>
            )
        }

        const { getByTestId } = render(<Harness />)
        expect(getByTestId("content")).toBeInTheDocument()
        expect(tracker.generations).toEqual([ALIVE])
        const committed = modules[0]
        log.length = 0

        act(() => suspend(ready))
        expect(getByTestId("fallback")).toBeInTheDocument()

        await act(async () => {
            release()
            await flush()
        })

        // MEASURED: re-suspending a committed boundary hides the subtree, it does not delete it. The module
        // is neither rebuilt nor re-phased, and the identity handed to children is unchanged.
        expect(getByTestId("content")).toBeInTheDocument()
        expect(log).toEqual([])
        expect(tracker.generations).toEqual([ALIVE])
        expect(new Set(modules).size).toBe(1)
        expect(modules.at(-1)).toBe(committed)
    })
})

// Error boundaries
// ========================================

describe("error boundaries around a module", () => {
    it("catches a child render throw on first render — and the module never mounts or is destroyed", async () => {
        const restore = silenceReactErrorLog()
        const log: string[] = []
        const tracker = genTracker(log)
        const caught: Error[] = []

        function Exploding(): ReactNode {
            throw new Error("child render boom")
        }

        const { getByTestId } = render(
            <Root>
                <Boundary onError={(error) => caught.push(error)}>
                    <ModuleProvider providers={[tracker.provider]}>
                        <Exploding />
                    </ModuleProvider>
                </Boundary>
            </Root>
        )
        await flush()

        expect(getByTestId("fallback").textContent).toBe("child render boom")
        expect(caught.map((error) => error.message)).toEqual(["child render boom"])

        // ==================== MEASURED — LEAK, same root cause as the Suspense case ====================
        //
        // The throw happens after ModuleProvider's initializer already built and inited the module, and the
        // render never commits, so the effect that owns mount/unmount/destroy never runs. Every generation
        // built by a failed render attempt is abandoned: inited, never mounted, never destroyed. React's dev
        // build replays the failing render to recover a component stack, which is why there are two.
        expect(tracker.generations.length).toBe(2)
        for (const generation of tracker.generations) expect(generation).toEqual(ABANDONED)
        expect(log).toEqual(["S1:ctor", "S1:init", "S2:ctor", "S2:init"])

        restore()
    })

    it("unmounts and destroys the module when the boundary swaps a COMMITTED subtree out", async () => {
        const restore = silenceReactErrorLog()
        const tracker = genTracker()
        const caught: Error[] = []
        let explode: () => void = () => {}

        function Child(): ReactNode {
            const [boom, setBoom] = useState(false)
            explode = () => setBoom(true)
            if (boom) throw new Error("late boom")
            return <span data-testid="content">content</span>
        }

        const { getByTestId } = render(
            <Root>
                <Boundary onError={(error) => caught.push(error)}>
                    <ModuleProvider providers={[tracker.provider]}>
                        <Child />
                    </ModuleProvider>
                </Boundary>
            </Root>
        )
        expect(tracker.generations).toEqual([ALIVE])

        await act(async () => explode())
        await flush()

        expect(getByTestId("fallback").textContent).toBe("late boom")
        expect(caught.map((error) => error.message)).toEqual(["late boom"])

        // The boundary replaces its children with the fallback, so the ModuleProvider fiber is deleted and
        // its cleanup runs in full — a committed module IS torn down properly on a caught error.
        expect(tracker.generations).toEqual([DISPOSED])

        restore()
    })

    it("leaves the module alone when the boundary sits BELOW it", async () => {
        const restore = silenceReactErrorLog()
        const tracker = genTracker()
        const modules: Module[] = []
        const Probe = moduleProbe(modules)
        let explode: () => void = () => {}

        function Child(): ReactNode {
            const [boom, setBoom] = useState(false)
            explode = () => setBoom(true)
            if (boom) throw new Error("inner boom")
            return null
        }

        const { getByTestId } = render(
            <Root>
                <ModuleProvider id="outlives-the-error" providers={[tracker.provider]}>
                    <Probe />
                    <Boundary>
                        <Child />
                    </Boundary>
                </ModuleProvider>
            </Root>
        )
        const before = modules[0]

        await act(async () => explode())
        await flush()

        expect(getByTestId("fallback").textContent).toBe("inner boom")
        expect(tracker.generations).toEqual([ALIVE])
        expect(new Set(modules).size).toBe(1)
        expect(modules.at(-1)).toBe(before)

        restore()
    })

    it("surfaces an onModuleInit throw to the boundary", async () => {
        const restore = silenceReactErrorLog()
        const caught: Error[] = []

        const { getByTestId } = render(
            <Root>
                <Boundary onError={(error) => caught.push(error)}>
                    <ModuleProvider
                        onModuleInit={() => {
                            throw new Error("module init boom")
                        }}
                    >
                        <div data-testid="never" />
                    </ModuleProvider>
                </Boundary>
            </Root>
        )
        await flush()

        // Init runs in the render phase, so its failure is a render failure: the nearest boundary catches it.
        expect(getByTestId("fallback").textContent).toBe("module init boom")
        expect(caught.map((error) => error.message)).toEqual(["module init boom"])

        restore()
    })

    it("surfaces a provider onModuleInit throw to the boundary the same way", async () => {
        const restore = silenceReactErrorLog()
        const caught: Error[] = []

        const Bad = class {
            onModuleInit(): void {
                throw new Error("provider init boom")
            }
        }

        const { getByTestId } = render(
            <Root>
                <Boundary onError={(error) => caught.push(error)}>
                    <ModuleProvider providers={[Bad as unknown as Provider]}>
                        <div />
                    </ModuleProvider>
                </Boundary>
            </Root>
        )
        await flush()

        expect(getByTestId("fallback").textContent).toBe("provider init boom")
        expect(caught.map((error) => error.message)).toEqual(["provider init boom"])

        restore()
    })

    it("renders normally when no phase throws — the boundary stays out of the way", async () => {
        const caught: Error[] = []

        const { queryByTestId, getByTestId } = render(
            <Root>
                <Boundary onError={(error) => caught.push(error)}>
                    <ModuleProvider onModuleInit={() => undefined}>
                        <span data-testid="content">content</span>
                    </ModuleProvider>
                </Boundary>
            </Root>
        )
        await flush()

        expect(caught).toEqual([])
        expect(queryByTestId("fallback")).toBeNull()
        expect(getByTestId("content")).toBeInTheDocument()
    })
})
