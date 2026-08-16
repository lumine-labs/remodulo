import { act, render } from "@testing-library/react"
import { autorun, isObservable } from "mobx"
import { inject } from "@remodulo/container"
import { App, AppProvider, PropsRef, useResolve } from "@remodulo/react"
import { describe, expect, it } from "vitest"
import { useState, type ReactNode } from "react"

import { createMobxModuleComponent } from "../src/createMobxModuleComponent"
import { mobxProps } from "../src/mobxProps"

// `createMobxModuleComponent` is `createModuleComponent` with the MobX bridge already wired: no consumer
// ever writes `adapter: mobxProps<T>()` again, and the adapter identity is fixed at definition — which is
// what keeps the observable (and every reaction attached to it) alive across renders.

type Coords = { x: number; y: number }

function Root({ children }: { children?: ReactNode }) {
    const [app] = useState(() => new App())
    return <AppProvider app={app}>{children}</AppProvider>
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

// The bridged observable
// ========================================

describe("createMobxModuleComponent", () => {
    class Tracker {
        constructor(readonly props: PropsRef<Coords>) {}
    }

    const TrackerModule = createMobxModuleComponent<Coords>({
        providers: [{ provide: Tracker, useFactory: () => new Tracker(inject<PropsRef<Coords>>(PropsRef)) }],
    })

    it("bridges props as a MobX observable without the caller naming an adapter", () => {
        let tracker: Tracker | null = null

        function Probe() {
            tracker = useResolve(Tracker)
            return null
        }

        render(
            <Root>
                <TrackerModule x={1} y={1}>
                    <Probe />
                </TrackerModule>
            </Root>
        )

        expect(isObservable(tracker!.props.current)).toBe(true)
        expect(tracker!.props.current).toEqual({ x: 1, y: 1 })
    })

    it("creates once, mutates in place on update, and keeps a reaction alive across the change", () => {
        let tracker: Tracker | null = null
        let setCoords: ((coords: Coords) => void) | null = null

        function Probe() {
            tracker = useResolve(Tracker)
            return null
        }

        function Harness() {
            const [coords, setCoordsState] = useState<Coords>({ x: 1, y: 1 })
            setCoords = setCoordsState
            return (
                <Root>
                    <TrackerModule {...coords}>
                        <Probe />
                    </TrackerModule>
                </Root>
            )
        }

        render(<Harness />)

        const target = tracker!.props.current

        const seenX: number[] = []
        const dispose = autorun(() => {
            seenX.push(target.x)
        })
        expect(seenX).toEqual([1])

        act(() => {
            setCoords?.({ x: 2, y: 1 })
        })

        // Identity survived the re-render, which is the whole point of minting the adapter at definition
        // time: a fresh adapter per render would rebuild the target and orphan the autorun below.
        expect(tracker!.props.current).toBe(target)
        expect(target.x).toBe(2)
        expect(seenX).toEqual([1, 2])

        dispose()
    })

    it("removes a key the parent stopped passing, same as the bare adapter", () => {
        type Optional = { a: number; b?: number }

        const OptionalModule = createMobxModuleComponent<Optional>()

        let ref: PropsRef<Optional> | null = null
        let setProps: ((props: Optional) => void) | null = null

        function Probe() {
            ref = useResolve(PropsRef) as PropsRef<Optional>
            return null
        }

        function Harness() {
            const [props, setPropsState] = useState<Optional>({ a: 1, b: 2 })
            setProps = setPropsState
            return (
                <Root>
                    <OptionalModule {...props}>
                        <Probe />
                    </OptionalModule>
                </Root>
            )
        }

        render(<Harness />)
        expect(ref!.current).toEqual({ a: 1, b: 2 })

        act(() => {
            setProps?.({ a: 1 })
        })

        expect("b" in ref!.current).toBe(false)
    })
})

// PropsRef subclass as the token
// ========================================

describe("createMobxModuleComponent with a PropsRef subclass token", () => {
    type ChartProps = { series: string; window: number }

    class ChartPropsRef extends PropsRef<ChartProps> {
        get label(): string {
            return `${this.current.series}@${this.current.window}`
        }
    }

    const ChartModule = createMobxModuleComponent<ChartProps>(undefined, { token: ChartPropsRef })

    it("constructs the token class, so the injected ref is the subclass and its getters work", () => {
        let ref: ChartPropsRef | null = null

        function Probe() {
            ref = useResolve(ChartPropsRef)
            return null
        }

        render(
            <Root>
                <ChartModule series="cpu" window={5}>
                    <Probe />
                </ChartModule>
            </Root>
        )

        expect(ref).toBeInstanceOf(ChartPropsRef)
        expect(ref).toBeInstanceOf(PropsRef)
        expect(isObservable(ref!.current)).toBe(true)
        expect(ref!.label).toBe("cpu@5")
    })

    it("keeps the subclass getter tracking the observable across an update", () => {
        let ref: ChartPropsRef | null = null
        let setWindow: ((window: number) => void) | null = null

        function Probe() {
            ref = useResolve(ChartPropsRef)
            return null
        }

        function Harness() {
            const [window, setWindowState] = useState(5)
            setWindow = setWindowState
            return (
                <Root>
                    <ChartModule series="cpu" window={window}>
                        <Probe />
                    </ChartModule>
                </Root>
            )
        }

        render(<Harness />)

        const seen: string[] = []
        const dispose = autorun(() => {
            seen.push(ref!.label)
        })

        act(() => {
            setWindow?.(30)
        })

        expect(seen).toEqual(["cpu@5", "cpu@30"])

        dispose()
    })
})

// Config passthrough
// ========================================

describe("createMobxModuleComponent config passthrough", () => {
    type OrderProps = { orderId: string }
    type Enriched = { key: string }

    it("hands the config function the enriched props, verbatim", () => {
        const seenKeys: string[] = []

        const EnrichedModule = createMobxModuleComponent<OrderProps, Enriched>(
            (props) => {
                seenKeys.push(props.key)
                return { deps: [props.key] }
            },
            { use: (props) => ({ key: `k:${props.orderId}` }) }
        )

        render(
            <Root>
                <EnrichedModule orderId="a" />
            </Root>
        )

        // `use` ran first, so the config never sees `orderId` — only what enrichment produced.
        expect(seenKeys[0]).toBe("k:a")
    })

    it("runs the deps loop: deps change -> module rebuilds -> the factory recaptures", async () => {
        const built: string[] = []

        class Reader {
            constructor(readonly orderId: string) {
                built.push(orderId)
            }
        }

        const OrderModule = createMobxModuleComponent<OrderProps>((props) => ({
            providers: [{ provide: Reader, useFactory: () => new Reader(props.orderId) }],
            deps: [props.orderId],
        }))

        let seen: Reader | null = null

        function Probe() {
            seen = useResolve(Reader)
            return null
        }

        function Harness({ orderId }: OrderProps) {
            return (
                <Root>
                    <OrderModule orderId={orderId}>
                        <Probe />
                    </OrderModule>
                </Root>
            )
        }

        const { rerender } = render(<Harness orderId="a" />)
        expect(built).toEqual(["a"])
        expect(seen!.orderId).toBe("a")

        rerender(<Harness orderId="b" />)
        await flush()

        expect(built).toEqual(["a", "b"])
        expect(seen!.orderId).toBe("b")
    })
})

// Type surface
// ========================================

describe("createMobxModuleComponent type surface", () => {
    it("refuses an `adapter` in the props bridge — the wrapper owns that slot", () => {
        const Bad = createMobxModuleComponent<Coords>(undefined, {
            // @ts-expect-error the adapter is encapsulated; the props param has no such key
            adapter: mobxProps<Coords>(),
        })

        expect(Bad).toBeTypeOf("function")
    })

    it("infers P and T from `use` without explicit generics, like the base factory", () => {
        const Inferred = createMobxModuleComponent(undefined, {
            use: (props: { n: number }) => ({ doubled: props.n * 2 }),
        })

        let ref: PropsRef<{ doubled: number }> | null = null

        function Probe() {
            ref = useResolve(PropsRef) as PropsRef<{ doubled: number }>
            return null
        }

        // Never rendered — this asserts the inferred `P`, which is what the component's props are checked
        // against.
        // @ts-expect-error `n` is a number, inferred from `use`
        void (<Inferred n="4" />)

        render(
            <Root>
                <Inferred n={4}>
                    <Probe />
                </Inferred>
            </Root>
        )

        expect(ref!.current).toEqual({ doubled: 8 })
    })
})
