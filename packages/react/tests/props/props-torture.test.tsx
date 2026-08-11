import { act, render } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useMemo, useState } from "react"

import { createModuleComponent } from "../../src/react/createModuleComponent.js"
import { ModuleProvider } from "../../src/react/ModuleProvider.js"
import { PropsRef, type PropsAdapter } from "../../src/primitives/props-ref.js"
import { useResolve } from "../../src/react/useResolve.js"
import { inject } from "@remodulo/container"
import type { InjectionToken } from "@remodulo/container"
import { flush } from "../setup/helpers.js"
import { Root } from "../setup/react.js"

// Pre-1.0 hardening for the props bridge. Everything here pins BEHAVIOUR AS MEASURED, not behaviour as
// wished for: the shallow-equal gate's exact edges, the live-Set notification hazards, and the rebuild
// footgun the design notes call an "accepted tradeoff" (§7 of agent-notes/design/props-and-module-factories.md).
// Where the measured semantics are a trap for consumers the test says so in its name, so a future change
// that fixes the trap fails loudly instead of silently.

type Data = { label: string; count: number }
type UserProps = { userId: string; name: string }
type Boxed<P> = { boxed: P }

// Availability: when is `current` first readable?
// ========================================
//
// Ordering under `createModuleComponent`, all inside the first render + commit:
//   usePropsRef's useState initializer (ref exists, holding the first props)
//     → ModuleProvider's useState initializer → new Module() → module.init()
//         → eager container.resolve of every non-lazy provider  (SERVICE CONSTRUCTORS RUN HERE)
//         → module onModuleInit hook → instance onModuleInit
//     → commit → layout effects → usePropsRef's ref.update(props)  (a no-op on first commit)
//     → passive effects → module.mount() → module onModuleMount hook → instance onModuleMount

describe("PropsRef is readable from the earliest possible point", () => {
    type Sighting = { at: string; props: UserProps; updatesSoFar: number }

    const sightings: Sighting[] = []

    class EarlyReader {
        readonly updates: UserProps[] = []

        constructor(readonly ref: PropsRef<UserProps>) {
            this.ref.onUpdate((next) => void this.updates.push(next))
            this.see("service:ctor")
        }

        onModuleInit(): void {
            this.see("service:init")
        }

        onModuleMount(): void {
            this.see("service:mount")
        }

        private see(at: string): void {
            sightings.push({ at, props: this.ref.current, updatesSoFar: this.updates.length })
        }
    }

    const ReaderModule = createModuleComponent<UserProps>({
        providers: [
            { provide: EarlyReader, useFactory: () => new EarlyReader(inject<PropsRef<UserProps>>(PropsRef)) },
        ],
        onModuleInit: (container) => {
            const ref = container.resolve(PropsRef) as PropsRef<UserProps>
            sightings.push({ at: "module:init", props: ref.current, updatesSoFar: -1 })
        },
        onModuleMount: (container) => {
            const ref = container.resolve(PropsRef) as PropsRef<UserProps>
            sightings.push({ at: "module:mount", props: ref.current, updatesSoFar: -1 })
        },
    })

    beforeEach(() => {
        sightings.length = 0
    })

    it("holds the initial props already in the constructor of an eagerly-resolved provider", () => {
        render(
            <Root>
                <ReaderModule userId="u1" name="Ann" />
            </Root>
        )

        const first = sightings[0]!
        expect(first.at).toBe("service:ctor")
        expect(first.props).toEqual({ userId: "u1", name: "Ann" })
    })

    it("carries the same initial props through every lifecycle phase, in construction-first order", () => {
        render(
            <Root>
                <ReaderModule userId="u1" name="Ann" />
            </Root>
        )

        expect(sightings.map((sighting) => sighting.at)).toEqual([
            "service:ctor",
            "module:init",
            "service:init",
            "module:mount",
            "service:mount",
        ])

        for (const sighting of sightings) {
            expect(sighting.props).toEqual({ userId: "u1", name: "Ann" })
        }
    })

    it("delivers no onUpdate for the initial props — the first layout-effect update is gated out", () => {
        render(
            <Root>
                <ReaderModule userId="u1" name="Ann" />
            </Root>
        )

        // The bridge was constructed FROM the first render's props, so the layout effect that follows the
        // first commit hands `update()` the very same object and the shallow-equal gate swallows it.
        for (const sighting of sightings) {
            if (sighting.updatesSoFar >= 0) expect(sighting.updatesSoFar).toBe(0)
        }
    })

    it("reads the same object identity from `current` at every phase", () => {
        render(
            <Root>
                <ReaderModule userId="u1" name="Ann" />
            </Root>
        )

        const identity = sightings[0]!.props
        for (const sighting of sightings) {
            expect(sighting.props).toBe(identity)
        }
    })
})

// Update propagation: exact (next, prev)
// ========================================

describe("PropsRef update propagation through a module component", () => {
    it("hands subscribers exactly (next, prev) by identity when the parent re-renders", () => {
        const UserModule = createModuleComponent<UserProps>()

        let bridge: PropsRef<UserProps> | null = null
        let setProps: ((props: UserProps) => void) | null = null
        const calls: Array<{ next: UserProps; prev: UserProps; currentAtCall: UserProps }> = []

        function Probe() {
            bridge = useResolve(PropsRef) as PropsRef<UserProps>
            return null
        }

        function Harness() {
            const [props, setPropsState] = useState<UserProps>({ userId: "u1", name: "Ann" })
            setProps = setPropsState
            return (
                <Root>
                    <UserModule {...props}>
                        <Probe />
                    </UserModule>
                </Root>
            )
        }

        render(<Harness />)

        const initial = bridge!.current
        expect(initial).toEqual({ userId: "u1", name: "Ann" })

        bridge!.onUpdate((next, prev) => void calls.push({ next, prev, currentAtCall: bridge!.current }))

        act(() => setProps?.({ userId: "u1", name: "Bob" }))

        expect(calls).toHaveLength(1)
        // `next` is the exact object `current` now returns, `prev` the exact object it returned before.
        expect(calls[0]!.next).toBe(bridge!.current)
        expect(calls[0]!.next).toEqual({ userId: "u1", name: "Bob" })
        expect(calls[0]!.prev).toBe(initial)
        expect(calls[0]!.prev).toEqual({ userId: "u1", name: "Ann" })
        // `current` is already the new value by the time subscribers run — notify comes after the write.
        expect(calls[0]!.currentAtCall).toBe(calls[0]!.next)

        const second = bridge!.current
        act(() => setProps?.({ userId: "u1", name: "Cara" }))

        expect(calls).toHaveLength(2)
        expect(calls[1]!.prev).toBe(second)
        expect(calls[1]!.next).toEqual({ userId: "u1", name: "Cara" })
    })

    it("chains prev to the previous next across a run of updates, skipping the no-op renders", () => {
        const ref = new PropsRef<Data>({ props: { label: "a", count: 1 } })
        const pairs: Array<[Data, Data]> = []
        ref.onUpdate((next, prev) => void pairs.push([next, prev]))

        const b: Data = { label: "b", count: 2 }
        const c: Data = { label: "c", count: 3 }

        ref.update(b)
        ref.update({ label: "b", count: 2 }) // shallow-equal to b — no event, and no break in the chain
        ref.update(c)

        expect(pairs).toHaveLength(2)
        expect(pairs[0]![0]).toBe(b)
        expect(pairs[1]![1]).toBe(b)
        expect(pairs[1]![0]).toBe(c)
    })
})

// Shallow equality — the exact gate
// ========================================
//
// MEASURED SEMANTICS: the gate is `shallowEqual(this.plain, next)` where `plain` is the last APPLIED raw
// props. It runs BEFORE the adapter is consulted, so it is adapter-independent by construction — no adapter,
// present or future (mobx, effector), can widen or narrow it, and no comparator can be supplied. Equality is
// own-enumerable-keys + `Object.is` per value, one level deep.

describe("PropsRef shallow-equality gate", () => {
    it("is decided before the adapter is reached, so the adapter cannot influence it", () => {
        const adapter: PropsAdapter<Data, Boxed<Data>> = {
            create: vi.fn((initial: Data) => ({ boxed: initial })),
            update: vi.fn(({ current, next }: { current: Boxed<Data>; next: Data }) => {
                current.boxed = next
                return current
            }),
        }
        const ref = new PropsRef<Boxed<Data>>({ props: { label: "a", count: 1 }, adapter })
        const subscriber = vi.fn()
        ref.onUpdate(subscriber)

        ref.update({ label: "a", count: 1 })

        expect(adapter.update).not.toHaveBeenCalled()
        expect(subscriber).not.toHaveBeenCalled()
    })

    it("compares against the last APPLIED props, not against the value the adapter exposes", () => {
        // A mutate adapter's `value` is a stable box; the gate never looks at it.
        const adapter: PropsAdapter<Data, Boxed<Data>> = {
            create: (initial) => ({ boxed: initial }),
            update: ({ current, next }) => {
                current.boxed = next
                return current
            },
        }
        const ref = new PropsRef<Boxed<Data>>({ props: { label: "a", count: 1 }, adapter })
        const subscriber = vi.fn()
        ref.onUpdate(subscriber)

        ref.update({ label: "b", count: 2 })
        expect(subscriber).toHaveBeenCalledTimes(1)

        // Same raw props again: gated out even though `value` is a mutable box that could have drifted.
        ref.update({ label: "b", count: 2 })
        expect(subscriber).toHaveBeenCalledTimes(1)
    })

    it("fires when a key is ADDED with an undefined value — key count is part of the comparison", () => {
        const ref = new PropsRef<{ label: string; extra?: undefined }>({ props: { label: "a" } })
        const subscriber = vi.fn()
        ref.onUpdate(subscriber)

        // `<M label="a" extra={undefined} />` really does produce a two-key props object.
        ref.update({ label: "a", extra: undefined })

        expect(subscriber).toHaveBeenCalledTimes(1)
        expect(Object.keys(ref.current)).toEqual(["label", "extra"])
    })

    it("fires again when that undefined key is REMOVED", () => {
        const ref = new PropsRef<{ label: string; extra?: undefined }>({ props: { label: "a", extra: undefined } })
        const subscriber = vi.fn()
        ref.onUpdate(subscriber)

        ref.update({ label: "a" })

        expect(subscriber).toHaveBeenCalledTimes(1)
    })

    it("stays quiet for NaN → NaN, because the gate is Object.is and not ===", () => {
        const ref = new PropsRef<{ n: number }>({ props: { n: NaN } })
        const subscriber = vi.fn()
        ref.onUpdate(subscriber)

        ref.update({ n: NaN })

        expect(subscriber).not.toHaveBeenCalled()
    })

    it("FIRES for +0 → -0, for the same reason — Object.is separates the zeroes", () => {
        const ref = new PropsRef<{ n: number }>({ props: { n: 0 } })
        const subscriber = vi.fn()
        ref.onUpdate(subscriber)

        ref.update({ n: -0 })

        expect(subscriber).toHaveBeenCalledTimes(1)
    })

    it("is one level deep: a new-but-equal nested object fires", () => {
        const ref = new PropsRef<{ filter: { q: string } }>({ props: { filter: { q: "x" } } })
        const subscriber = vi.fn()
        ref.onUpdate(subscriber)

        ref.update({ filter: { q: "x" } })

        expect(subscriber).toHaveBeenCalledTimes(1)
    })

    it("is one level deep the other way too: a MUTATED nested object is invisible", () => {
        // FOOTGUN. The nested object keeps its identity, so the gate sees no change and no subscriber runs
        // — while `current.filter.q` has already moved. Consumers reading through `current` see the new
        // value; consumers driven by `onUpdate` never hear about it.
        const filter = { q: "x" }
        const ref = new PropsRef<{ filter: { q: string } }>({ props: { filter } })
        const subscriber = vi.fn()
        ref.onUpdate(subscriber)

        filter.q = "y"
        ref.update({ filter })

        expect(subscriber).not.toHaveBeenCalled()
        expect(ref.current.filter.q).toBe("y")
    })

    it("ignores symbol-keyed props entirely — Object.keys does not see them", () => {
        const KEY = Symbol("hidden")
        const ref = new PropsRef<Record<symbol, number> & { label: string }>({ props: { label: "a", [KEY]: 1 } })
        const subscriber = vi.fn()
        ref.onUpdate(subscriber)

        ref.update({ label: "a", [KEY]: 2 })

        expect(subscriber).not.toHaveBeenCalled()
        // ...and `current` still points at the OLD object, so the symbol value is stale too.
        expect(ref.current[KEY]).toBe(1)
    })

    it("swallows an in-place mutation of the very same props object", () => {
        // FOOTGUN. `Object.is(plain, next)` short-circuits the whole comparison, so handing back the same
        // (mutated) object is a total no-op: subscribers are silent while `current` already reads new.
        const props: Data = { label: "a", count: 1 }
        const ref = new PropsRef<Data>({ props })
        const subscriber = vi.fn()
        ref.onUpdate(subscriber)

        props.count = 99
        ref.update(props)

        expect(subscriber).not.toHaveBeenCalled()
        expect(ref.current.count).toBe(99)
    })

    it("fires on EVERY parent re-render when a prop holds an inline object", () => {
        // FOOTGUN, and the common one. `createModuleComponent` rest-spreads a fresh props object per render,
        // but the gate saves you — unless a prop VALUE is unstable, in which case every unrelated parent
        // render is a "real" props change and every subscriber runs.
        const UnstableModule = createModuleComponent<{ config: { mode: string } }>()

        let bridge: PropsRef<{ config: { mode: string } }> | null = null
        let bump: (() => void) | null = null
        const subscriber = vi.fn()

        function Probe() {
            bridge = useResolve(PropsRef) as PropsRef<{ config: { mode: string } }>
            return null
        }

        function Harness() {
            const [, setTick] = useState(0)
            bump = () => setTick((tick) => tick + 1)
            return (
                <Root>
                    <UnstableModule config={{ mode: "fast" }}>
                        <Probe />
                    </UnstableModule>
                </Root>
            )
        }

        render(<Harness />)
        bridge!.onUpdate(subscriber)

        act(() => bump?.())
        act(() => bump?.())

        expect(subscriber).toHaveBeenCalledTimes(2)
        expect(bridge!.current.config).toEqual({ mode: "fast" })
    })

    it("stays quiet across unrelated parent re-renders once every prop value is stable", () => {
        const config = { mode: "fast" }
        const StableModule = createModuleComponent<{ config: { mode: string } }>()

        let bridge: PropsRef<{ config: { mode: string } }> | null = null
        let bump: (() => void) | null = null
        const subscriber = vi.fn()

        function Probe() {
            bridge = useResolve(PropsRef) as PropsRef<{ config: { mode: string } }>
            return null
        }

        function Harness() {
            const [, setTick] = useState(0)
            bump = () => setTick((tick) => tick + 1)
            return (
                <Root>
                    <StableModule config={config}>
                        <Probe />
                    </StableModule>
                </Root>
            )
        }

        render(<Harness />)
        bridge!.onUpdate(subscriber)

        act(() => bump?.())
        act(() => bump?.())

        expect(subscriber).not.toHaveBeenCalled()
    })
})

// Notification re-entrancy — the subscriber Set is SNAPSHOT before the pass
// ========================================
//
// THE CONTRACT: `notify` does `for (const cb of [...this.subscribers])`. The pass runs against the set as
// it stood when the pass began, so subscribing or unsubscribing from inside a subscriber cannot change who
// this pass reaches — it takes effect from the next one. That makes a notification pass a fixed list
// rather than a moving target, which is the only version of this that is reasonable to depend on: under
// live iteration, whether your subscriber ran depended on where it happened to sit in insertion order
// relative to whoever mutated the set.

describe("PropsRef notification re-entrancy", () => {
    it("STILL CALLS a later subscriber that an earlier one unsubscribes mid-notification", () => {
        const ref = new PropsRef<Data>({ props: { label: "a", count: 1 } })
        const later = vi.fn()

        const offLater = { current: (): void => {} }
        ref.onUpdate(() => offLater.current())
        offLater.current = ref.onUpdate(later)

        ref.update({ label: "b", count: 2 })

        // It was in the set when the pass began, so the pass owes it this one call.
        expect(later).toHaveBeenCalledTimes(1)

        // The unsubscribe took effect for everything after.
        ref.update({ label: "c", count: 3 })
        expect(later).toHaveBeenCalledTimes(1)
    })

    it("still delivers to an EARLIER subscriber that a later one unsubscribes mid-notification", () => {
        const ref = new PropsRef<Data>({ props: { label: "a", count: 1 } })
        const earlier = vi.fn()

        const offEarlier = ref.onUpdate(earlier)
        ref.onUpdate(() => offEarlier())

        ref.update({ label: "b", count: 2 })
        expect(earlier).toHaveBeenCalledTimes(1)

        ref.update({ label: "c", count: 3 })
        expect(earlier).toHaveBeenCalledTimes(1)
    })

    it("DEFERS a subscriber added mid-notification to the next pass, never the one that added it", () => {
        const ref = new PropsRef<Data>({ props: { label: "a", count: 1 } })
        const late = vi.fn()
        let added = false

        ref.onUpdate(() => {
            if (added) return
            added = true
            ref.onUpdate(late)
        })

        const first: Data = { label: "b", count: 2 }
        ref.update(first)

        // Missing the pass it was added in is the point: a subscriber never sees a transition that was
        // already in flight when it registered, so it cannot observe a `prev` it was never around for.
        expect(late).not.toHaveBeenCalled()

        const second: Data = { label: "c", count: 3 }
        ref.update(second)

        expect(late).toHaveBeenCalledTimes(1)
        expect(late.mock.calls[0]![0]).toBe(second)
        expect(late.mock.calls[0]![1]).toBe(first)
    })

    it("keeps a self-unsubscribing subscriber's throw from taking the rest of the pass down", () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
        const ref = new PropsRef<Data>({ props: { label: "a", count: 1 } })
        const after = vi.fn()

        const offSelf = { current: (): void => {} }
        offSelf.current = ref.onUpdate(() => {
            offSelf.current()
            throw new Error("boom")
        })
        ref.onUpdate(after)

        ref.update({ label: "b", count: 2 })
        expect(after).toHaveBeenCalledTimes(1)
        expect(errorSpy).toHaveBeenCalledTimes(1)

        ref.update({ label: "c", count: 3 })
        expect(after).toHaveBeenCalledTimes(2)
        expect(errorSpy).toHaveBeenCalledTimes(1)

        errorSpy.mockRestore()
    })

    it("delivers a re-entrant update NEWEST-FIRST, leaving a later subscriber a stale (next, prev)", () => {
        // HAZARD. A subscriber that calls `update()` re-enters `notify` immediately, so subscribers that
        // have not been reached yet get the NEW pair first and the OLD pair afterwards — and on that trailing
        // delivery the `next` they are handed is no longer `ref.current`. `onUpdate` is documented as "one
        // event per applied change"; it does not promise an order, and the measured order is inverted.
        const first: Data = { label: "a", count: 1 }
        const second: Data = { label: "b", count: 2 }
        const third: Data = { label: "c", count: 3 }

        const ref = new PropsRef<Data>({ props: first })
        const log: Array<{ who: string; next: Data; prev: Data; currentAtCall: Data }> = []
        let reentered = false

        ref.onUpdate((next, prev) => {
            log.push({ who: "first", next, prev, currentAtCall: ref.current })
            if (reentered) return
            reentered = true
            ref.update(third)
        })
        ref.onUpdate((next, prev) => {
            log.push({ who: "second", next, prev, currentAtCall: ref.current })
        })

        ref.update(second)

        expect(log).toHaveLength(4)
        expect(log.map((entry) => `${entry.who}:${entry.next.label}<-${entry.prev.label}`)).toEqual([
            "first:b<-a",
            "first:c<-b",
            "second:c<-b",
            "second:b<-a",
        ])

        // The trailing delivery is stale: `next` says "b" while the ref has long since moved to "c".
        expect(log[3]!.next).toBe(second)
        expect(log[3]!.currentAtCall).toBe(third)
        expect(ref.current).toBe(third)
    })

    it("keeps three subscribers fully independent across partial unsubscription", () => {
        const ref = new PropsRef<Data>({ props: { label: "a", count: 1 } })
        const a = vi.fn()
        const b = vi.fn()
        const c = vi.fn()

        const offA = ref.onUpdate(a)
        const offB = ref.onUpdate(b)
        ref.onUpdate(c)

        ref.update({ label: "b", count: 2 })
        expect([a, b, c].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1])

        offB()
        ref.update({ label: "c", count: 3 })
        expect([a, b, c].map((fn) => fn.mock.calls.length)).toEqual([2, 1, 2])

        offA()
        ref.update({ label: "d", count: 4 })
        expect([a, b, c].map((fn) => fn.mock.calls.length)).toEqual([2, 1, 3])
    })
})

// Rebuild — the documented footgun, made visible
// ========================================
//
// MEASURED SEMANTICS: the bridge is COMPONENT-owned. A `deps` change tears down the container and
// rebuilds it, but `usePropsRef`'s `useState` initializer never re-runs, so the SAME `PropsRef` instance is
// re-registered into the new container — and its subscriber Set is never touched by the rebuild. A service
// from a dead generation that did not `off()` in `onModuleDestroy` therefore keeps receiving every future
// update, forever, off a ref whose `current` is permanently fresh. Design notes §7 calls this an accepted
// tradeoff; these tests are what "accepted" costs.

describe("PropsRef across a module rebuild", () => {
    class LeakyService {
        readonly seen: UserProps[] = []

        constructor(readonly ref: PropsRef<UserProps>) {
            // The omission under test: no stored `off()`, no onModuleDestroy.
            ref.onUpdate((next) => void this.seen.push(next))
        }
    }

    let instances: LeakyService[] = []

    const LeakyModule = createModuleComponent<UserProps>((props) => ({
        deps: [props.userId],
        providers: [
            {
                provide: LeakyService,
                useFactory: () => {
                    const service = new LeakyService(inject<PropsRef<UserProps>>(PropsRef))
                    instances.push(service)
                    return service
                },
            },
        ],
    }))

    let setProps: ((props: UserProps) => void) | null = null

    function Harness() {
        const [props, setPropsState] = useState<UserProps>({ userId: "u1", name: "Ann" })
        setProps = setPropsState
        return (
            <Root>
                <LeakyModule {...props} />
            </Root>
        )
    }

    beforeEach(() => {
        instances = []
        setProps = null
    })

    it("re-registers the SAME bridge instance into the rebuilt container", () => {
        render(<Harness />)
        expect(instances).toHaveLength(1)

        act(() => setProps?.({ userId: "u2", name: "Cara" }))

        expect(instances).toHaveLength(2)
        expect(instances[1]!.ref).toBe(instances[0]!.ref)
        expect(instances[1]!.ref.current).toEqual({ userId: "u2", name: "Cara" })
    })

    it("KEEPS FIRING into the destroyed generation when the service never unsubscribes", async () => {
        render(<Harness />)

        act(() => setProps?.({ userId: "u2", name: "Cara" }))

        // Let the torn-down module finish its async destroy — it changes nothing here, because nothing in
        // the framework knows about the subscription.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20))
        })

        act(() => setProps?.({ userId: "u2", name: "Dee" }))

        // `Cara` is the change that rebuilt generation 0 — it is still subscribed when the bridge applies it
        // (see the "outgoing generation" test below). `Dee` is the leak: a destroyed, detached, unreferenced-
        // by-the-container service processing props minutes or hours after its module died.
        expect(instances[0]!.seen).toEqual([
            { userId: "u2", name: "Cara" },
            { userId: "u2", name: "Dee" },
        ])
        expect(instances[1]!.seen).toEqual([{ userId: "u2", name: "Dee" }])
    })

    it("accumulates one live subscriber per rebuild, unboundedly", async () => {
        render(<Harness />)

        for (const userId of ["u2", "u3", "u4"]) {
            act(() => setProps?.({ userId, name: "Ann" }))
            // eslint-disable-next-line no-await-in-loop
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 20))
            })
        }

        expect(instances).toHaveLength(4)

        act(() => setProps?.({ userId: "u4", name: "Zoe" }))

        // Four generations, one props change, four deliveries. Three of those services are dead.
        for (const service of instances) {
            expect(service.seen.at(-1)).toEqual({ userId: "u4", name: "Zoe" })
        }
        expect(instances.map((service) => service.seen.length)).toEqual([4, 3, 2, 1])
    })

    it("still reads LIVE props from `current` in a generation the rebuild destroyed", async () => {
        render(<Harness />)
        const dead = instances[0]!

        act(() => setProps?.({ userId: "u2", name: "Cara" }))
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20))
        })
        act(() => setProps?.({ userId: "u2", name: "Dee" }))

        expect(dead.ref.current).toEqual({ userId: "u2", name: "Dee" })
    })
})

describe("PropsRef and the documented remedy (off() in onModuleDestroy)", () => {
    class TidyService {
        readonly seen: UserProps[] = []
        readonly off: () => void

        constructor(readonly ref: PropsRef<UserProps>) {
            this.off = ref.onUpdate((next) => void this.seen.push(next))
        }

        onModuleDestroy(): void {
            this.off()
        }
    }

    let instances: TidyService[] = []

    const TidyModule = createModuleComponent<UserProps>((props) => ({
        deps: [props.userId],
        providers: [
            {
                provide: TidyService,
                useFactory: () => {
                    const service = new TidyService(inject<PropsRef<UserProps>>(PropsRef))
                    instances.push(service)
                    return service
                },
            },
        ],
    }))

    let setProps: ((props: UserProps) => void) | null = null

    function Harness() {
        const [props, setPropsState] = useState<UserProps>({ userId: "u1", name: "Ann" })
        setProps = setPropsState
        return (
            <Root>
                <TidyModule {...props} />
            </Root>
        )
    }

    beforeEach(() => {
        instances = []
        setProps = null
    })

    it("notifies the OUTGOING generation of the very props change that rebuilds it", () => {
        // MEASURED, and worth knowing even when your services are well-behaved. The layout-effect order is:
        // ModuleProvider's deps diff (which only SCHEDULES a rebuild) → usePropsRef's `ref.update(props)`
        // → the scheduled rebuild. So the bridge applies the identity change while the outgoing generation is
        // still subscribed and still alive. The change is then observed TWICE by two different instances:
        // once as an `onUpdate` on the dying service, once as `current` in the incoming service's constructor.
        // A service whose onUpdate does real work (a fetch, an analytics event) does that work on the way out.
        render(<Harness />)
        const outgoing = instances[0]!

        act(() => setProps?.({ userId: "u2", name: "Cara" }))

        expect(instances).toHaveLength(2)
        expect(outgoing.seen).toEqual([{ userId: "u2", name: "Cara" }])
        expect(instances[1]!.ref.current).toEqual({ userId: "u2", name: "Cara" })
        expect(instances[1]!.seen).toEqual([])
    })

    it("drops the dead generation's subscription one macrotask late, when the deferred destroy runs", async () => {
        // MEASURED, and the cost of the deferred destroy. The PropsRef is COMPONENT-owned — `usePropsRef`
        // holds it in a `useState` and registers the same instance into every generation — so a retired
        // service stays on the shared ref until its own `off()` runs, and `off()` lives in `onModuleDestroy`.
        // ModuleProvider's cleanup no longer destroys; it schedules. The remedy still works, one turn late,
        // and any props change inside that window is delivered to BOTH generations.
        render(<Harness />)

        act(() => setProps?.({ userId: "u2", name: "Cara" }))
        act(() => setProps?.({ userId: "u2", name: "Dee" }))

        expect(instances).toHaveLength(2)
        expect(instances[0]!.seen).toEqual([
            { userId: "u2", name: "Cara" },
            { userId: "u2", name: "Dee" },
        ])
        expect(instances[1]!.seen).toEqual([{ userId: "u2", name: "Dee" }])

        // Once the timer fires the destroy phase runs, `off()` lands, and the window is shut for good.
        await flush()
        act(() => setProps?.({ userId: "u2", name: "Eve" }))

        expect(instances[0]!.seen).toEqual([
            { userId: "u2", name: "Cara" },
            { userId: "u2", name: "Dee" },
        ])
        expect(instances[1]!.seen).toEqual([
            { userId: "u2", name: "Dee" },
            { userId: "u2", name: "Eve" },
        ])
    })

    it("leaves each generation with exactly its own farewell update, no matter how many rebuilds happened", async () => {
        render(<Harness />)

        for (const userId of ["u2", "u3", "u4"]) {
            act(() => setProps?.({ userId, name: "Ann" }))
            // eslint-disable-next-line no-await-in-loop
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 20))
            })
        }

        act(() => setProps?.({ userId: "u4", name: "Zoe" }))

        expect(instances).toHaveLength(4)
        // Contrast with LeakyService's [4, 3, 2, 1]: the counts stay flat instead of growing with age.
        expect(instances.map((service) => service.seen.length)).toEqual([1, 1, 1, 1])
        expect(instances[3]!.seen).toEqual([{ userId: "u4", name: "Zoe" }])
    })
})

// One bridge per module — siblings with their own adapters
// ========================================

describe("PropsRef per sibling module", () => {
    type Point = { x: number }

    // RESHAPED: `PropsAdapter<T>` is T -> T now, so the Point -> Boxed step moved to `use` (see `boxes`
    // below) and the adapter is the identity-stable updater it always was underneath.
    function makeAdapter() {
        return {
            create: vi.fn((initial: Boxed<Point>) => initial),
            update: vi.fn(({ current, next }: { current: Boxed<Point>; next: Boxed<Point> }) => {
                current.boxed = next.boxed
                return current
            }),
        } satisfies PropsAdapter<Boxed<Point>>
    }

    /**
     * The enrichment half of what the old P -> T adapter did, as a custom hook — and MEMOISED, which is
     * load-bearing. `PropsRef.update` guards on a shallow compare of what it was last handed; enrichment
     * puts a nested object in that position, so an un-memoised `use` returns a fresh wrapper every render
     * and the guard never fires. `use` is a real hook, so the fix is the ordinary one.
     */
    const boxes = (props: Point): Boxed<Point> => useMemo(() => ({ boxed: props }), [props.x])

    it("gives each sibling its own ref and its own adapter target, with no crosstalk", () => {
        const adapterA = makeAdapter()
        const adapterB = makeAdapter()

        // Same default class token in both — they never collide, because each mount owns its container.
        const ModuleA = createModuleComponent<Point, Boxed<Point>>(undefined, { use: boxes, adapter: adapterA })
        const ModuleB = createModuleComponent<Point, Boxed<Point>>(undefined, { use: boxes, adapter: adapterB })

        let refA: PropsRef<Boxed<Point>> | null = null
        let refB: PropsRef<Boxed<Point>> | null = null
        let setA: ((point: Point) => void) | null = null
        let setB: ((point: Point) => void) | null = null

        function ProbeA() {
            refA = useResolve(PropsRef) as PropsRef<Boxed<Point>>
            return null
        }

        function ProbeB() {
            refB = useResolve(PropsRef) as PropsRef<Boxed<Point>>
            return null
        }

        function Harness() {
            const [a, setAState] = useState<Point>({ x: 1 })
            const [b, setBState] = useState<Point>({ x: 100 })
            setA = setAState
            setB = setBState
            return (
                <Root>
                    <ModuleA {...a}>
                        <ProbeA />
                    </ModuleA>
                    <ModuleB {...b}>
                        <ProbeB />
                    </ModuleB>
                </Root>
            )
        }

        render(<Harness />)

        expect(refA as unknown).not.toBe(refB as unknown)
        expect(adapterA.create).toHaveBeenCalledTimes(1)
        expect(adapterA.create).toHaveBeenCalledWith({ boxed: { x: 1 } })
        expect(adapterB.create).toHaveBeenCalledTimes(1)
        expect(adapterB.create).toHaveBeenCalledWith({ boxed: { x: 100 } })

        const seenA: Array<Boxed<Point>> = []
        const seenB: Array<Boxed<Point>> = []
        refA!.onUpdate((next) => void seenA.push(next))
        refB!.onUpdate((next) => void seenB.push(next))

        act(() => setA?.({ x: 2 }))

        expect(adapterA.update).toHaveBeenCalledTimes(1)
        expect(adapterB.update).not.toHaveBeenCalled()
        expect(seenA).toHaveLength(1)
        expect(seenB).toHaveLength(0)
        expect(refA!.current.boxed).toEqual({ x: 2 })
        expect(refB!.current.boxed).toEqual({ x: 100 })

        act(() => setB?.({ x: 200 }))

        expect(adapterA.update).toHaveBeenCalledTimes(1)
        expect(adapterB.update).toHaveBeenCalledTimes(1)
        expect(seenA).toHaveLength(1)
        expect(seenB).toHaveLength(1)
        expect(refA!.current.boxed).toEqual({ x: 2 })
        expect(refB!.current.boxed).toEqual({ x: 200 })
    })

    it("runs create once per mount even when both siblings share one adapter object", () => {
        const shared = makeAdapter()
        const PointModule = createModuleComponent<Point, Boxed<Point>>(undefined, { use: boxes, adapter: shared })

        const refs: PropsRef<Boxed<Point>>[] = []

        function Probe() {
            refs.push(useResolve(PropsRef) as PropsRef<Boxed<Point>>)
            return null
        }

        render(
            <Root>
                <PointModule x={1}>
                    <Probe />
                </PointModule>
                <PointModule x={2}>
                    <Probe />
                </PointModule>
            </Root>
        )

        expect(shared.create).toHaveBeenCalledTimes(2)
        expect(refs[0]).not.toBe(refs[1])
        expect(refs[0]!.current).not.toBe(refs[1]!.current)
        expect(refs[0]!.current.boxed).toEqual({ x: 1 })
        expect(refs[1]!.current.boxed).toEqual({ x: 2 })
    })
})

// Nested scopes — nearest registered wins
// ========================================

describe("PropsRef resolution through nested module scopes", () => {
    type Who = { who: string }

    it("shadows the parent's bridge with the child's own, all the way down the chain", () => {
        const Outer = createModuleComponent<Who>()
        const Inner = createModuleComponent<Who>()

        const found: Record<string, PropsRef<Who>> = {}

        function Probe({ id }: { id: string }) {
            found[id] = useResolve(PropsRef) as PropsRef<Who>
            return null
        }

        render(
            <Root>
                <Outer who="outer">
                    <Probe id="outer" />
                    <Inner who="inner">
                        <Probe id="inner" />
                        <ModuleProvider>
                            <Probe id="grandchild" />
                        </ModuleProvider>
                    </Inner>
                </Outer>
            </Root>
        )

        expect(found.outer!.current).toEqual({ who: "outer" })
        expect(found.inner!.current).toEqual({ who: "inner" })
        // The bridge-less grandchild walks up and stops at the FIRST registration it meets.
        expect(found.grandchild).toBe(found.inner)
        expect(found.inner).not.toBe(found.outer)
    })

    it("keeps parent and child updates from crossing", () => {
        const Outer = createModuleComponent<Who>()
        const Inner = createModuleComponent<Who>()

        let outerRef: PropsRef<Who> | null = null
        let innerRef: PropsRef<Who> | null = null
        let setOuter: ((who: string) => void) | null = null
        let setInner: ((who: string) => void) | null = null

        function OuterProbe() {
            outerRef = useResolve(PropsRef) as PropsRef<Who>
            return null
        }

        function InnerProbe() {
            innerRef = useResolve(PropsRef) as PropsRef<Who>
            return null
        }

        function Harness() {
            const [outer, setOuterState] = useState("outer")
            const [inner, setInnerState] = useState("inner")
            setOuter = setOuterState
            setInner = setInnerState
            return (
                <Root>
                    <Outer who={outer}>
                        <OuterProbe />
                        <Inner who={inner}>
                            <InnerProbe />
                        </Inner>
                    </Outer>
                </Root>
            )
        }

        render(<Harness />)

        const outerSeen: Who[] = []
        const innerSeen: Who[] = []
        outerRef!.onUpdate((next) => void outerSeen.push(next))
        innerRef!.onUpdate((next) => void innerSeen.push(next))

        act(() => setOuter?.("outer-2"))

        expect(outerSeen).toEqual([{ who: "outer-2" }])
        expect(innerSeen).toEqual([])
        expect(innerRef!.current).toEqual({ who: "inner" })

        act(() => setInner?.("inner-2"))

        expect(outerSeen).toEqual([{ who: "outer-2" }])
        expect(innerSeen).toEqual([{ who: "inner-2" }])
        expect(outerRef!.current).toEqual({ who: "outer-2" })
    })

    it("does not shadow across different tokens — a child on a custom token still sees the parent's", () => {
        const CHILD: InjectionToken<PropsRef<{ n: number }>> = Symbol.for("tests.props.torture.child-token")

        const Outer = createModuleComponent<Who>()
        const Inner = createModuleComponent<{ n: number }>(undefined, { token: CHILD })

        let byClass: PropsRef<Who> | null = null
        let byToken: PropsRef<{ n: number }> | null = null

        function Probe() {
            byClass = useResolve(PropsRef) as PropsRef<Who>
            byToken = useResolve(CHILD)
            return null
        }

        render(
            <Root>
                <Outer who="outer">
                    <Inner n={7}>
                        <Probe />
                    </Inner>
                </Outer>
            </Root>
        )

        expect(byClass!.current).toEqual({ who: "outer" })
        expect(byToken!.current).toEqual({ n: 7 })
    })
})
