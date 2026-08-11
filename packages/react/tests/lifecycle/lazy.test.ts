import { describe, expect, it, vi } from "vitest"

import { Container, Scope } from "@remodulo/container"
import { LAZY_METADATA_KEY, registerProviders } from "../../src/core/provider.js"
import type { Provider } from "../../src/core/provider.types.js"
import { makeApp, makeChild, phase, tracked } from "../setup/helpers.js"

// lazy providers.
// ========================================
//
// `lazy` skips the owner's eager pass: nothing is built until somebody resolves the token. Whoever
// resolves it, the instance joins the module that DECLARED it, and it CATCHES UP to that module's
// current status — `onModuleInit` always, and `onModuleMount` too when the declaring module is mounted.
// A late arrival is a participant like any other, so it ends up in the same state as the ones that were
// there from the start; which phases it caught up through is decided per participant, not per module.

describe("lazy", () => {
    it("is not built at init or at mount, and joins on first resolve", async () => {
        const log: string[] = []
        const service = tracked(log, "L")
        const module = makeApp({
            providers: [{ provide: service, useClass: service, lazy: true } as Provider],
        })

        expect(log).toEqual([])

        module.mount()
        expect(log).toEqual([])

        // The module is mounted, so the catch-up runs both phases in one go and the instance lands where
        // its eager siblings already are.
        module.container.resolve(service as never)
        expect(log).toEqual(["L:ctor", "L:init", "L:mount"])
        expect(service.counts.mount).toBe(1)

        module.unmount()
        expect(phase(log, "unmount")).toEqual(["L:unmount"])

        await module.destroy()
        expect(service.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
    })

    it("joins once however often it is resolved", async () => {
        const log: string[] = []
        const service = tracked(log, "L")
        const module = makeApp({
            providers: [{ provide: service, useClass: service, lazy: true } as Provider],
        })
        module.mount()

        const first = module.container.resolve(service as never)
        const second = module.container.resolve(service as never)
        expect(second).toBe(first)

        module.unmount()
        await module.destroy()

        expect(service.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
    })

    it("works for a lazy factory provider too", async () => {
        const log: string[] = []
        const TOKEN = Symbol("lazy-factory")
        const module = makeApp({
            providers: [
                {
                    provide: TOKEN,
                    lazy: true,
                    useFactory: () => {
                        log.push("F:ctor")
                        return {
                            onModuleInit: () => log.push("F:init"),
                            onModuleMount: () => log.push("F:mount"),
                            onModuleUnmount: () => log.push("F:unmount"),
                            onModuleDestroy: () => log.push("F:destroy"),
                        }
                    },
                },
            ],
        })
        module.mount()
        expect(log).toEqual([])

        module.container.resolve(TOKEN)
        expect(log).toEqual(["F:ctor", "F:init", "F:mount"])

        module.unmount()
        await module.destroy()
        expect(log).toEqual(["F:ctor", "F:init", "F:mount", "F:unmount", "F:destroy"])
    })

    it("stays out of the lifecycle entirely when it is also transient", async () => {
        const log: string[] = []
        const service = tracked(log, "T")
        const TOKEN = Symbol("lazy-transient")
        const module = makeApp({
            providers: [{ provide: TOKEN, useClass: service, scope: Scope.Transient, lazy: true } as Provider],
        })
        module.mount()
        module.container.resolve(TOKEN)

        module.unmount()
        await module.destroy()

        expect(service.counts).toEqual({ init: 0, mount: 0, unmount: 0, destroy: 0 })
        expect(log).toEqual(["T:ctor"])
    })

    it("joins the declaring module when a descendant resolves it", async () => {
        const log: string[] = []
        const service = tracked(log, "L")
        const parent = makeApp({
            providers: [{ provide: service, useClass: service, lazy: true } as Provider],
        })
        const child = makeChild(parent, { providers: [] })
        parent.mount()
        child.mount()

        // The catch-up reads the DECLARING module's status, not the resolver's: the parent is mounted.
        child.container.resolve(service as never)
        expect(log).toEqual(["L:ctor", "L:init", "L:mount"])

        // The resolver's own module tears down; the instance belongs to the declaring module and survives.
        child.unmount()
        await child.destroy()
        expect(service.counts).toEqual({ init: 1, mount: 1, unmount: 0, destroy: 0 })

        parent.unmount()
        await parent.destroy()
        expect(service.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
    })

    it("survives a grandchild's teardown too", async () => {
        const log: string[] = []
        const service = tracked(log, "L")
        const root = makeApp({
            providers: [{ provide: service, useClass: service, lazy: true } as Provider],
        })
        const middle = makeChild(root, { providers: [] })
        const leaf = makeChild(middle, { providers: [] })
        root.mount()
        middle.mount()
        leaf.mount()

        leaf.container.resolve(service as never)
        expect(service.counts.init).toBe(1)

        middle.unmount()
        await middle.destroy()
        expect(service.counts).toEqual({ init: 1, mount: 1, unmount: 0, destroy: 0 })

        root.unmount()
        await root.destroy()
        expect(service.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
    })

    it("still joins when resolved after the module unmounted", async () => {
        const log: string[] = []
        const service = tracked(log, "L")
        const module = makeApp({
            providers: [{ provide: service, useClass: service, lazy: true } as Provider],
        })
        module.mount()
        module.unmount()

        module.container.resolve(service as never)
        expect(log).toEqual(["L:ctor", "L:init"])

        await module.destroy()
        expect(service.counts).toEqual({ init: 1, mount: 0, unmount: 0, destroy: 1 })
    })

    // The gate is `destroyed` ALONE now. A module that is still draining adopts a late arrival and gives it
    // the short path — init, then the drain's own destroy — which is `rulings.test.ts` §13. This cell is the
    // other side of that line: once the drain has finished there is no phase left to pair an init with, so
    // the resolve builds the instance and the lifecycle never takes it on.
    it("refuses to build a lazy instance at all once the module is destroyed", async () => {
        const log: string[] = []
        const service = tracked(log, "L")
        const module = makeApp({
            providers: [{ provide: service, useClass: service, lazy: true } as Provider],
        })
        module.mount()
        module.unmount()
        await module.destroy()

        // FLIPPED when `destroyed` joined the resolution gate's refuse-set. The cell used to pin the
        // half-measure: the kernel BUILT the instance and `#appendParticipant` then refused to adopt it, so
        // it arrived bare — constructed, un-inited, and owed a destroy that had already run. The gate now
        // refuses at the ASK, one step earlier, so the orphan is never constructed in the first place.
        //
        // `#appendParticipant`'s corpse gate still stands behind this; it is simply no longer the only
        // thing standing between a drained module and a stranded instance.
        expect(() => module.container.resolve(service as never)).toThrow(
            /Cannot resolve Service from a module whose status is "destroyed"/
        )
        expect(log).toEqual([])
        expect(service.counts).toEqual({ init: 0, mount: 0, unmount: 0, destroy: 0 })
    })

    it("behaves identically declared as `{ useClass: X, lazy: true }`", async () => {
        const log: string[] = []
        const service = tracked(log, "L")
        const module = makeApp({ providers: [{ useClass: service, lazy: true } as Provider] })

        expect(log).toEqual([])

        module.mount()
        expect(log).toEqual([])

        module.container.resolve(service as never)
        expect(log).toEqual(["L:ctor", "L:init", "L:mount"])
        expect(service.counts.mount).toBe(1)

        module.unmount()
        expect(phase(log, "unmount")).toEqual(["L:unmount"])

        await module.destroy()
        expect(service.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
    })

    it("stays out of the lifecycle when `{ useClass: X }` is also transient", async () => {
        const log: string[] = []
        const service = tracked(log, "T")
        const module = makeApp({ providers: [{ useClass: service, scope: Scope.Transient, lazy: true } as Provider] })
        module.mount()
        module.container.resolve(service as never)

        module.unmount()
        await module.destroy()

        expect(service.counts).toEqual({ init: 0, mount: 0, unmount: 0, destroy: 0 })
        expect(log).toEqual(["T:ctor"])
    })

    it("does not delay an eager sibling", () => {
        const log: string[] = []
        const eager = tracked(log, "E")
        const lazy = tracked(log, "L")
        makeApp({
            providers: [{ provide: lazy, useClass: lazy, lazy: true } as Provider, eager],
        })

        expect(log).toEqual(["E:ctor", "E:init"])
    })
})

// The metadata channel `lazy` travels on.
// ========================================
//
// `lazy` is react's one key, and the kernel's metadata bag is where it lands. The bag is not react's to
// own, though: a provider may declare metadata of its own, and it survives the translation. React wins a
// collision on exactly one name — the one it wrote.

describe("lazy metadata", () => {
    const TOKEN = Symbol.for("tests.lazy.metadata")

    function metadataOf(provider: Provider) {
        const container = new Container()
        registerProviders(container, [provider])

        return container.entry(TOKEN)?.metadata
    }

    it("merges react's key into the bag the provider declared", () => {
        expect(
            metadataOf({ provide: TOKEN, useFactory: () => 1, lazy: true, metadata: { tag: "a", tier: 2 } })
        ).toEqual({ tag: "a", tier: 2, [LAZY_METADATA_KEY]: true })
    })

    it("wins its own name on a collision, and leaves every other declared key standing", () => {
        expect(
            metadataOf({
                provide: TOKEN,
                useFactory: () => 1,
                lazy: true,
                metadata: { [LAZY_METADATA_KEY]: false, tag: "a" },
            })
        ).toEqual({ [LAZY_METADATA_KEY]: true, tag: "a" })
    })

    it("passes a declared bag through untouched when there is no `lazy` to fold in", () => {
        expect(metadataOf({ provide: TOKEN, useFactory: () => 1, metadata: { tag: "a" } })).toEqual({ tag: "a" })
    })

    it("registers no bag at all when the provider declares neither key", () => {
        expect(metadataOf({ provide: TOKEN, useFactory: () => 1 })).toBeUndefined()
    })

    it("hands the kernel the very same provider object when neither key needs translating", () => {
        const provider: Provider = { provide: TOKEN, useFactory: () => 1, metadata: { tag: "a" } }
        const container = new Container()
        const register = vi.spyOn(container, "register")

        registerProviders(container, [provider])

        expect(register).toHaveBeenCalledTimes(1)
        expect(register.mock.calls[0]?.[0]).toBe(provider)
    })

    it("still defers the eager pass when the declared bag rides along", () => {
        const log: string[] = []
        const service = tracked(log, "L")
        const module = makeApp({
            providers: [{ provide: service, useClass: service, lazy: true, metadata: { tag: "a" } } as Provider],
        })

        expect(log).toEqual([])

        module.container.resolve(service as never)
        expect(log).toEqual(["L:ctor", "L:init"])
    })
})
