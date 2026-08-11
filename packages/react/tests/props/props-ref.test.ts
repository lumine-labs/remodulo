import { describe, expect, it, vi } from "vitest"

import { PropsRef, type PropsAdapter } from "../../src/primitives/props-ref.js"

// `PropsRef` on its own — no React, no container. Everything the hook and `createModuleComponent` rely on is
// decided here: what `current` returns, when subscribers fire, and what an update that changes nothing
// is allowed to do.

type Data = { label: string; count: number }
type Boxed = { boxed: Data }

function makeAdapter(): PropsAdapter<Data, Boxed> {
    return {
        create: vi.fn((initial: Data) => ({ boxed: initial })),
        update: vi.fn(({ current, next }: { current: Boxed; next: Data }) => {
            current.boxed = next
            return current
        }),
    }
}

// current
// ========================================

describe("PropsRef.current", () => {
    it("is the props object itself under the default adapter", () => {
        const props: Data = { label: "a", count: 1 }
        const ref = new PropsRef<Data>({ props })

        expect(ref.current).toBe(props)
    })

    it("is replaced by the next props object on a real update", () => {
        const first: Data = { label: "a", count: 1 }
        const second: Data = { label: "b", count: 2 }
        const ref = new PropsRef<Data>({ props: first })

        ref.update(second)

        expect(ref.current).toBe(second)
    })

    it("is the adapter's output, created once from the initial props", () => {
        const adapter = makeAdapter()
        const props: Data = { label: "a", count: 1 }
        const ref = new PropsRef<Boxed>({ props, adapter })

        expect(adapter.create).toHaveBeenCalledTimes(1)
        expect(adapter.create).toHaveBeenCalledWith(props)
        expect(ref.current).toEqual({ boxed: props })
        expect(ref.current).toBe(vi.mocked(adapter.create).mock.results[0]!.value)
    })

    it("keeps the adapter's target identity across updates", () => {
        const adapter = makeAdapter()
        const ref = new PropsRef<Boxed>({ props: { label: "a", count: 1 }, adapter })
        const target = ref.current

        const next: Data = { label: "b", count: 2 }
        ref.update(next)

        expect(adapter.update).toHaveBeenCalledTimes(1)
        expect(adapter.update).toHaveBeenCalledWith({ current: target, next })
        expect(ref.current).toBe(target)
        expect(ref.current.boxed).toBe(next)
    })
})

// update with nothing changed
// ========================================

describe("PropsRef.update with no change", () => {
    it("keeps the original props object when handed a shallow-equal copy", () => {
        const first: Data = { label: "a", count: 1 }
        const ref = new PropsRef<Data>({ props: first })
        const seen: Array<[Data, Data]> = []
        ref.onUpdate((next, prev) => void seen.push([next, prev]))

        ref.update({ label: "a", count: 1 })

        expect(seen).toEqual([])
        expect(ref.current).toBe(first)
    })

    it("does nothing when handed the very same object", () => {
        const props: Data = { label: "a", count: 1 }
        const ref = new PropsRef<Data>({ props })
        const subscriber = vi.fn()
        ref.onUpdate(subscriber)

        ref.update(props)

        expect(subscriber).not.toHaveBeenCalled()
        expect(ref.current).toBe(props)
    })

    it("never asks the adapter to update on a shallow-equal copy", () => {
        const adapter = makeAdapter()
        const ref = new PropsRef<Boxed>({ props: { label: "a", count: 1 }, adapter })

        ref.update({ label: "a", count: 1 })

        expect(adapter.update).not.toHaveBeenCalled()
        expect(adapter.create).toHaveBeenCalledTimes(1)
    })

    it("fires when a single key changes and stays quiet when the value is re-set to itself", () => {
        const ref = new PropsRef<Data>({ props: { label: "a", count: 1 } })
        const subscriber = vi.fn()
        ref.onUpdate(subscriber)

        ref.update({ label: "a", count: 2 })
        expect(subscriber).toHaveBeenCalledTimes(1)

        ref.update({ label: "a", count: 2 })
        expect(subscriber).toHaveBeenCalledTimes(1)
    })
})

// onUpdate
// ========================================

describe("PropsRef.onUpdate", () => {
    it("delivers exactly (next, prev) by identity", () => {
        const first: Data = { label: "a", count: 1 }
        const second: Data = { label: "b", count: 2 }
        const ref = new PropsRef<Data>({ props: first })

        const calls: Array<[Data, Data]> = []
        ref.onUpdate((next, prev) => void calls.push([next, prev]))

        ref.update(second)

        expect(calls).toHaveLength(1)
        expect(calls[0]![0]).toBe(second)
        expect(calls[0]![1]).toBe(first)
    })

    it("does not fire at subscription time without { immediate: true }", () => {
        const ref = new PropsRef<Data>({ props: { label: "a", count: 1 } })
        const subscriber = vi.fn()

        ref.onUpdate(subscriber)

        expect(subscriber).not.toHaveBeenCalled()
    })

    it("with { immediate: true } fires synchronously with (current, current)", () => {
        const props: Data = { label: "a", count: 1 }
        const ref = new PropsRef<Data>({ props })
        const subscriber = vi.fn()

        ref.onUpdate(subscriber, { immediate: true })

        expect(subscriber).toHaveBeenCalledTimes(1)
        expect(subscriber.mock.calls[0]![0]).toBe(props)
        expect(subscriber.mock.calls[0]![1]).toBe(props)
    })

    it("with { immediate: false } behaves like no options at all", () => {
        const ref = new PropsRef<Data>({ props: { label: "a", count: 1 } })
        const subscriber = vi.fn()

        ref.onUpdate(subscriber, { immediate: false })

        expect(subscriber).not.toHaveBeenCalled()
    })

    it("hands the immediate call the adapter's target, not the raw props", () => {
        const adapter = makeAdapter()
        const props: Data = { label: "a", count: 1 }
        const ref = new PropsRef<Boxed>({ props, adapter })
        const subscriber = vi.fn()

        ref.onUpdate(subscriber, { immediate: true })

        expect(subscriber).toHaveBeenCalledTimes(1)
        expect(subscriber.mock.calls[0]![0]).toBe(ref.current)
        expect(subscriber.mock.calls[0]![0]).not.toBe(props)
    })

    it("notifies every subscriber, in subscription order", () => {
        const ref = new PropsRef<Data>({ props: { label: "a", count: 1 } })
        const order: string[] = []
        ref.onUpdate(() => void order.push("first"))
        ref.onUpdate(() => void order.push("second"))
        ref.onUpdate(() => void order.push("third"))

        ref.update({ label: "b", count: 2 })

        expect(order).toEqual(["first", "second", "third"])
    })

    it("keeps serving the other subscribers when one throws, and reports it once", () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
        const ref = new PropsRef<Data>({ props: { label: "a", count: 1 } })
        const after = vi.fn()

        ref.onUpdate(() => {
            throw new Error("boom")
        })
        ref.onUpdate(after)

        const next: Data = { label: "b", count: 2 }
        ref.update(next)

        expect(after).toHaveBeenCalledTimes(1)
        expect(after).toHaveBeenCalledWith(next, { label: "a", count: 1 })
        expect(errorSpy).toHaveBeenCalledTimes(1)
        expect(errorSpy.mock.calls[0]![0]).toBe("PropsRef.onUpdate: subscriber threw")
        errorSpy.mockRestore()
    })

    it("catches a throwing immediate subscriber too", () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
        const ref = new PropsRef<Data>({ props: { label: "a", count: 1 } })

        expect(() =>
            ref.onUpdate(
                () => {
                    throw new Error("boom")
                },
                { immediate: true }
            )
        ).not.toThrow()
        expect(errorSpy).toHaveBeenCalledTimes(1)
        errorSpy.mockRestore()
    })
})

// unsubscribe
// ========================================

describe("PropsRef.onUpdate unsubscribe", () => {
    it("stops delivery from the next update on, and only for that subscriber", () => {
        const ref = new PropsRef<Data>({ props: { label: "a", count: 1 } })
        const kept = vi.fn()
        const dropped = vi.fn()

        ref.onUpdate(kept)
        const off = ref.onUpdate(dropped)

        ref.update({ label: "b", count: 2 })
        expect(kept).toHaveBeenCalledTimes(1)
        expect(dropped).toHaveBeenCalledTimes(1)

        off()

        ref.update({ label: "c", count: 3 })
        expect(kept).toHaveBeenCalledTimes(2)
        expect(dropped).toHaveBeenCalledTimes(1)
    })

    it("is idempotent", () => {
        const ref = new PropsRef<Data>({ props: { label: "a", count: 1 } })
        const subscriber = vi.fn()
        const off = ref.onUpdate(subscriber)

        off()
        off()

        ref.update({ label: "b", count: 2 })
        expect(subscriber).not.toHaveBeenCalled()
    })

    it("lets a subscriber unsubscribe itself from inside a notification without skipping the rest", () => {
        const ref = new PropsRef<Data>({ props: { label: "a", count: 1 } })
        const later = vi.fn()

        const off = ref.onUpdate(() => off())
        ref.onUpdate(later)

        ref.update({ label: "b", count: 2 })
        expect(later).toHaveBeenCalledTimes(1)

        ref.update({ label: "c", count: 3 })
        expect(later).toHaveBeenCalledTimes(2)
    })

    it("re-subscribing the same function after unsubscribing restores delivery once", () => {
        const ref = new PropsRef<Data>({ props: { label: "a", count: 1 } })
        const subscriber = vi.fn()

        const off = ref.onUpdate(subscriber)
        off()
        ref.onUpdate(subscriber)

        ref.update({ label: "b", count: 2 })
        expect(subscriber).toHaveBeenCalledTimes(1)
    })
})
