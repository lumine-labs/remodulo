import { act, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useState } from "react"

import { ModuleProvider } from "../../src/react/ModuleProvider.js"
import { PropsRef, type PropsAdapter } from "../../src/primitives/props-ref.js"
import { usePropsRef } from "../../src/react/usePropsRef.js"
import { useResolve, useResolveOptional } from "../../src/react/useResolve.js"
import type { InjectionToken } from "@remodulo/container"
import { Root } from "../setup/react.js"

type Data = { label: string; count: number }
type Boxed = { boxed: Data }

// The bridge is component-owned: one `PropsRef` per mounted component, handed to the container as a
// `ValueProvider`. Identity is the whole contract — the ref must survive every re-render, while
// `current` must always be the props of the last committed render.

// Return shape
// ========================================

describe("usePropsRef return shape", () => {
    it("hands back the ref and a ValueProvider bound to the default PropsRef token", () => {
        let result: ReturnType<typeof usePropsRef<Data>> | null = null

        function Harness() {
            result = usePropsRef<Data>({ label: "a", count: 1 })
            return null
        }

        render(<Harness />)

        expect(result!.ref).toBeInstanceOf(PropsRef)
        expect(result!.provider).toEqual({ provide: PropsRef, useValue: result!.ref })
        expect(result!.ref.current).toEqual({ label: "a", count: 1 })
    })

    it("registers under an explicit token instead, leaving the class token unbound", () => {
        const TOKEN: InjectionToken<PropsRef<Data>> = Symbol.for("tests.props.explicit-token")

        let provide: unknown = null
        let byToken: PropsRef<Data> | undefined
        let byClass: PropsRef<unknown> | undefined
        let local: PropsRef<Data> | null = null

        function Probe() {
            byToken = useResolveOptional(TOKEN)
            byClass = useResolveOptional(PropsRef)
            return null
        }

        function Harness() {
            const { ref, provider } = usePropsRef<Data>({ label: "a", count: 1 }, { token: TOKEN })
            local = ref
            provide = provider.provide
            return (
                <Root providers={[provider]}>
                    <Probe />
                </Root>
            )
        }

        render(<Harness />)

        expect(provide).toBe(TOKEN)
        expect(byToken).toBe(local)
        expect(byClass).toBeUndefined()
    })

    it("resolves to the very instance the hook returned", () => {
        let local: PropsRef<Data> | null = null
        let resolved: PropsRef<Data> | null = null

        function Probe() {
            resolved = useResolve(PropsRef) as PropsRef<Data>
            return null
        }

        function Harness() {
            const { ref, provider } = usePropsRef<Data>({ label: "a", count: 1 })
            local = ref
            return (
                <Root providers={[provider]}>
                    <Probe />
                </Root>
            )
        }

        render(<Harness />)

        expect(resolved).toBe(local)
    })
})

// Identity across re-renders
// ========================================

describe("usePropsRef identity", () => {
    let setData: ((data: Data) => void) | null = null
    let setTick: (() => void) | null = null
    let seen: Array<{ ref: PropsRef<Data>; token: unknown; value: unknown }> = []

    beforeEach(() => {
        setData = null
        setTick = null
        seen = []
    })

    function Harness({ initial }: { initial: Data }) {
        const [data, setDataState] = useState(initial)
        const [, setTickState] = useState(0)
        setData = setDataState
        setTick = () => setTickState((tick) => tick + 1)

        const { ref, provider } = usePropsRef<Data>(data)
        seen.push({ ref, token: provider.provide, value: provider.useValue })
        return null
    }

    it("keeps one ref instance across re-renders while current follows the props", () => {
        const initial: Data = { label: "a", count: 1 }
        render(<Harness initial={initial} />)

        const ref = seen[0]!.ref
        expect(ref.current).toBe(initial)

        const second: Data = { label: "b", count: 2 }
        act(() => setData?.(second))
        expect(seen.at(-1)!.ref).toBe(ref)
        expect(ref.current).toBe(second)

        const third: Data = { label: "c", count: 3 }
        act(() => setData?.(third))
        expect(seen.at(-1)!.ref).toBe(ref)
        expect(ref.current).toBe(third)
    })

    it("keeps the provider pointed at that same ref and token on every render", () => {
        render(<Harness initial={{ label: "a", count: 1 }} />)

        act(() => setData?.({ label: "b", count: 2 }))
        act(() => setTick?.())

        expect(seen.length).toBeGreaterThanOrEqual(3)
        for (const entry of seen) {
            expect(entry.token).toBe(PropsRef)
            expect(entry.value).toBe(seen[0]!.ref)
        }
    })

    it("does not touch current on a re-render that changes nothing", () => {
        const initial: Data = { label: "a", count: 1 }
        render(<Harness initial={initial} />)

        const ref = seen[0]!.ref
        const subscriber = vi.fn()
        ref.onUpdate(subscriber)

        act(() => setTick?.())

        expect(seen.length).toBeGreaterThan(1)
        expect(ref.current).toBe(initial)
        expect(subscriber).not.toHaveBeenCalled()
    })

    it("notifies subscribers from the layout effect, once per real change", () => {
        render(<Harness initial={{ label: "a", count: 1 }} />)

        const ref = seen[0]!.ref
        const calls: Array<[Data, Data]> = []
        ref.onUpdate((next, prev) => void calls.push([next, prev]))

        act(() => setData?.({ label: "b", count: 2 }))
        act(() => setData?.({ label: "b", count: 2 }))

        expect(calls).toHaveLength(1)
        expect(calls[0]![0]).toEqual({ label: "b", count: 2 })
        expect(calls[0]![1]).toEqual({ label: "a", count: 1 })
    })

    it("is not reactive: a props change alone re-renders nothing under the module", () => {
        let renders = 0
        let setOuter: ((data: Data) => void) | null = null
        let ref: PropsRef<Data> | null = null

        function Probe() {
            renders++
            const resolved = useResolve(PropsRef) as PropsRef<Data>
            return <span data-testid="label">{resolved.current.label}</span>
        }

        // A stable element, so React bails out of re-rendering Probe when only the bridge moved.
        const child = <Probe />

        function Bridge() {
            const [data, setDataState] = useState<Data>({ label: "a", count: 1 })
            setOuter = setDataState
            const bridge = usePropsRef(data)
            ref = bridge.ref
            return (
                <Root providers={[bridge.provider]}>
                    {child}
                </Root>
            )
        }

        render(<Bridge />)
        expect(renders).toBe(1)
        expect(screen.getByTestId("label").textContent).toBe("a")

        act(() => setOuter?.({ label: "b", count: 2 }))

        // The value moved; the DOM did not. Consumers read through the ref when they need it.
        expect(ref!.current).toEqual({ label: "b", count: 2 })
        expect(renders).toBe(1)
        expect(screen.getByTestId("label").textContent).toBe("a")
    })
})

// Adapter form: T differs from P
// ========================================

describe("usePropsRef with an adapter", () => {
    function makeAdapter(): PropsAdapter<Data, Boxed> {
        return {
            create: vi.fn((initial: Data) => ({ boxed: initial })),
            update: vi.fn(({ current, next }: { current: Boxed; next: Data }) => {
                current.boxed = next
                return current
            }),
        }
    }

    const TOKEN: InjectionToken<PropsRef<Boxed>> = Symbol.for("tests.props.adapter-token")

    let setData: ((data: Data) => void) | null = null
    let setAdapter: ((adapter: PropsAdapter<Data, Boxed> | undefined) => void) | null = null
    let resolved: PropsRef<Boxed> | null = null

    beforeEach(() => {
        setData = null
        setAdapter = null
        resolved = null
    })

    function Probe() {
        resolved = useResolve(TOKEN)
        return null
    }

    function makeHarness(initialAdapter: PropsAdapter<Data, Boxed> | undefined) {
        return function Harness() {
            const [data, setDataState] = useState<Data>({ label: "a", count: 1 })
            const [adapter, setAdapterState] = useState(() => initialAdapter)
            setData = setDataState
            setAdapter = setAdapterState

            const { provider } = usePropsRef<Data, Boxed>(data, { adapter, token: TOKEN })

            return (
                <Root providers={[provider]}>
                    <Probe />
                </Root>
            )
        }
    }

    it("calls create on the first render only, then update for every real change", () => {
        const adapter = makeAdapter()
        const Harness = makeHarness(adapter)
        render(<Harness />)

        expect(adapter.create).toHaveBeenCalledTimes(1)
        expect(adapter.create).toHaveBeenCalledWith({ label: "a", count: 1 })
        expect(adapter.update).not.toHaveBeenCalled()

        const target = vi.mocked(adapter.create).mock.results[0]!.value
        expect(resolved!.current).toBe(target)

        const second: Data = { label: "b", count: 2 }
        act(() => setData?.(second))

        expect(adapter.create).toHaveBeenCalledTimes(1)
        expect(adapter.update).toHaveBeenCalledTimes(1)
        expect(adapter.update).toHaveBeenCalledWith({ current: target, next: second })
        expect(resolved!.current).toBe(target)
        expect(resolved!.current.boxed).toBe(second)
    })

    it("skips update entirely when the new props are shallow-equal", () => {
        const adapter = makeAdapter()
        const Harness = makeHarness(adapter)
        render(<Harness />)

        act(() => setData?.({ label: "a", count: 1 }))

        expect(adapter.update).not.toHaveBeenCalled()
        expect(adapter.create).toHaveBeenCalledTimes(1)
    })

    it("delivers the bridged value, not the props, to subscribers", () => {
        const adapter = makeAdapter()
        const Harness = makeHarness(adapter)
        render(<Harness />)

        const target = vi.mocked(adapter.create).mock.results[0]!.value
        const calls: Array<[Boxed, Boxed]> = []
        resolved!.onUpdate((next, prev) => void calls.push([next, prev]))

        act(() => setData?.({ label: "b", count: 2 }))

        expect(calls).toHaveLength(1)
        // The adapter mutates and returns the same target, so next and prev are the same object here.
        expect(calls[0]![0]).toBe(target)
        expect(calls[0]![1]).toBe(target)
        expect(calls[0]![0].boxed).toEqual({ label: "b", count: 2 })
    })

    it("rebuilds the target from the CURRENT props when the adapter identity changes", () => {
        const first = makeAdapter()
        const second = makeAdapter()
        const Harness = makeHarness(first)
        render(<Harness />)

        act(() => setData?.({ label: "b", count: 2 }))
        const targetA = vi.mocked(first.create).mock.results[0]!.value

        const calls: Array<[Boxed, Boxed]> = []
        resolved!.onUpdate((next, prev) => void calls.push([next, prev]))

        act(() => setAdapter?.(second))

        expect(second.create).toHaveBeenCalledTimes(1)
        expect(second.create).toHaveBeenCalledWith({ label: "b", count: 2 })
        const targetB = vi.mocked(second.create).mock.results[0]!.value
        expect(resolved!.current).toBe(targetB)
        expect(calls).toHaveLength(1)
        expect(calls[0]![0]).toBe(targetB)
        expect(calls[0]![1]).toBe(targetA)

        // The old adapter is out of the loop from here on.
        act(() => setData?.({ label: "c", count: 3 }))
        expect(second.update).toHaveBeenCalledTimes(1)
        expect(first.update).toHaveBeenCalledTimes(1)
    })

    it("re-creates from the props of the last committed update when the adapter and the props change together", () => {
        // The swap runs before the regular update inside one layout effect, so `create` sees the props
        // the ref last committed — the ones being replaced in this very render — and `update` then
        // catches the new adapter up. One render, two notifications.
        const first = makeAdapter()
        const second = makeAdapter()

        let setBoth: ((state: { data: Data; adapter: PropsAdapter<Data, Boxed> }) => void) | null = null
        let captured: PropsRef<Boxed> | null = null

        function CapturingProbe() {
            captured = useResolve(TOKEN)
            return null
        }

        function Harness() {
            const [state, setState] = useState({ data: { label: "a", count: 1 } as Data, adapter: first })
            setBoth = setState
            const { provider } = usePropsRef<Data, Boxed>(state.data, { adapter: state.adapter, token: TOKEN })
            return (
                <Root providers={[provider]}>
                    <CapturingProbe />
                </Root>
            )
        }

        render(<Harness />)

        const calls: Array<[Boxed, Boxed]> = []
        captured!.onUpdate((next, prev) => void calls.push([next, prev]))

        act(() => setBoth?.({ data: { label: "b", count: 2 }, adapter: second }))

        expect(second.create).toHaveBeenCalledWith({ label: "a", count: 1 })
        expect(second.update).toHaveBeenCalledTimes(1)
        expect(second.update).toHaveBeenCalledWith({
            current: vi.mocked(second.create).mock.results[0]!.value,
            next: { label: "b", count: 2 },
        })
        expect(calls).toHaveLength(2)
        expect(captured!.current.boxed).toEqual({ label: "b", count: 2 })
    })

    it("falls back to the raw props when the adapter is dropped", () => {
        const adapter = makeAdapter()
        const Harness = makeHarness(adapter)
        render(<Harness />)

        const target = vi.mocked(adapter.create).mock.results[0]!.value
        expect(resolved!.current).toBe(target)

        act(() => setAdapter?.(undefined))

        expect(resolved!.current as unknown as Data).toEqual({ label: "a", count: 1 })

        act(() => setData?.({ label: "b", count: 2 }))
        expect(resolved!.current as unknown as Data).toEqual({ label: "b", count: 2 })
        expect(adapter.update).not.toHaveBeenCalled()
    })
})

// Token isolation
// ========================================

describe("usePropsRef token isolation", () => {
    it("keeps two bridges in one module independent", () => {
        const OTHER: InjectionToken<PropsRef<{ n: number }>> = Symbol.for("tests.props.second-bridge")

        let byClass: PropsRef<{ label: string }> | null = null
        let bySymbol: PropsRef<{ n: number }> | null = null
        let setLabel: ((value: string) => void) | null = null
        let setN: ((value: number) => void) | null = null

        function Probe() {
            byClass = useResolve(PropsRef) as PropsRef<{ label: string }>
            bySymbol = useResolve(OTHER)
            return null
        }

        function Harness() {
            const [label, setLabelState] = useState("a")
            const [n, setNState] = useState(1)
            setLabel = setLabelState
            setN = setNState

            const { provider: labelProvider } = usePropsRef({ label })
            const { provider: nProvider } = usePropsRef({ n }, { token: OTHER })

            return (
                <Root providers={[labelProvider, nProvider]}>
                    <Probe />
                </Root>
            )
        }

        render(<Harness />)

        expect(byClass!.current).toEqual({ label: "a" })
        expect(bySymbol!.current).toEqual({ n: 1 })
        expect(byClass as unknown).not.toBe(bySymbol as unknown)

        act(() => setLabel?.("b"))
        expect(byClass!.current).toEqual({ label: "b" })
        expect(bySymbol!.current).toEqual({ n: 1 })

        act(() => setN?.(2))
        expect(byClass!.current).toEqual({ label: "b" })
        expect(bySymbol!.current).toEqual({ n: 2 })
    })

    it("resolves the nearest module's bridge in each subtree", () => {
        function Probe({ id }: { id: string }) {
            const ref = useResolve(PropsRef) as PropsRef<{ who: string }>
            return <span data-testid={id}>{ref.current.who}</span>
        }

        function Child() {
            const { provider } = usePropsRef({ who: "child" })
            return (
                <ModuleProvider providers={[provider]}>
                    <Probe id="child" />
                </ModuleProvider>
            )
        }

        function Parent() {
            const { provider } = usePropsRef({ who: "parent" })
            return (
                <Root providers={[provider]}>
                    <Probe id="parent" />
                    <Child />
                </Root>
            )
        }

        render(<Parent />)

        expect(screen.getByTestId("parent").textContent).toBe("parent")
        expect(screen.getByTestId("child").textContent).toBe("child")
    })
})

// A subclass token builds the SUBCLASS
// ========================================
//
// A `PropsRef` subclass used as its own token is the typed way to give a bridge methods of its own:
// `inject(EditorPropsRef)` is declared to hand back an `EditorPropsRef`. That only holds if the hook
// constructs the class it registers under. It used to construct the base and register it under the
// subclass token, so the injected value failed `instanceof` and every subclass method was `undefined`
// while the types promised otherwise — a mismatch nothing caught until the method was called.

class EditorPropsRef extends PropsRef<Data> {
    describe(): string {
        return `label:${this.current.label}`
    }
}

describe("usePropsRef with a subclass token", () => {
    it("constructs the token class, so the ref IS an instance of it", () => {
        const captured: { ref?: PropsRef<Data>; provide?: unknown } = {}

        function Harness() {
            const { ref, provider } = usePropsRef<Data>({ label: "a", count: 1 }, { token: EditorPropsRef })
            captured.ref = ref
            captured.provide = provider.provide
            return null
        }

        render(<Harness />)

        expect(captured.provide).toBe(EditorPropsRef)
        expect(captured.ref).toBeInstanceOf(EditorPropsRef)
        // Still a PropsRef, so everything the base offers is there too.
        expect(captured.ref).toBeInstanceOf(PropsRef)
    })

    it("hands the injected value the subclass's own methods", () => {
        let described: string | null = null
        let injected: EditorPropsRef | null = null

        function Probe() {
            injected = useResolve(EditorPropsRef)
            described = injected.describe()
            return null
        }

        function Harness() {
            const { provider } = usePropsRef<Data>({ label: "a", count: 1 }, { token: EditorPropsRef })
            return (
                <Root providers={[provider]}>
                    <Probe />
                </Root>
            )
        }

        render(<Harness />)

        expect(injected).toBeInstanceOf(EditorPropsRef)
        expect(described).toBe("label:a")
    })

    it("keeps the subclass instance live across updates, like any other bridge", () => {
        let setLabel: ((value: string) => void) | null = null
        const resolved: EditorPropsRef[] = []

        function Probe() {
            resolved.push(useResolve(EditorPropsRef))
            return null
        }

        function Harness() {
            const [label, setLabelState] = useState("a")
            setLabel = setLabelState

            const { provider } = usePropsRef<Data>({ label, count: 1 }, { token: EditorPropsRef })
            return (
                <Root providers={[provider]}>
                    <Probe />
                </Root>
            )
        }

        render(<Harness />)
        expect(resolved[0]?.describe()).toBe("label:a")

        act(() => setLabel?.("b"))

        // One instance throughout — the subclass gets the same identity contract the base has — and its
        // own method reads the newly committed props.
        expect(new Set(resolved).size).toBe(1)
        expect(resolved[0]?.describe()).toBe("label:b")
    })

    it("leaves the symbol-token path constructing the base PropsRef", () => {
        const TOKEN: InjectionToken<PropsRef<Data>> = Symbol.for("tests.props.symbol-still-base")
        const captured: { ref?: PropsRef<Data> } = {}

        function Harness() {
            const { ref } = usePropsRef<Data>({ label: "a", count: 1 }, { token: TOKEN })
            captured.ref = ref
            return null
        }

        render(<Harness />)

        expect(captured.ref).toBeInstanceOf(PropsRef)
        expect(captured.ref).not.toBeInstanceOf(EditorPropsRef)
    })

    it("still constructs the base when no token is given at all", () => {
        const captured: { ref?: PropsRef<Data> } = {}

        function Harness() {
            const { ref } = usePropsRef<Data>({ label: "a", count: 1 })
            captured.ref = ref
            return null
        }

        render(<Harness />)

        expect(captured.ref).toBeInstanceOf(PropsRef)
        expect(captured.ref).not.toBeInstanceOf(EditorPropsRef)
    })
})
