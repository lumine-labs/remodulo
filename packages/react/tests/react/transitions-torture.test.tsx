import { act, render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { Suspense, startTransition, use, useState, type ReactNode } from "react"

import type { Module } from "../../src/core/module.js"
import { ModuleStatus } from "../../src/core/module-lifecycle.types.js"
import { ModuleProvider } from "../../src/react/ModuleProvider.js"
import { useModuleContext, useModuleRebuild } from "../../src/react/useModuleContext.js"
import { useResolve } from "../../src/react/useResolve.js"
import type { Provider } from "../../src/types.js"
import { Root } from "../setup/react.js"
import { flush, type HookCounts } from "../setup/helpers.js"

// Concurrent transitions at module level
// ========================================
//
// `startTransition` is the one renderer feature that can hold a render ATTEMPT in the air for an arbitrary
// time: React renders the transition in the background, keeps the previously committed UI on screen, and
// throws the attempt away whenever it has to retry. `ModuleProvider` builds and inits its module in a
// render-phase `useState` initializer, so every discarded attempt is a discarded module — which is why the
// counts below are pinned per GENERATION, not per class.
//
// Everything here is MEASURED against React 19.2 + jsdom and asserted exactly, so a change in React's
// retry behavior fails a test instead of drifting silently.

// Per-generation tracking
// ========================================

type Life = { gen: number; counts: HookCounts }

type Generational = {
    provider: Provider
    /** One entry per constructed instance, in construction order. */
    lives: Life[]
    /** The instances themselves, for identity assertions. */
    instances: object[]
}

function generational(log: string[], label: string): Generational {
    const lives: Life[] = []
    const instances: object[] = []

    const Service = class {
        readonly life: Life

        constructor() {
            this.life = { gen: lives.length + 1, counts: { init: 0, mount: 0, unmount: 0, destroy: 0 } }
            lives.push(this.life)
            instances.push(this)
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

    return { provider: Service as unknown as Provider, lives, instances }
}

/** Mounted and untouched. */
const LIVE: HookCounts = { init: 1, mount: 1, unmount: 0, destroy: 0 }
/** Went through the full arc exactly once. */
const BURIED: HookCounts = { init: 1, mount: 1, unmount: 1, destroy: 1 }
/** Built and inited by a render attempt that never committed — never mounts, so never unmounts. */
const ABANDONED: HookCounts = { init: 1, mount: 0, unmount: 0, destroy: 0 }

const counts = (subject: Generational): HookCounts[] => subject.lives.map((life) => life.counts)

// Probes
// ========================================

/** Records every distinct module the context has handed this position in the tree. */
function ModuleProbe({ into }: { into: Module[] }): ReactNode {
    const { module } = useModuleContext()
    if (into.at(-1) !== module) into.push(module)
    return null
}

/** Records every distinct instance re-resolution has produced at this position. */
function ResolveProbe({ token, into }: { token: symbol; into: object[] }): ReactNode {
    const instance = useResolve<object>(token)
    if (into.at(-1) !== instance) into.push(instance)
    return null
}

function Rebuilder({ capture }: { capture: (rebuild: () => void) => void }): ReactNode {
    capture(useModuleRebuild())
    return null
}

const SERVICE = Symbol.for("tests.transitions-torture.service")

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve: () => void = () => {}
    const promise = new Promise<void>((settle) => {
        resolve = () => settle()
    })
    return { promise, resolve }
}

// A transition over a stable module
// ========================================

describe("a transition that only moves props", () => {
    it("re-renders the module's React subtree with zero lifecycle events", async () => {
        const log: string[] = []
        const service = generational(log, "S")
        const modules: Module[] = []
        let move: (value: string) => void = () => {}

        function Harness(): ReactNode {
            const [value, setValue] = useState("a")
            move = (next) => startTransition(() => setValue(next))
            return (
                <Root>
                    <ModuleProvider id="stable" providers={[service.provider]}>
                        <ModuleProbe into={modules} />
                        <span data-testid="leaf">{value}</span>
                    </ModuleProvider>
                </Root>
            )
        }

        const { getByTestId } = render(<Harness />)
        expect(counts(service)).toEqual([LIVE])
        log.length = 0

        await act(async () => move("b"))
        await act(async () => move("c"))
        await flush()

        // The module is not a function of props, so a transition is just a re-render to it.
        expect(getByTestId("leaf").textContent).toBe("c")
        expect(log).toEqual([])
        expect(counts(service)).toEqual([LIVE])
        expect(modules.length).toBe(1)
    })

    it("leaves a NESTED boundary equally untouched when the transition crosses it", async () => {
        const log: string[] = []
        const parent = generational(log, "P")
        const child = generational(log, "C")
        const parents: Module[] = []
        const children: Module[] = []
        let move: (value: string) => void = () => {}

        function Harness(): ReactNode {
            const [value, setValue] = useState("a")
            move = (next) => startTransition(() => setValue(next))
            return (
                <Root>
                    <ModuleProvider id="parent" providers={[parent.provider]}>
                        <ModuleProbe into={parents} />
                        <ModuleProvider id="child" providers={[child.provider]}>
                            <ModuleProbe into={children} />
                            <span data-testid="leaf">{value}</span>
                        </ModuleProvider>
                    </ModuleProvider>
                </Root>
            )
        }

        const { getByTestId } = render(<Harness />)
        log.length = 0

        await act(async () => move("b"))
        await flush()

        expect(getByTestId("leaf").textContent).toBe("b")
        expect(log).toEqual([])
        expect(counts(parent)).toEqual([LIVE])
        expect(counts(child)).toEqual([LIVE])
        expect(parents.length).toBe(1)
        expect(children.length).toBe(1)
        expect(children[0]?.parent).toBe(parents[0])
    })
})

// deps inside a transition
// ========================================

describe("a deps dep that changes inside a transition", () => {
    it("rebuilds with exactly the ordering contract of a synchronous dep change", async () => {
        const log: string[] = []
        const service = generational(log, "S")
        const modules: Module[] = []
        let move: (dep: number) => void = () => {}

        function Harness(): ReactNode {
            const [dep, setDep] = useState(0)
            move = (next) => startTransition(() => setDep(next))
            return (
                <Root>
                    <ModuleProvider providers={[service.provider]} deps={[dep]}>
                        <ModuleProbe into={modules} />
                        <span data-testid="dep">{dep}</span>
                    </ModuleProvider>
                </Root>
            )
        }

        const { getByTestId } = render(<Harness />)
        log.length = 0

        await act(async () => move(1))
        await flush()

        // MEASURED — identical to the non-transition contract in `rebuild.test.tsx`: the replacement is
        // built and inited first, the outgoing generation is retired, the new one mounts, and the deferred
        // destroy lands last. Nothing about the transition changes it, because the rebuild is not triggered
        // by RENDER: it is triggered by ModuleProvider's layout effect, which runs once the transition commits.
        expect(getByTestId("dep").textContent).toBe("1")
        expect(log).toEqual(["S#2:ctor", "S#2:init", "S#1:unmount", "S#2:mount", "S#1:destroy"])
        expect(counts(service)).toEqual([BURIED, LIVE])
        expect(modules.length).toBe(2)
    })

    it("defers the whole rebuild until the transition commits, and fires it once, not once per attempt", async () => {
        const log: string[] = []
        const service = generational(log, "S")
        const modules: Module[] = []
        const gate = deferred()
        let move: () => void = () => {}

        function Gated({ dep }: { dep: number }): ReactNode {
            if (dep === 1) use(gate.promise)
            return <span data-testid="dep">{dep}</span>
        }

        function Harness(): ReactNode {
            const [dep, setDep] = useState(0)
            move = () => startTransition(() => setDep(1))
            return (
                <Root>
                    <Suspense fallback={<span data-testid="fallback">…</span>}>
                        <ModuleProvider providers={[service.provider]} deps={[dep]}>
                            <ModuleProbe into={modules} />
                            <Gated dep={dep} />
                        </ModuleProvider>
                    </Suspense>
                </Root>
            )
        }

        const { getByTestId, queryByTestId } = render(<Harness />)
        log.length = 0

        await act(async () => move())

        // ==================== MEASURED — the answer to "does the rebuild defer?" ====================
        //
        // Yes, and cleanly. The dep has changed in the RENDER that is suspended, but `prevDepsRef` is
        // only advanced by a layout effect, and layout effects belong to the commit — which has not
        // happened. So while the transition is pending the module is untouched: no rebuild, no extra
        // generation, and the boundary keeps showing the already-committed content rather than a fallback.
        expect(queryByTestId("fallback")).toBeNull()
        expect(getByTestId("dep").textContent).toBe("0")
        expect(log).toEqual([])
        expect(counts(service)).toEqual([LIVE])
        expect(modules.length).toBe(1)

        await act(async () => {
            gate.resolve()
            await flush()
        })
        await flush()

        // On commit it fires exactly ONCE, however many attempts the transition needed. This is the
        // structural difference from module CONSTRUCTION (which lives in the render phase and therefore
        // does replay per attempt — see the discard-zone tests below).
        expect(getByTestId("dep").textContent).toBe("1")
        expect(log).toEqual(["S#2:ctor", "S#2:init", "S#1:unmount", "S#2:mount", "S#1:destroy"])
        expect(counts(service)).toEqual([BURIED, LIVE])
        expect(modules.length).toBe(2)
    })
})

// The discard zone, driven by a transition
// ========================================

describe("a transition into a subtree that suspends", () => {
    it("commits a BRAND-NEW boundary's fallback rather than holding the old UI", async () => {
        const log: string[] = []
        const service = generational(log, "S")
        const gate = deferred()
        let go: () => void = () => {}

        function Suspender(): ReactNode {
            use(gate.promise)
            return <span data-testid="detail">detail</span>
        }

        function Harness(): ReactNode {
            const [route, setRoute] = useState<"list" | "detail">("list")
            go = () => startTransition(() => setRoute("detail"))
            return (
                <Root>
                    {route === "list" ? (
                        <span data-testid="list">list</span>
                    ) : (
                        <Suspense fallback={<span data-testid="fallback">…</span>}>
                            <ModuleProvider providers={[service.provider]}>
                                <Suspender />
                            </ModuleProvider>
                        </Suspense>
                    )}
                </Root>
            )
        }

        const { getByTestId, queryByTestId } = render(<Harness />)
        expect(log).toEqual([])

        await act(async () => go())

        // MEASURED, and worth knowing before reading the rest of this block: "a transition never shows a
        // fallback" only holds for content that is ALREADY VISIBLE inside an ALREADY MOUNTED boundary. A
        // boundary the transition itself introduces has nothing to preserve, so React commits its fallback
        // and drops the old branch. The module below it is built once and abandoned by that attempt.
        expect(queryByTestId("list")).toBeNull()
        expect(getByTestId("fallback")).toBeInTheDocument()
        expect(log).toEqual(["S#1:ctor", "S#1:init"])
        expect(counts(service)).toEqual([ABANDONED])

        await act(async () => {
            gate.resolve()
            await flush()
        })

        expect(getByTestId("detail")).toBeInTheDocument()
        expect(log).toEqual(["S#1:ctor", "S#1:init", "S#2:ctor", "S#2:init", "S#2:mount"])
        expect(counts(service)).toEqual([ABANDONED, LIVE])
    })

    it("replays construction and init per attempt for a module in the discard zone", async () => {
        const log: string[] = []
        const list = generational(log, "List")
        const detail = generational(log, "Detail")
        const gate = deferred()
        let go: () => void = () => {}

        function Suspender(): ReactNode {
            use(gate.promise)
            return <span data-testid="detail">detail</span>
        }

        // The boundary is mounted and showing content from the first render, so the transition below is the
        // real thing: React keeps the committed branch on screen and renders the new one in the background,
        // discarding every attempt that suspends. The module sits between the catching boundary and the
        // thrower — the discard zone — and it is built by the render phase, so it is rebuilt per attempt.
        function Harness(): ReactNode {
            const [route, setRoute] = useState<"list" | "detail">("list")
            go = () => startTransition(() => setRoute("detail"))
            return (
                <Root>
                    <Suspense fallback={<span data-testid="fallback">…</span>}>
                        {route === "list" ? (
                            <ModuleProvider key="list" id="list" providers={[list.provider]}>
                                <span data-testid="list">list</span>
                            </ModuleProvider>
                        ) : (
                            <ModuleProvider key="detail" id="detail" providers={[detail.provider]}>
                                <Suspender />
                            </ModuleProvider>
                        )}
                    </Suspense>
                </Root>
            )
        }

        const { getByTestId, queryByTestId } = render(<Harness />)
        expect(counts(list)).toEqual([LIVE])
        log.length = 0

        await act(async () => go())

        // MEASURED — this is the transition doing what it advertises: the committed branch is still on
        // screen, no fallback, and the incoming module has been built and inited by an attempt that will
        // be thrown away. One discarded generation per suspended attempt.
        expect(getByTestId("list")).toBeInTheDocument()
        expect(queryByTestId("fallback")).toBeNull()
        expect(log).toEqual(["Detail#1:ctor", "Detail#1:init"])
        expect(counts(detail)).toEqual([ABANDONED])
        expect(counts(list)).toEqual([LIVE])

        await act(async () => {
            gate.resolve()
            await flush()
        })
        await flush()

        // On resolve the transition commits: ONE more construction (the attempt that succeeds), the old
        // branch is buried, and the new module mounts last. Two attempts in total for a transition, against
        // the three an initial mount takes — the retry counts differ, the compounding does not.
        expect(getByTestId("detail")).toBeInTheDocument()
        expect(log).toEqual([
            "Detail#1:ctor",
            "Detail#1:init",
            "Detail#2:ctor",
            "Detail#2:init",
            "List#1:unmount",
            "Detail#2:mount",
            "List#1:destroy",
        ])
        expect(counts(detail)).toEqual([ABANDONED, LIVE])
        expect(counts(list)).toEqual([BURIED])
    })
})

// The old tree during a pending transition
// ========================================

describe("the committed tree while a transition is suspended", () => {
    it("keeps serving the old generation's instances", async () => {
        const log: string[] = []
        const service = generational(log, "Old")
        const next = generational(log, "New")
        const instances: object[] = []
        const modules: Module[] = []
        const gate = deferred()
        let go: () => void = () => {}
        let poke: () => void = () => {}

        function Suspender(): ReactNode {
            use(gate.promise)
            return <span data-testid="detail">detail</span>
        }

        function Harness(): ReactNode {
            const [route, setRoute] = useState<"list" | "detail">("list")
            const [tick, setTick] = useState(0)
            go = () => startTransition(() => setRoute("detail"))
            poke = () => setTick((value) => value + 1)
            return (
                <Root>
                    <Suspense fallback={<span data-testid="fallback">…</span>}>
                        {route === "list" ? (
                            <ModuleProvider
                                key="list"
                                id="list"
                                providers={[{ provide: SERVICE, useClass: service.provider } as Provider]}
                            >
                                <ModuleProbe into={modules} />
                                <ResolveProbe token={SERVICE} into={instances} />
                                <span data-testid="tick">{tick}</span>
                            </ModuleProvider>
                        ) : (
                            <ModuleProvider key="detail" providers={[next.provider]}>
                                <Suspender />
                            </ModuleProvider>
                        )}
                    </Suspense>
                </Root>
            )
        }

        const { getByTestId } = render(<Harness />)
        const committed = modules[0]!
        const instance = instances[0]!
        log.length = 0

        await act(async () => go())

        // The transition is pending: the old UI is still the committed one, and it is still LIVE.
        expect(getByTestId("tick")).toBeInTheDocument()
        expect(committed.status).toBe(ModuleStatus.Mounted)
        expect(committed.status).not.toBeOneOf([ModuleStatus.Destroying, ModuleStatus.Destroyed])

        // A synchronous update to the old tree still renders against the old generation — same module,
        // same resolved instance, no new resolution.
        await act(async () => poke())
        expect(getByTestId("tick").textContent).toBe("1")
        expect(modules).toEqual([committed])
        expect(instances).toEqual([instance])
        expect(counts(service)).toEqual([LIVE])

        // MEASURED, and the sting in the tail: driving the old UI while the transition is pending makes
        // React re-attempt the transition, and each attempt builds and inits ANOTHER incoming module. Two
        // abandoned generations here — one for the original attempt, one for the attempt the sync `poke()`
        // provoked. Nothing about them ever mounts, so nothing about them is ever destroyed.
        expect(counts(next)).toEqual([ABANDONED, ABANDONED])
        expect(log).toEqual(["New#1:ctor", "New#1:init", "New#2:ctor", "New#2:init"])
    })
})

// rebuild() under transition pressure
// ========================================

describe("an imperative rebuild while a transition is pending", () => {
    it("settles on exactly one live generation", async () => {
        const log: string[] = []
        const service = generational(log, "S")
        const modules: Module[] = []
        const gate = deferred()
        let rebuild: () => void = () => {}
        let move: (value: string) => void = () => {}

        function Slow({ suspend }: { suspend: boolean }): ReactNode {
            if (suspend) use(gate.promise)
            return <span data-testid="leaf">{suspend ? "late" : "early"}</span>
        }

        function Harness(): ReactNode {
            const [value, setValue] = useState("early")
            move = (next) => startTransition(() => setValue(next))
            return (
                <Root>
                    <ModuleProvider providers={[service.provider]}>
                        <Rebuilder capture={(fn) => (rebuild = fn)} />
                        <ModuleProbe into={modules} />
                        <Slow suspend={value === "late"} />
                    </ModuleProvider>
                </Root>
            )
        }

        const { getByTestId } = render(<Harness />)
        log.length = 0

        // The transition suspends with no boundary to catch it, so it simply never commits — the tree is
        // held at "early" while two rebuilds are fired underneath it at synchronous priority.
        await act(async () => move("late"))
        await act(async () => rebuild())
        await act(async () => rebuild())
        await act(async () => {
            gate.resolve()
            await flush()
        })
        await flush()

        // MEASURED: a rebuild is a synchronous, layout-effect-scheduled swap, so it does not queue behind
        // the pending transition and it does not interleave with it either. Each one is a complete
        // generation swap in the documented order, and the sequence settles on exactly one live generation
        // with every earlier one fully buried — the rapid-rebuild invariant survives transition pressure.
        //
        // The deferred destroys are asserted APART from that sequence, and deliberately: where a scheduled
        // destroy lands relative to the React work that follows it is not fixed under real timers — an act
        // that yields to the macrotask queue lets the timer in early. What IS fixed is that each generation
        // gets exactly one destroy, in the order the cleanups scheduled them.
        expect(log.filter((entry) => !entry.endsWith(":destroy"))).toEqual([
            "S#2:ctor",
            "S#2:init",
            "S#1:unmount",
            "S#2:mount",
            "S#3:ctor",
            "S#3:init",
            "S#2:unmount",
            "S#3:mount",
        ])
        expect(log.filter((entry) => entry.endsWith(":destroy"))).toEqual(["S#1:destroy", "S#2:destroy"])
        expect(counts(service)).toEqual([BURIED, BURIED, LIVE])
        expect(modules.length).toBe(3)
        expect(modules.at(-1)?.status).toBe(ModuleStatus.Mounted)
        expect(modules.at(-1)?.status).not.toBeOneOf([ModuleStatus.Destroying, ModuleStatus.Destroyed])

        // And the transition it was fired under still lands.
        expect(getByTestId("leaf").textContent).toBe("late")
    })
})
