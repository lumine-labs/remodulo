import { describe, expect, it } from "vitest"

import { Scope } from "@remodulo/container"
import type { Provider } from "../../src/core/provider.types.js"
import type { HookCounts } from "../setup/helpers.js"
import { makeApp, makeChild, phase, plain, refuses, tracked } from "../setup/helpers.js"

// Who takes part in the lifecycle.
// ========================================
//
// One participant per constructed singleton instance of a provider this module declares. Transients are
// out by construction, aliases add no participant of their own, and the set is keyed by instance — the
// same object under two tokens is one participant.

const NOTHING: HookCounts = { init: 0, mount: 0, unmount: 0, destroy: 0 }
const ONCE: HookCounts = { init: 1, mount: 1, unmount: 1, destroy: 1 }

describe("participation", () => {
    it("never hands a hook to a transient, however often it is resolved", async () => {
        const log: string[] = []
        const service = tracked(log, "T")
        const TOKEN = Symbol("transient")
        const module = makeApp({
            providers: [{ provide: TOKEN, useClass: service, scope: Scope.Transient } as Provider],
        })

        module.mount()
        module.container.resolve(TOKEN)
        module.container.resolve(TOKEN)
        module.unmount()
        await module.destroy()

        expect(service.counts).toEqual(NOTHING)
        expect(phase(log, "ctor")).toEqual(["T:ctor", "T:ctor"])
    })

    it("does not build a transient eagerly at init", () => {
        const log: string[] = []
        const service = tracked(log, "T")
        const TOKEN = Symbol("transient-eager")
        makeApp({
            providers: [{ provide: TOKEN, useClass: service, scope: Scope.Transient } as Provider],
        })

        expect(log).toEqual([])
    })

    it("does not build a request-scoped provider eagerly at init, in any form", () => {
        const log: string[] = []
        const service = tracked(log, "R")
        const member = tracked(log, "M")
        const shorthand = tracked(log, "S")
        const TOKEN = Symbol("request-eager")
        const FACTORY = Symbol("request-factory")
        const PLUGINS = Symbol("request-plugins")

        makeApp({
            providers: [
                { provide: TOKEN, useClass: service, scope: Scope.Request } as Provider,
                {
                    provide: FACTORY,
                    useFactory: () => {
                        log.push("F:ctor")
                        return {}
                    },
                    scope: Scope.Request,
                } as Provider,
                { provide: PLUGINS, useClass: member, multi: true, scope: Scope.Request } as Provider,
                { useClass: shorthand, scope: Scope.Request } as Provider,
            ],
        })

        expect(log).toEqual([])
    })

    it("does not double-count a target that also has an alias", async () => {
        const log: string[] = []
        const service = tracked(log, "A")
        const ALIAS = Symbol("alias")
        const module = makeApp({
            providers: [service, { provide: ALIAS, useExisting: service } as Provider],
        })

        module.mount()
        module.container.resolve(ALIAS)
        module.container.resolve(ALIAS)
        module.unmount()
        await module.destroy()

        expect(service.counts).toEqual(ONCE)
        expect(log).toEqual(["A:ctor", "A:init", "A:mount", "A:unmount", "A:destroy"])
    })

    it("gives the provide-less useClass shorthand the same four phases as the bare constructor", async () => {
        const log: string[] = []
        const service = tracked(log, "S")
        const module = makeApp({ providers: [{ useClass: service } as Provider] })

        module.mount()
        module.unmount()
        await module.destroy()

        expect(service.counts).toEqual(ONCE)
        expect(log).toEqual(["S:ctor", "S:init", "S:mount", "S:unmount", "S:destroy"])
    })

    it("never adopts a transient declared through the provide-less useClass shorthand", async () => {
        const log: string[] = []
        const service = tracked(log, "T")
        const module = makeApp({ providers: [{ useClass: service, scope: Scope.Transient } as Provider] })

        // Not built by the eager pass either — a transient has no eager pass to join.
        expect(log).toEqual([])

        module.mount()
        module.container.resolve(service as never)
        module.container.resolve(service as never)
        module.unmount()
        await module.destroy()

        expect(service.counts).toEqual(NOTHING)
        expect(phase(log, "ctor")).toEqual(["T:ctor", "T:ctor"])
    })

    it("counts one object registered under two useValue tokens once", async () => {
        const counts: HookCounts = { init: 0, mount: 0, unmount: 0, destroy: 0 }
        const shared = {
            onModuleInit: () => counts.init++,
            onModuleMount: () => counts.mount++,
            onModuleUnmount: () => counts.unmount++,
            onModuleDestroy: () => counts.destroy++,
        }
        const FIRST = Symbol("first")
        const SECOND = Symbol("second")

        const module = makeApp({
            providers: [
                { provide: FIRST, useValue: shared },
                { provide: SECOND, useValue: shared },
            ],
        })

        module.mount()
        module.unmount()
        await module.destroy()

        expect(counts).toEqual(ONCE)
    })

    it("destroys a module that never mounted", async () => {
        const log: string[] = []
        const service = tracked(log, "A")
        const module = makeApp({ providers: [service] })

        // A never-mounted module has nothing to retire, so unmount() is refused — and `initialized` is a
        // state destroy() accepts on its own, so the module is disposable without ever having gone live.
        expect(() => module.unmount()).toThrow(refuses("unmount", "initialized"))
        await module.destroy()

        expect(service.counts).toEqual({ init: 1, mount: 0, unmount: 0, destroy: 1 })
        expect(log).toEqual(["A:ctor", "A:init", "A:destroy"])
    })

    it("includes a factory-built instance", async () => {
        const log: string[] = []
        const TOKEN = Symbol("factory")
        const module = makeApp({
            providers: [
                {
                    provide: TOKEN,
                    useFactory: () => ({
                        onModuleInit: () => log.push("F:init"),
                        onModuleMount: () => log.push("F:mount"),
                        onModuleUnmount: () => log.push("F:unmount"),
                        onModuleDestroy: () => log.push("F:destroy"),
                    }),
                },
            ],
        })

        module.mount()
        module.unmount()
        await module.destroy()

        expect(log).toEqual(["F:init", "F:mount", "F:unmount", "F:destroy"])
    })

    it("includes an instance that implements only one of the four hooks", async () => {
        const log: string[] = []
        class DestroyOnly {
            onModuleDestroy(): void {
                log.push("D:destroy")
            }
        }

        const module = makeApp({ providers: [DestroyOnly] })
        module.mount()
        module.unmount()
        await module.destroy()

        expect(log).toEqual(["D:destroy"])
    })

    it("skips a provider with no hooks without disturbing the order of the rest", async () => {
        const log: string[] = []
        const module = makeApp({
            providers: [tracked(log, "A"), plain("noop"), tracked(log, "B")],
        })
        log.length = 0

        module.mount()
        module.unmount()
        await module.destroy()

        expect(log).toEqual(["A:mount", "B:mount", "B:unmount", "A:unmount", "B:destroy", "A:destroy"])
    })

    it("leaves an ancestor's instance alone when a descendant resolves it", async () => {
        const log: string[] = []
        const service = tracked(log, "A")
        const parent = makeApp({ providers: [service] })
        const child = makeChild(parent, { providers: [] })
        child.mount()
        parent.mount()

        child.container.resolve(service as never)
        expect(service.counts).toEqual({ init: 1, mount: 1, unmount: 0, destroy: 0 })

        child.unmount()
        await child.destroy()

        expect(service.counts).toEqual({ init: 1, mount: 1, unmount: 0, destroy: 0 })

        parent.unmount()
        await parent.destroy()
        expect(service.counts).toEqual(ONCE)
    })

    /**
     * Adoption keys on OWNERSHIP, not on who asked. The sibling above resolves an instance the parent had
     * already built; this one makes the descendant's read the construction itself, which is the only case
     * where the two could ever have disagreed.
     */
    it("adopts into the owner when a descendant is first to resolve an ancestor's lazy singleton", async () => {
        const log: string[] = []
        const service = tracked(log, "A")
        const parent = makeApp({ providers: [{ provide: service, useClass: service, lazy: true } as Provider] })
        const child = makeChild(parent, { providers: [] })
        child.mount()
        parent.mount()

        // Nothing has built it yet, so this read constructs it — and a construction is reported by the
        // container that owns the entry, whichever container the read was made on.
        child.container.resolve(service as never)
        expect(service.counts).toEqual({ init: 1, mount: 1, unmount: 0, destroy: 0 })

        // The child tears down and the instance is untouched: it joined the PARENT's participants.
        child.unmount()
        await child.destroy()
        expect(service.counts).toEqual({ init: 1, mount: 1, unmount: 0, destroy: 0 })

        parent.unmount()
        await parent.destroy()
        expect(service.counts).toEqual(ONCE)
    })

    /**
     * Characterisation, not endorsement: a module is visible to its parent's cascade only once it has
     * mounted (mount is what attaches it), so a module that was created but never mounted is invisible and
     * its providers are never destroyed. React always commits, so this is only reachable when a module is
     * built and then dropped before its effect runs.
     */
    it("does not reach a child that never mounted", async () => {
        const log: string[] = []
        const childService = tracked(log, "C")
        const parent = makeApp({ providers: [tracked(log, "P")] })
        makeChild(parent, { providers: [childService] })

        parent.mount()
        parent.unmount()
        await parent.destroy()

        expect(childService.counts).toEqual({ init: 1, mount: 0, unmount: 0, destroy: 0 })
        expect(log).toEqual(["P:ctor", "P:init", "C:ctor", "C:init", "P:mount", "P:unmount", "P:destroy"])
    })

    /**
     * Binding-level activation, per spec: a shadowing descendant never fires an ancestor's listener. When a
     * child module declares a token an ancestor also declares, the child's instance joins the child alone —
     * the ancestor keeps only the instance it built. Each service therefore runs its four hooks exactly once.
     *
     * (This was the one 0.4.0 defect — token-matched activation leaking the child's instance into the
     * ancestor's participant set; the 0.5.0 rework closes it, and this is the regression guard.)
     */
    it("runs each hook once when a child module shadows an ancestor's token", async () => {
        const log: string[] = []
        const TOKEN = Symbol("shadowed")
        const parentService = tracked(log, "P")
        const childService = tracked(log, "C")

        const parent = makeApp({
            providers: [{ provide: TOKEN, useClass: parentService } as Provider],
        })
        const child = makeChild(parent, {
            providers: [{ provide: TOKEN, useClass: childService } as Provider],
        })

        child.mount()
        parent.mount()
        parent.unmount()
        await parent.destroy()

        expect(parentService.counts).toEqual(ONCE)
        expect(childService.counts).toEqual(ONCE)
    })
})
