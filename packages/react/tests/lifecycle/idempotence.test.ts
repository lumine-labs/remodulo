import { describe, expect, it } from "vitest"

import { App } from "../../src/core/module.js"
import { ModuleStatus } from "../../src/core/module-lifecycle.types.js"
import { makeApp, makeChild, refuses, tracked } from "../setup/helpers.js"

// Signal discipline — the retirement of idempotence.
// ========================================
//
// This file used to pin the opposite ruling: React re-sends signals, so the module COLLAPSED them and every
// hook ran exactly once per instance however many times it was asked. That doctrine is retired. All four
// phase gates now THROW on a signal they cannot serve:
//
//   init()    accepts `created`
//   mount()   accepts `initialized | unmounted`
//   unmount() accepts `mounted`
//   destroy() refuses `mounted | initializing` and collapses on `destroying | destroyed`
//
// destroy() is the one exception, and it was carved out deliberately in the round after: a repeat destroy is
// a request for a state the module is already reaching, so it COLLAPSES rather than refusing. It is the only
// signal a caller can send twice and be right both times — the first call's own claim walk collapses the
// same way when it meets a child a second caller already took.
//
// The hooks-run-once property SURVIVES, and that is the point of the rewrite: it is now a consequence of the
// caller never sending a repeat, not of the module absorbing one — except for destroy, where it is the
// collapse doing the work. Every cell below asserts both halves — the refusal or the no-op, and the
// untouched counts behind it.
//
// What moved the doctrine is that "collapse the repeat" cannot tell a benign echo from a caller that has
// lost track of the state, and the second is the one that costs a debugging session. The library's own React
// layer stopped relying on the collapse in the same round: `useModuleLifecycle` checks the status before it
// signals, like any other caller.

describe("repeated signals", () => {
    it("refuses the second of every phase but destroy, and the hooks behind them still ran exactly once", async () => {
        const log: string[] = []
        const service = tracked(log, "A")
        const childService = tracked(log, "C")
        const parent = makeApp({ providers: [service] })
        const child = makeChild(parent, { providers: [childService] })

        parent.mount()
        expect(() => parent.mount()).toThrow(refuses("mount", "mounted"))
        child.mount()
        expect(() => child.mount()).toThrow(refuses("mount", "mounted"))

        // The parent's walk retires the child with it, so the child's own repeat is refused from `unmounted`.
        parent.unmount()
        expect(() => parent.unmount()).toThrow(refuses("unmount", "unmounted"))
        expect(() => child.unmount()).toThrow(refuses("unmount", "unmounted"))

        // The one signal that does not refuse its repeat: a claimed subtree yields no nodes to the walk, so
        // both trailing calls resolve without reaching a hook.
        await parent.destroy()
        await expect(child.destroy()).resolves.toBeUndefined()
        await expect(parent.destroy()).resolves.toBeUndefined()

        expect(service.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
        expect(childService.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
    })

    it("refuses a second init, and re-notifies nothing on the way out", () => {
        const log: string[] = []
        const service = tracked(log, "A")
        const module = new App({ providers: [service], onModuleInit: () => log.push("module:init") })

        module.init()
        expect(() => module.init()).toThrow(refuses("init", "initialized"))

        // The refusal is raised at the gate, ahead of the phase: nothing is rebuilt and nothing re-fires.
        expect(service.counts.init).toBe(1)
        expect(log).toEqual(["A:ctor", "module:init", "A:init"])
    })

    it("REMOUNTS after an unmount — a module is spent only by destruction", () => {
        const log: string[] = []
        const service = tracked(log, "A")
        const module = makeApp({ providers: [service] })

        module.mount()
        module.unmount()
        module.mount()

        // The `unmounted → mount()` cell, and the reason the gates are not simply "one shot per phase":
        // idempotence was about REPEATED signals, and a signal that REVERSES the last one is new work.
        expect(log).toEqual(["A:ctor", "A:init", "A:mount", "A:unmount", "A:mount"])
        expect(service.counts).toEqual({ init: 1, mount: 2, unmount: 1, destroy: 0 })
        expect(module.status).toBe(ModuleStatus.Mounted)
    })

    it("refuses every signal after destroy except a second destroy", async () => {
        const log: string[] = []
        const service = tracked(log, "A")
        const module = makeApp({ providers: [service] })
        module.mount()
        module.unmount()
        await module.destroy()
        log.length = 0

        // The owner's standing loud-refusal ruling for mounting a corpse, extended to unmount: both ask a
        // corpse for something it cannot give. destroy() is the asymmetry that stayed — it asks for exactly
        // what the corpse already is, so it is answered rather than refused, and nothing re-runs either way.
        expect(() => module.mount()).toThrow(refuses("mount", "destroyed"))
        expect(() => module.unmount()).toThrow(refuses("unmount", "destroyed"))
        await expect(module.destroy()).resolves.toBeUndefined()

        expect(module.status).not.toBe(ModuleStatus.Mounted)
        expect(log).toEqual([])
        expect(service.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
    })

    it("refuses destroy() on a mounted module — unmount is the required first step", async () => {
        const log: string[] = []
        const service = tracked(log, "A")
        const module = makeApp({ providers: [service] })
        module.mount()

        // RULED PATH ENFORCEMENT: "if we called mount, we have to call unmount before destroy". The old
        // imperative destroy-while-mounted shortcut — which claimed the subtree and skipped the unmount
        // phase outright — is gone with it. `mounted` is simply not a state destroy() accepts.
        await expect(module.destroy()).rejects.toThrow(refuses("destroy", "mounted"))
        expect(module.status).not.toBe(ModuleStatus.Destroyed)
        expect(service.counts).toEqual({ init: 1, mount: 1, unmount: 0, destroy: 0 })

        module.unmount()
        await module.destroy()

        expect(service.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
    })
})

describe("concurrent signals", () => {
    it("collapses the two trailing calls of three overlapping destroys", async () => {
        const log: string[] = []
        const service = tracked(log, "A", { destroyDelay: 10 })
        const module = makeApp({ providers: [service] })
        module.mount()
        module.unmount()
        log.length = 0

        // `#claimSubtree` is synchronous, so the first call has already written `destroying` by the time it
        // hands its promise back — the trailing two find an empty node list, not a race.
        const results = await Promise.allSettled([module.destroy(), module.destroy(), module.destroy()])

        // CAVEAT the collapse buys at the price of the refusal: all three resolve, but only the winner's
        // promise is a join on the drain. The other two settle immediately, with the hooks still running.
        expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"])
        expect(service.counts.destroy).toBe(1)
        expect(log).toEqual(["A:destroy"])
    })

    it("collapses a second destroy issued while the first is still suspended", async () => {
        const log: string[] = []
        const service = tracked(log, "A", { destroyDelay: 20 })
        const module = makeApp({ providers: [service] })
        module.mount()
        module.unmount()
        log.length = 0

        const inFlight = module.destroy()
        await new Promise((resolve) => setTimeout(resolve, 5))

        // Mid-drain the status is `destroying`, and the second call collapses on it — resolving while the
        // winner's hooks are still running. What the caller cannot tell from the promise is "already gone"
        // from "still going"; `module.status` is the read that distinguishes them.
        await expect(module.destroy()).resolves.toBeUndefined()
        expect(module.status).not.toBe(ModuleStatus.Destroyed)
        expect(log).toEqual([])

        await inFlight
        expect(log).toEqual(["A:destroy"])
        expect(service.counts.destroy).toBe(1)
    })

    it("collapses the child's destroy once the parent's claim has already taken it", async () => {
        const log: string[] = []
        const parentService = tracked(log, "P")
        const childService = tracked(log, "C")
        const parent = makeApp({ providers: [parentService] })
        const child = makeChild(parent, { providers: [childService] })
        child.mount()
        parent.mount()
        parent.unmount()
        log.length = 0

        const [parentResult, childResult] = await Promise.allSettled([parent.destroy(), child.destroy()])

        // The parent's claim walk reaches the child synchronously, so the child's own call arrives at a node
        // already `destroying`. It collapses — and the child is still drained, by the walk that took it.
        expect(parentResult.status).toBe("fulfilled")
        expect(childResult.status).toBe("fulfilled")
        expect(log).toEqual(["C:destroy", "P:destroy"])
        expect(parentService.counts.destroy).toBe(1)
        expect(childService.counts.destroy).toBe(1)
    })

    it("destroys each provider once when the child claims itself first", async () => {
        const log: string[] = []
        const parentService = tracked(log, "P")
        const childService = tracked(log, "C")
        const parent = makeApp({ providers: [parentService] })
        const child = makeChild(parent, { providers: [childService] })
        child.mount()
        parent.mount()
        parent.unmount()
        log.length = 0

        // Unchanged by the gates: the child claims and DETACHES itself, so the parent's later walk never
        // reaches it and both calls are legal. Ordering, not collapsing, is what makes this one work.
        await Promise.all([child.destroy(), parent.destroy()])

        expect(parentService.counts.destroy).toBe(1)
        expect(childService.counts.destroy).toBe(1)
        expect(log.slice().sort()).toEqual(["C:destroy", "P:destroy"])
    })

    it("refuses repeated unmount signals arriving from both ends of the tree", () => {
        const log: string[] = []
        const parentService = tracked(log, "P")
        const childService = tracked(log, "C")
        const parent = makeApp({ providers: [parentService] })
        const child = makeChild(parent, { providers: [childService] })
        child.mount()
        parent.mount()
        log.length = 0

        child.unmount()
        parent.unmount()

        // The child retired itself first, then the parent's walk passed back over it. A third signal from
        // either end is refused — this is the shape the React layer hits on every nested teardown, and the
        // reason `useModuleLifecycle` now checks `module.status === mounted` before it sends the cleanup's unmount.
        expect(() => child.unmount()).toThrow(refuses("unmount", "unmounted"))

        expect(log).toEqual(["C:unmount", "P:unmount"])
        expect(parentService.counts.unmount).toBe(1)
        expect(childService.counts.unmount).toBe(1)
    })
})
