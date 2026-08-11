import { describe, expect, it } from "vitest"

import { Scope, injectAll } from "@remodulo/container"
import type { Provider } from "../../src/core/provider.types.js"
import { makeApp, makeChild, phase, refuses, tracked } from "../setup/helpers.js"

// Lifecycle of a multi-provider collection.
// ========================================
//
// A collection is built whole: one `resolveAll` in the owner's eager pass, over that module's OWN
// contributions. Everything the single-provider case guarantees carries over per member — construction
// order is declaration order, adoption follows the binding (so it stays with the module that declared it),
// and destroy runs in reverse.

const PLUGINS = Symbol("PLUGINS")

const member = (service: Provider, options: { lazy?: true } = {}): Provider =>
    ({ provide: PLUGINS, useClass: service, multi: true, ...options }) as Provider

/** The same four hooks on a plain object — what a `useValue` member contributes. */
const valueMember = (log: string[]): object => ({
    onModuleInit: () => log.push("V:init"),
    onModuleMount: () => log.push("V:mount"),
    onModuleUnmount: () => log.push("V:unmount"),
    onModuleDestroy: () => log.push("V:destroy"),
})

describe("eager collection", () => {
    it("constructs every member in declaration order and adopts them all", () => {
        const log: string[] = []
        const module = makeApp({
            providers: [member(tracked(log, "A")), member(tracked(log, "B")), member(tracked(log, "C"))],
        })

        expect(log).toEqual(["A:ctor", "B:ctor", "C:ctor", "A:init", "B:init", "C:init"])
        expect(module.container.resolveAll(PLUGINS)).toHaveLength(3)
    })

    it("collection order IS construction order, and destroy reverses it", async () => {
        const log: string[] = []
        const module = makeApp({
            providers: [member(tracked(log, "A")), member(tracked(log, "B")), member(tracked(log, "C"))],
        })

        module.mount()
        expect(phase(log, "mount")).toEqual(["A:mount", "B:mount", "C:mount"])

        module.unmount()
        expect(phase(log, "unmount")).toEqual(["C:unmount", "B:unmount", "A:unmount"])

        await module.destroy()
        expect(phase(log, "destroy")).toEqual(["C:destroy", "B:destroy", "A:destroy"])
    })

    it("builds each member exactly once however often the collection is read", async () => {
        const log: string[] = []
        const a = tracked(log, "A")
        const b = tracked(log, "B")
        const module = makeApp({ providers: [member(a), member(b)] })

        const first = module.container.resolveAll(PLUGINS)
        const second = module.container.resolveAll(PLUGINS)
        expect(second).toEqual(first)

        module.mount()
        module.unmount()
        await module.destroy()

        expect(a.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
        expect(b.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
    })

    it("interleaves with single registrations in declaration order", () => {
        const log: string[] = []
        makeApp({
            providers: [tracked(log, "S1"), member(tracked(log, "M1")), member(tracked(log, "M2")), tracked(log, "S2")],
        })

        expect(phase(log, "init")).toEqual(["S1:init", "M1:init", "M2:init", "S2:init"])
    })
})

describe("lazy collection", () => {
    it("is not built at init or mount, and joins whole on the first resolveAll", async () => {
        const log: string[] = []
        const a = tracked(log, "A")
        const b = tracked(log, "B")
        const module = makeApp({ providers: [member(a, { lazy: true }), member(b, { lazy: true })] })

        expect(log).toEqual([])

        module.mount()
        expect(log).toEqual([])

        module.container.resolveAll(PLUGINS)

        // Each member catches up as it is constructed, and the module is mounted, so each one runs init and
        // mount before the next member is built — adoption is per participant, not per collection.
        expect(log).toEqual(["A:ctor", "A:init", "A:mount", "B:ctor", "B:init", "B:mount"])
        expect(a.counts.mount).toBe(1)
        expect(b.counts.mount).toBe(1)

        module.unmount()
        expect(phase(log, "unmount")).toEqual(["B:unmount", "A:unmount"])

        await module.destroy()
        expect(a.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
        expect(b.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
    })

    it("joins once, however often the collection is read", async () => {
        const log: string[] = []
        const a = tracked(log, "A")
        const module = makeApp({ providers: [member(a, { lazy: true })] })
        module.mount()

        module.container.resolveAll(PLUGINS)
        module.container.resolveAll(PLUGINS)

        module.unmount()
        await module.destroy()

        expect(a.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
    })

    it("refuses a collection whose constructing members disagree about lazy", () => {
        const log: string[] = []
        const providers = [member(tracked(log, "A")), member(tracked(log, "B"), { lazy: true })]

        expect(() => makeApp({ providers })).toThrow(
            "Provider for PLUGINS declares `lazy: true` while the collection already registered for that token is `lazy: false`."
        )
    })

    // The contradiction this cell used to pin, and the fix that closed it. `#collectParticipants` decides
    // eagerness per ENTRY, and a value entry is an ordinary singleton entry — so a non-lazy value member
    // DRAGGED the whole token into the eager pass and the `lazy: true` beside it was overruled without a
    // word. The ledger used to exempt value members from the agreement ("it builds nothing"), which is what
    // let the pair register at all. It no longer does: a value member settles the collection's laziness
    // alongside the constructing ones, and the mix is refused at the door like every other disagreement.
    it("refuses a lazy collection with a non-lazy value member alongside", () => {
        const log: string[] = []
        const lazyClass = tracked(log, "A")
        const value = valueMember(log)

        expect(() =>
            makeApp({
                providers: [member(lazyClass, { lazy: true }), { provide: PLUGINS, useValue: value, multi: true }],
            })
        ).toThrow(
            "Provider for PLUGINS declares `lazy: false` while the collection already registered for that token is `lazy: true`."
        )

        expect(log).toEqual([])
    })

    it("refuses it from the other side too — an eager collection joined by a lazy value member", () => {
        const log: string[] = []

        expect(() =>
            makeApp({
                providers: [
                    member(tracked(log, "A")),
                    { provide: PLUGINS, useValue: valueMember(log), multi: true, lazy: true },
                ],
            })
        ).toThrow(
            "Provider for PLUGINS declares `lazy: true` while the collection already registered for that token is `lazy: false`."
        )
    })

    it("takes a value member that agrees, and defers its adoption with the rest", async () => {
        const log: string[] = []
        const lazyClass = tracked(log, "A")
        const value = valueMember(log)

        const module = makeApp({
            providers: [
                member(lazyClass, { lazy: true }),
                { provide: PLUGINS, useValue: value, multi: true, lazy: true },
            ],
        })

        // Nothing at init and nothing at mount: `lazy` on a value defers the MATERIALIZATION that adopts
        // it, which is the only thing a value ever had to defer.
        expect(log).toEqual([])
        module.mount()
        expect(log).toEqual([])

        const all = module.container.resolveAll(PLUGINS)
        expect(all).toHaveLength(2)
        expect(all[1]).toBe(value)

        // Each member catches up as it is materialized, and the module is mounted, so both run init and
        // mount in collection order.
        expect(log).toEqual(["A:ctor", "A:init", "A:mount", "V:init", "V:mount"])

        module.unmount()
        expect(phase(log, "unmount")).toEqual(["V:unmount", "A:unmount"])

        await module.destroy()
        expect(phase(log, "destroy")).toEqual(["V:destroy", "A:destroy"])
        expect(lazyClass.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
    })

    it("stays lazy with an alias member alongside, whose target keeps its own timing", async () => {
        const log: string[] = []
        const lazyClass = tracked(log, "A")
        const target = tracked(log, "T")

        const module = makeApp({
            providers: [
                target,
                member(lazyClass, { lazy: true }),
                // `lazy` on the alias, matching the member beside it: an alias reconciles with the
                // collection like every other form now, and a plain one here would be refused.
                { provide: PLUGINS, useExisting: target, multi: true, lazy: true } as Provider,
            ],
        })

        // The target is a single registration of its own and builds eagerly; only the collection waits.
        expect(log).toEqual(["T:ctor", "T:init"])

        module.mount()
        expect(phase(log, "mount")).toEqual(["T:mount"])

        const all = module.container.resolveAll(PLUGINS)
        expect(all).toHaveLength(2)
        expect(all[1]).toBe(module.container.resolve(target as never))
        expect(log).toContain("A:ctor")

        module.unmount()
        await module.destroy()

        // The target was adopted once, through its OWN registration — the alias member added no second claim.
        expect(target.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
        // An alias member binds nothing, so the collection stays lazy and the class catches up on first read.
        expect(lazyClass.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
    })
})

describe("alias members", () => {
    it("contribute the target's instance, and no adoption of their own", async () => {
        const log: string[] = []
        const legacy = tracked(log, "Legacy")
        const direct = tracked(log, "Direct")

        const module = makeApp({
            providers: [legacy, member(direct), { provide: PLUGINS, useExisting: legacy, multi: true } as Provider],
        })

        const all = module.container.resolveAll(PLUGINS)
        expect(all).toHaveLength(2)
        expect(all[1]).toBe(module.container.resolve(legacy as never))

        module.mount()
        module.unmount()
        await module.destroy()

        // Adopted once, by the module that registered the TARGET — the alias adds a collection entry, not
        // a lifecycle participant.
        expect(legacy.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
        expect(direct.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
    })

    it("leave adoption with the target's owner when the target lives up the chain", async () => {
        const log: string[] = []
        const legacy = tracked(log, "Legacy")
        const direct = tracked(log, "Direct")

        const parent = makeApp({ providers: [legacy] })
        const child = makeChild(parent, {
            providers: [member(direct), { provide: PLUGINS, useExisting: legacy, multi: true } as Provider],
        })

        expect(child.container.resolveAll(PLUGINS)).toHaveLength(2)

        child.mount()
        parent.mount()
        parent.unmount()
        await child.destroy()

        // The child never adopted the parent's instance: destroying the child leaves it fully alive.
        expect(legacy.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 0 })
        expect(direct.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })

        await parent.destroy()
        expect(legacy.counts.destroy).toBe(1)
    })
})

describe("transient members", () => {
    it("are never adopted, even sharing a token with a member that is", async () => {
        const log: string[] = []
        const transient = tracked(log, "T")
        const value = {
            onModuleInit: () => log.push("V:init"),
            onModuleMount: () => log.push("V:mount"),
            onModuleUnmount: () => log.push("V:unmount"),
            onModuleDestroy: () => log.push("V:destroy"),
        }

        const module = makeApp({
            providers: [
                { provide: PLUGINS, useValue: value, multi: true },
                { provide: PLUGINS, useClass: transient, multi: true, scope: Scope.Transient } as Provider,
            ],
        })
        module.mount()

        // Read the collection repeatedly: each read builds a fresh transient, and none of them is kept.
        // If they were adopted, the module's instance set would grow by one per call and every phase below
        // would fire that many times.
        module.container.resolveAll(PLUGINS)
        module.container.resolveAll(PLUGINS)
        module.container.resolveAll(PLUGINS)

        module.unmount()
        await module.destroy()

        expect(transient.counts).toEqual({ init: 0, mount: 0, unmount: 0, destroy: 0 })
        expect(phase(log, "init")).toEqual(["V:init"])
        expect(phase(log, "mount")).toEqual(["V:mount"])
        expect(phase(log, "unmount")).toEqual(["V:unmount"])
        expect(phase(log, "destroy")).toEqual(["V:destroy"])

        // Four constructions in total — one for the eager pass, three for the reads — every one discarded.
        expect(log.filter((entry) => entry === "T:ctor")).toHaveLength(4)
    })

    it("behave exactly as a standalone transient provider does", async () => {
        const log: string[] = []
        const alone = tracked(log, "A")
        const inCollection = tracked(log, "C")

        const module = makeApp({
            providers: [
                { provide: Symbol("SOLO"), useClass: alone, scope: Scope.Transient } as Provider,
                { provide: PLUGINS, useValue: { keep: true }, multi: true },
                { provide: PLUGINS, useClass: inCollection, multi: true, scope: Scope.Transient } as Provider,
            ],
        })
        module.mount()
        module.container.resolveAll(PLUGINS)

        module.unmount()
        await module.destroy()

        expect(inCollection.counts).toEqual(alone.counts)
        expect(inCollection.counts).toEqual({ init: 0, mount: 0, unmount: 0, destroy: 0 })
    })

    it("sit beside an adopted SINGLETON member without being adopted themselves", async () => {
        const log: string[] = []
        const singleton = tracked(log, "S")
        const transient = tracked(log, "T")

        const module = makeApp({
            providers: [
                member(singleton),
                { provide: PLUGINS, useClass: transient, multi: true, scope: Scope.Transient } as Provider,
            ],
        })
        module.mount()

        // Two class members disagreeing about scope is legal: scope belongs to the binding, and adoption is
        // filtered per binding, so the singleton is kept and the transient is not.
        const first = module.container.resolveAll(PLUGINS)
        const second = module.container.resolveAll(PLUGINS)
        const third = module.container.resolveAll(PLUGINS)

        expect(first[0]).toBe(second[0])
        expect(first[0]).toBe(third[0])
        expect(first[1]).not.toBe(second[1])
        expect(second[1]).not.toBe(third[1])

        module.unmount()
        await module.destroy()

        expect(singleton.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
        expect(transient.counts).toEqual({ init: 0, mount: 0, unmount: 0, destroy: 0 })

        // The module's instance set is flat across the reads: one construction in the eager pass plus one
        // per read, every transient one discarded. The singleton was built exactly once.
        expect(log.filter((entry) => entry === "T:ctor")).toHaveLength(4)
        expect(log.filter((entry) => entry === "S:ctor")).toHaveLength(1)
        expect(phase(log, "init")).toEqual(["S:init"])
        expect(phase(log, "unmount")).toEqual(["S:unmount"])
        expect(phase(log, "destroy")).toEqual(["S:destroy"])
    })

    it("keep an all-transient collection out of the eager pass, as before", async () => {
        const log: string[] = []
        const first = tracked(log, "A")
        const second = tracked(log, "B")

        const module = makeApp({
            providers: [
                { provide: PLUGINS, useClass: first, multi: true, scope: Scope.Transient } as Provider,
                { provide: PLUGINS, useClass: second, multi: true, scope: Scope.Transient } as Provider,
            ],
        })

        expect(log).toEqual([])

        module.mount()
        module.container.resolveAll(PLUGINS)
        expect(log).toEqual(["A:ctor", "B:ctor"])

        module.unmount()
        await module.destroy()

        expect(first.counts).toEqual({ init: 0, mount: 0, unmount: 0, destroy: 0 })
        expect(second.counts).toEqual({ init: 0, mount: 0, unmount: 0, destroy: 0 })
    })
})

describe("members a factory injected", () => {
    // A factory reaching a collection through `injectAll()` in its body performs the same `resolveAll` the
    // module's eager pass performs. Adoption follows the BINDING, not the caller, so who triggered the
    // construction changes nothing: singletons are adopted once, transients never.

    const HOST = Symbol("HOST")

    const host = (): Provider =>
        ({
            provide: HOST,
            useFactory: () => ({ plugins: injectAll(PLUGINS) }),
        }) as Provider

    it("adopts the members the factory itself caused to be constructed", async () => {
        const log: string[] = []
        const plugin = tracked(log, "P")

        // The collection is lazy, so the eager pass skips it entirely — the factory's read is the only
        // thing that builds it, and the member is still adopted by the module that declared it.
        const module = makeApp({ providers: [member(plugin, { lazy: true }), host()] })

        expect(log).toEqual(["P:ctor", "P:init"])
        expect((module.container.resolve(HOST) as { plugins: unknown[] }).plugins).toHaveLength(1)

        module.mount()
        module.unmount()
        await module.destroy()

        expect(plugin.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
    })

    it("adopts a singleton member once and a transient member never", async () => {
        const log: string[] = []
        const singleton = tracked(log, "S")
        const transient = tracked(log, "T")

        const module = makeApp({
            providers: [
                member(singleton),
                { provide: PLUGINS, useClass: transient, multi: true, scope: Scope.Transient } as Provider,
                host(),
            ],
        })
        module.mount()

        const received = (module.container.resolve(HOST) as { plugins: unknown[] }).plugins
        expect(received).toHaveLength(2)

        // The singleton the factory got IS the module's, read twice — once by the eager pass, once by the
        // factory — and adopted once. The transient beside it was built afresh for the factory and dropped.
        expect(received[0]).toBe(module.container.resolveAll(PLUGINS)[0])

        module.unmount()
        await module.destroy()

        expect(singleton.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
        expect(transient.counts).toEqual({ init: 0, mount: 0, unmount: 0, destroy: 0 })
        expect(log.filter((entry) => entry === "S:ctor")).toHaveLength(1)
    })
})

describe("adoption across the chain", () => {
    it("gives every contribution to the module that declared it", async () => {
        const log: string[] = []
        const rootPlugin = tracked(log, "R")
        const midPlugin = tracked(log, "M")
        const leafPlugin = tracked(log, "L")

        const root = makeApp({ providers: [member(rootPlugin)] })
        const mid = makeChild(root, { providers: [member(midPlugin)] })
        const leaf = makeChild(mid, { providers: [member(leafPlugin)] })

        expect(phase(log, "init")).toEqual(["R:init", "M:init", "L:init"])
        expect(leaf.container.resolveAll(PLUGINS)).toHaveLength(3)

        leaf.mount()
        mid.mount()
        root.mount()
        expect(phase(log, "mount")).toEqual(["R:mount", "M:mount", "L:mount"])

        // Destroying the leaf takes its own contribution and nothing else. destroy() accepts `unmounted`,
        // not `mounted`, so the leaf retires itself first — which touches nothing above it.
        leaf.unmount()
        await leaf.destroy()
        expect(leafPlugin.counts.destroy).toBe(1)
        expect(midPlugin.counts.destroy).toBe(0)
        expect(rootPlugin.counts.destroy).toBe(0)

        expect(mid.container.resolveAll(PLUGINS)).toHaveLength(2)
    })

    it("never eagerly constructs an ancestor's members — no own member for the token", async () => {
        // `resolveAll(token, "nearest")` follows inversify: with no bindings of its own it reads the
        // nearest contributing ancestor. Own-only is REQUIRED here, which is why the eager pass asks for
        // `"self"` — the one mode that subtracts that fallback. Lazy ancestors make the violation
        // observable: a `"nearest"` pass would construct them from the child.
        const log: string[] = []
        const ancestor = tracked(log, "A")

        const root = makeApp({ providers: [member(ancestor, { lazy: true })] })
        expect(log).toEqual([])

        makeChild(root, { providers: [tracked(log, "C")] })

        expect(log).toEqual(["C:ctor", "C:init"])
        expect(ancestor.counts).toEqual({ init: 0, mount: 0, unmount: 0, destroy: 0 })
    })

    it("never eagerly constructs an ancestor's members — alias-only contribution for the token", async () => {
        const log: string[] = []
        const ancestor = tracked(log, "A")
        const local = tracked(log, "L")

        const root = makeApp({ providers: [member(ancestor, { lazy: true })] })
        log.length = 0

        // The child's only entry for PLUGINS is an alias, so its group binds nothing of its own — the group
        // is skipped before the guard is even consulted.
        const child = makeChild(root, {
            providers: [local, { provide: PLUGINS, useExisting: local, multi: true } as Provider],
        })

        expect(log).toEqual(["L:ctor", "L:init"])
        expect(ancestor.counts).toEqual({ init: 0, mount: 0, unmount: 0, destroy: 0 })

        // And the collection still reads correctly once somebody asks for it.
        expect(child.container.resolveAll(PLUGINS)).toHaveLength(2)
        expect(ancestor.counts.init).toBe(1)
    })

    it("does not eagerly rebuild an ancestor's contributions", () => {
        const log: string[] = []
        const root = makeApp({ providers: [member(tracked(log, "R"))] })
        log.length = 0

        makeChild(root, { providers: [member(tracked(log, "C"))] })

        // The child's eager pass is own-container only: nothing of the parent's is touched again.
        expect(log).toEqual(["C:ctor", "C:init"])
    })
})
