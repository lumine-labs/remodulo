import { describe, expect, it, vi } from "vitest"

import { inject } from "@remodulo/container"
import { App, Module } from "../../src/core/module.js"
import { ModuleStatus } from "../../src/core/module-lifecycle.types.js"
import type { Provider } from "../../src/types.js"
import { makeApp, makeChild, phase, refuses, tracked } from "../setup/helpers.js"
import { assertTreeInvariant } from "../setup/invariants.js"

// Lifecycle rulings.
// ========================================
//
// The single-status refactor turned a set of booleans into a state alphabet, and that made a handful of
// cells in the signal × state table VISIBLE for the first time — cells the booleans could not express and
// no test had ever pinned. This suite is one describe per ruling, so a future round that wants to change
// one can see exactly what it is changing.
//
// Round 3:
//
//   1. a severed mount leaves its initiating node `unmounted` — there is no "reverted" state;
//   2. a phase's own hooks cannot re-send the signal that is running them: it throws;
//   3. `init()` after a failed init is IGNORED, not retried;
//   4. `destroy()` on a module that never inited skips the module-level destroy hook;
//   5. `destroy()` claims the WHOLE subtree synchronously, before any node's drain awaits;
//   6. `destroy()` after a failed init drains a heterogeneous instance set in full.
//
// Round 4 took the two cells round 3 left open, and one it had ruled the other way:
//
//   7. `unmounted → mount()` is a REMOUNT. A module is revivable right up until destruction begins;
//   8. `mount()` on a claimed module THROWS. Destruction is the one thing that is permanent;
//   9. a CASCADED node whose own mount phase throws lands in `mount_failed` — a named failure state, the
//      `init_failed` shape one phase later — instead of being stranded in `mounting` for good.
//
// Round 5 adopted the owner's lifecycle, and it answers these from a different shape: seven statuses with
// no transient states, and a per-participant mark that carries what used to be module-level bookkeeping.
// Four of the nine survive as written — 3, 4, 5 and 6 all fall out of the participant map rather than out
// of a table — and the rest moved:
//
//   1. the initiator of a severed mount lands in `failed`, after a FULL rollback unmount of the island;
//   2. re-entrancy no longer throws. unmount() is inert; init() and mount() re-enter (see the note there);
//   8. mounting a corpse is silent, not loud;
//   9. `mount_failed` is gone with the rest of the transients; the stranded node is simply `unmounted`.
//
// Round 6 made all four gates THROW. There is no silent door left in the lifecycle:
//
//   init()    accepts `created`
//   mount()   accepts `initialized | unmounted`
//   unmount() accepts `mounted`
//   destroy() accepts `initialized | unmounted`
//
// That resolves 8 the way round 4 wanted it — mounting a corpse refuses loudly — and takes every other
// "silent no-op" cell in this file with it. Three consequences are deliberate and worth naming up front,
// because each is a capability the library used to have:
//
//   * `failed` is in NO allow-set. A module that failed init or mount cannot be destroyed, so whatever it
//     adopted before it failed leaks for the process's lifetime. Ruling 3's drain and ruling 6's
//     heterogeneous drain are both unreachable now; the cells that pinned them pin the refusal instead.
//   * `mounted` is not in destroy()'s allow-set. "If we called mount, we have to call unmount before
//     destroy" is now enforced, not merely recommended — the imperative destroy-while-mounted shortcut,
//     which claimed a live subtree and skipped its unmount phase, is gone.
//   * `created` is not in destroy()'s allow-set either, which retires ruling 4 as a behaviour and closes
//     the mid-init destroy interleaving of its own accord (see the re-entrancy describe).
//
// Round 7 took the first and third of those back. destroy() is the odd gate out now: it REFUSES exactly one
// state and serves every other, because a teardown that cannot run is the one refusal that costs resources
// rather than saving them.
//
//   init()    accepts `created`
//   mount()   accepts `initialized | unmounted`
//   unmount() accepts `mounted`
//   destroy() refuses `mounted`, no-ops on `destroying | destroyed`, and drains everything else
//
// Three consequences, each the mirror of a round 6 one:
//
//   * `failed` is destroyable. Both leaks round 6 booked — the failed-init instance set and the severed
//     island — are reclaimable again, and the cells that pinned the refusal pin the drain instead.
//   * `created` is destroyable, and drains nothing, because a module that never inited built nothing. That
//     restores ruling 4 as a behaviour and REOPENS the mid-init interleaving, which is now doctrine's
//     problem rather than the gate's (see the re-entrancy describe).
//   * `destroying` and `destroyed` are a silent no-op rather than a refusal. A second caller asking for a
//     teardown that is already claimed is asking for something it is going to get; it is `mounted` — asking
//     to skip the unmount phase — that is the caller error.
//
// Round 8 puts ONE transient state back, and only one: `initializing`, written before the eager pass and
// gone by the time init() returns. It buys two things the alphabet could not express without it.
//
//   init()    accepts `created`
//   mount()   accepts `initialized | unmounted`
//   unmount() accepts `mounted`
//   destroy() refuses `mounted | initializing`, no-ops on `destroying | destroyed`, and drains the rest
//   a READ    is refused on `created | failed | destroyed`, and served from `initializing` through
//             `destroying`
//
//   * the resolution gate (§14) has a state to serve, so the lifecycle's own eager pass is not refused by
//     the door that refuses everyone else's pre-init read. No origin tagging, no exemption — the phases are
//     synchronous, so `initializing` is a state only the lifecycle's own reads can ever observe.
//   * every signal sent from inside the init phase now meets a gate that refuses it, which closes both
//     halves of the round-7 hazard: the re-entrant init() and the mid-init destroy() (see the re-entrancy
//     describe, where the two cells that measured the damage now pin the refusal).
//
// Every cell that moved says so at its describe, with what it would take to move it back.

/** A provider whose destroy hook reports the world as it looked at the hook's first synchronous line. */
function destroyProbe(record: () => void): Provider {
    const Service = class {
        async onModuleDestroy(): Promise<void> {
            record()
        }
    }
    return Service as unknown as Provider
}

/** Run `signal` and hand back whatever it threw, so a hook can report a refusal without failing its phase. */
function refusal(signal: () => void): string {
    try {
        signal()
    } catch (error) {
        return (error as Error).message
    }
    return "no refusal"
}

// 1. The severed island's initiating node
// ========================================
//
// `MOUNT_REVERTED` was the one state the five booleans held that no other point could express: mounted,
// but detached, so a fresh mount() would re-attach it. It is gone. A node whose cascade hit a throwing
// descendant is detached and RETIRED — `unmounted`, exactly like a node that finished its own reverse
// walk. Its mount hooks ran and will never be paired, which is the documented leak; what it no longer
// does is claim to be mounted while hanging off nothing.
//
// Round 4 gave that ruling its point: `unmounted` is now revivable, so a rolled-back initiator is not a
// dead end. Retrying it is a supported move, and the poisoned descendant no longer poisons the retry.

describe("a mount whose cascade threw", () => {
    function severedIsland(log: string[]): { app: App; parent: Module; healthy: Module } {
        const app = makeApp()
        app.mount()

        const parent = makeChild(app, { providers: [tracked(log, "P")] })
        const healthy = makeChild(parent, { providers: [tracked(log, "C1")] })
        const second = makeChild(parent, { providers: [tracked(log, "C2", { throwOn: "mount" })] })
        healthy.mount()
        second.mount()

        expect(() => parent.mount()).toThrow("C2 mount")

        return { app, parent, healthy }
    }

    it("lands the initiating node in `failed`, detached and spent for mount", () => {
        const log: string[] = []
        const { app, parent } = severedIsland(log)

        // The whole island came off the App in one cut, and the initiator carries the one failure state the
        // alphabet has. `initialized` is derived, and it reads `failed` as "did not arrive".
        expect(app.children.size).toBe(0)
        expect(parent.status).toBe(ModuleStatus.Failed)
        expect(parent.status).not.toBe(ModuleStatus.Mounted)
        expect(parent.status).toBeOneOf([ModuleStatus.Created, ModuleStatus.Failed])
        expect(parent.status).not.toBe(ModuleStatus.Destroyed)
    })

    it("unmounts the whole island on the way down, so nothing is left mounted under it", () => {
        const log: string[] = []
        const { parent, healthy } = severedIsland(log)

        // The rollback is a full reverse walk, not a detach: the healthy child was retired with its parent.
        expect(healthy.status).not.toBe(ModuleStatus.Mounted)
        expect(healthy.status).toBe(ModuleStatus.Unmounted)

        log.length = 0

        // And `failed` is not `mounted`, so a later unmount() is refused rather than quietly absorbed.
        expect(() => parent.unmount()).toThrow(refuses("unmount", "failed"))
        expect(log).toEqual([])
    })

    it("no longer produces the tree shape the invariant refuses", () => {
        const log: string[] = []
        const { parent } = severedIsland(log)

        // The old NEGATIVE CONTROL was the severed island itself: a mounted child hanging off a parent that
        // is not mounted. The rollback's full unmount walk means that shape can no longer be reached through
        // the public API at all — so the island passes, and the control is rebuilt below by hand.
        expect(() => assertTreeInvariant(parent)).not.toThrow()
    })

    it("is still refused when the pairing is forced behind the tree's back", () => {
        const log: string[] = []
        const app = makeApp()
        const child = makeChild(app, { providers: [tracked(log, "C")] })
        child.mount()
        app.mount()

        // `addChild` is the tree's attach point and it asks no questions, so the illegal pairing can be
        // staged through it: a mounted child hanging off a module that never mounted. This is the NEGATIVE
        // CONTROL for `assertTreeInvariant` — if it stops throwing here, the helper has stopped proving
        // anything everywhere else it is wired in.
        const bystander = makeApp()
        bystander.addChild(child)

        expect(() => assertTreeInvariant(bystander)).toThrow(/hangs off/)
    })

    it("refuses an un-initialized child forced onto a parent", () => {
        // Control for the second rule. `mount()` is what attaches, and it runs past the `created` gate, so
        // a never-inited child is unreachable from `children` through the public API — unless `addChild`
        // is called directly, which is exactly what this does.
        const app = makeApp()
        const stranger = new Module(app, {})

        app.addChild(stranger)

        expect(stranger.status).toBe(ModuleStatus.Created)
        expect(() => assertTreeInvariant(app)).toThrow(/is not initialized/)
    })

    it("refuses ANY child forced onto a claimed parent, live or inert", async () => {
        // Control for the third rule, at full strength. A corpse used to be allowed to hold INERT children,
        // because `mount()` attached before it consulted the parent's state and a child whose parent died
        // under it stayed linked. The guard sits ahead of the attach now, so the claim walk's unlink is the
        // last word: a claimed node holds nothing at all, whatever state it is in.
        const log: string[] = []
        const app = makeApp()
        const live = makeChild(app, { providers: [tracked(log, "C")] })
        live.mount()
        app.mount()

        const corpse = makeApp()
        await corpse.destroy()
        corpse.addChild(live)

        expect(live.status).toBe(ModuleStatus.Mounted)
        expect(() => assertTreeInvariant(corpse)).toThrow(/still has an ATTACHED child/)

        // And the inert half, which the weaker rule used to let through.
        const inert = makeApp()
        const resting = makeChild(inert, {})
        corpse.removeChild(live)
        corpse.addChild(resting)

        expect(resting.status).toBe(ModuleStatus.Initialized)
        expect(() => assertTreeInvariant(corpse)).toThrow(/still has an ATTACHED child/)
    })

    // Round 6 booked the whole island as a permanent leak: `failed` was in no allow-set, and the claim walk
    // is the only thing that reaches the children, so nothing under the severed root could be destroyed
    // THROUGH it either. Round 7 admits `failed`, and the walk reaches the island in one call again.
    it("is destroyed as one island — the failed root and everything still hanging off it", async () => {
        const log: string[] = []
        const { parent, healthy } = severedIsland(log)
        log.length = 0

        await parent.destroy()

        // Children-first over the attached subtree, and the participant that THREW is drained like any
        // other: it was constructed and inited, so whatever it holds is the module's to release.
        expect(log).toEqual(["C2:destroy", "C1:destroy", "P:destroy"])
        expect([parent.status, healthy.status]).toEqual([ModuleStatus.Destroyed, ModuleStatus.Destroyed])
    })

    it("leaves each healthy island member destroyable on its own as well", async () => {
        const log: string[] = []
        const { parent, healthy } = severedIsland(log)
        log.length = 0

        // The rollback retired the healthy child to `unmounted`, so it is claimable in its own right — and
        // claiming it DETACHES it, which is why the root's later walk does not reach it a second time.
        await healthy.destroy()

        expect(log).toEqual(["C1:destroy"])
        expect(healthy.status).toBe(ModuleStatus.Destroyed)
        expect(parent.status).not.toBe(ModuleStatus.Destroyed)

        log.length = 0
        await parent.destroy()

        expect(log).toEqual(["C2:destroy", "P:destroy"])
        expect(parent.status).toBe(ModuleStatus.Destroyed)
    })

    // Round 4 made the rolled-back initiator revivable: `unmounted` accepted a fresh mount(). Round 5 left
    // it spent but silent about it, which was flagged. Round 6 keeps it spent and says so — reviving it
    // still means either accepting `failed` in mount() or rolling back to `unmounted` instead of `failed`.
    it("cannot be mounted again — `failed` is not a state mount() accepts", () => {
        const log: string[] = []
        const { app, parent } = severedIsland(log)
        log.length = 0

        expect(() => parent.mount()).toThrow(refuses("mount", "failed"))

        expect(log).toEqual([])
        expect(parent.status).not.toBe(ModuleStatus.Mounted)
        expect(app.children.size).toBe(0)
    })
})

// 2. Re-entrancy
// ========================================
//
// Round 3 made a hook that re-sends its own signal THROW, out of a state the alphabet had a name for:
// `initializing`, `mounting`, `unmounting`. Round 5 has no transient states — a phase is bracketed by the
// participant marks, not by a status of its own — so a re-entrant signal meets the SAME gate the first one
// passed, and the marks decide what actually re-fires.
//
// The result is not uniform, and this is the one hazard round 5 leaves standing:
//
//   * unmount() is genuinely inert. `#unmountTree` flips the status to `unmounted` BEFORE the walk, so the
//     second call is turned away at the gate and nothing fires twice.
//   * mount() is NOT. It writes its status only after the phase returns, so the gate sees exactly what it
//     saw the first time and the phase RE-ENTERS. Per-participant marks stop the double notification — a
//     participant is only reached while un-marked, which is the one running the hook — but nothing stops
//     the recursion itself: a hook that re-sends its signal unconditionally recurses until the stack runs
//     out. Every mount hook below is deliberately self-limiting.
//
// Round 6's throwing gates did not close any of it, because a re-entrant signal met its gate from inside a
// phase whose status had not advanced yet. Round 8 closes the INIT half, and does it with the fix this note
// used to rule out: the init phase gets a status of its own, `initializing`, written before the eager pass
// so the resolution gate can serve it. Everything sent from inside init now meets a gate that refuses —
// init() because `initializing` is not `created`, destroy() because it refuses `initializing` outright — and
// the two costs that made this the sharpest hazard in the file are both gone: no duplicate module
// participant, and no trailing `initialized` written over a `destroyed` the drain had already set.
//
// Mount is what is left standing, and it is partly defended already: `#mountTree` writes `mounted` only if
// the status is not already `destroying`, so a claim taken mid-mount survives the assignment behind it.
//
// DOCTRINE, unchanged: re-sending a phase's own signal from inside that phase is FORBIDDEN. It is now
// ENFORCED for init and still merely forbidden for mount — a `mounting` status would be the same fix again,
// and nobody has bought it. The mount probes below are kept as the executable evidence that that hole is
// real and where its edges are.

/**
 * A latch that lets the first caller through and swallows the rest.
 *
 * It has to live OUTSIDE the hook: re-entry runs the hook body again, so a latch created inside it would
 * be a fresh one every time and the "bounded" re-entry would not be bounded at all.
 */
function once(): (send: () => void) => void {
    let spent = false
    return (send) => {
        if (spent) return
        spent = true
        send()
    }
}

describe("a phase's own hooks re-sending its signal", () => {
    it("refuses init() sent from inside the init phase, and fails the phase that sent it", () => {
        const log: string[] = []
        const service = tracked(log, "A")
        const reenter = once()

        const app = new App({
            providers: [service],
            onModuleInit: (container) => {
                log.push("module:init")
                reenter(() => container.resolve(Module).init())
            },
        })

        // `initializing` is not `created`, so the re-send meets the gate the first call walked through.
        expect(() => app.init()).toThrow(refuses("init", "initializing"))

        // The refusal is a throw from a participant's own hook, so it costs the phase like any other: the
        // module participant is notified first, and `A` never reaches its init.
        expect(log).toEqual(["A:ctor", "module:init"])
        expect(service.counts.init).toBe(0)
        expect(app.status).toBe(ModuleStatus.Failed)
    })

    it("leaves no duplicate module participant behind for the later phases to carry", async () => {
        const log: string[] = []
        const reenter = once()
        const app = new App({
            onModuleInit: (container) => {
                log.push("module:init")
                reenter(() => container.resolve(Module).init())
            },
            onModuleDestroy: () => log.push("module:destroy"),
        })

        expect(() => app.init()).toThrow(refuses("init", "initializing"))
        log.length = 0

        // The refusal lands before a second pass can append anything, so there is ONE module participant
        // and it is drained once. The re-entry used to leave two, notified for the rest of the module's
        // life — that permanent cost was the sharpest evidence the hole was worth closing.
        await app.destroy()

        expect(log).toEqual(["module:destroy"])
    })

    it("lets mount() back in, and mounts each participant once", () => {
        const log: string[] = []
        const service = tracked(log, "A")
        const reenter = once()
        const app = makeApp({
            providers: [service],
            onModuleMount: (container) => {
                log.push("module:mount")
                reenter(() => container.resolve(Module).mount())
            },
        })

        app.mount()

        // Two module-hook fires, one per entry into the phase; the provider is reached once, by the marks.
        expect(phase(log, "mount")).toEqual(["module:mount", "module:mount", "A:mount"])
        expect(service.counts.mount).toBe(1)
        expect(app.status).toBe(ModuleStatus.Mounted)
    })

    it("REFUSES a re-entrant unmount() — the status flips before the walk, so the gate turns it away", () => {
        const log: string[] = []
        const service = tracked(log, "A")
        const app = makeApp({
            providers: [service],
            onModuleUnmount: (container) => {
                log.push("module:unmount")
                container.resolve(Module).unmount()
            },
        })
        app.mount()
        log.length = 0

        // The unconditional re-send terminates — `#unmountTree` writes `unmounted` BEFORE the walk, so the
        // second call is refused instead of recursing. The refusal is raised inside a participant's hook,
        // and `#runUnmountPhase` collects hook errors rather than aborting, so it surfaces as the phase's
        // AggregateError with the walk already complete behind it.
        let thrown: unknown
        try {
            app.unmount()
        } catch (error) {
            thrown = error
        }

        expect(thrown).toBeInstanceOf(AggregateError)
        const [reentrant] = (thrown as AggregateError).errors as Error[]
        expect(reentrant.message).toMatch(refuses("unmount", "unmounted"))

        expect(log).toEqual(["A:unmount", "module:unmount"])
        expect(service.counts.unmount).toBe(1)
        expect(app.status).toBe(ModuleStatus.Unmounted)
    })

    /**
     * THE DOCTRINE HAZARD, in its sharpest form — and CLOSED, by the `initializing` status rather than by
     * either of the two fixes this file used to rule out. Round 6 had closed it by accident, when dropping
     * `created` from destroy()'s allow-set refused the mid-init claim as a side effect; round 7 needed
     * `created` back for disposal and reopened it.
     *
     * What it used to cost: the claim landed mid-init and cleared the participant map, so the init loop's
     * own iterator ran out and every instance after the hook was skipped; then `init()`'s trailing
     * assignment wrote `initialized` over the `destroyed` the drain had just set. The module claimed to be
     * armed while holding nothing, and `A` was left constructed, un-inited and un-destroyed.
     *
     * The init phase has a status of its own now, so the claim is refused at the gate and there is no
     * interleaving to survive. The refusal arrives as a REJECTION rather than a throw — `destroy()` is
     * async, so the gate's error becomes the promise's — which is why the hook runs on and the phase it
     * was sent from finishes untouched.
     */
    it("refuses destroy() sent from inside the init phase, and the phase completes untouched", async () => {
        const log: string[] = []
        const service = tracked(log, "A")
        let inFlight: Promise<void> | undefined

        const app = new App({
            providers: [service],
            onModuleInit: (container) => {
                log.push("module:init")
                inFlight = container.resolve(Module).destroy()
            },
        })

        app.init()

        await expect(inFlight).rejects.toThrow(refuses("destroy", "initializing"))

        // Nothing drained, nothing skipped: `A` was built by the eager pass and inited by the loop that
        // the claim used to cut short.
        expect(log).toEqual(["A:ctor", "module:init", "A:init"])
        expect(service.counts).toEqual({ init: 1, mount: 0, unmount: 0, destroy: 0 })

        // The state the module reports is the state it is in — no write to overwrite.
        expect(app.status).toBe(ModuleStatus.Initialized)
    })

    it("takes destroy() from inside the unmount phase and completes both", async () => {
        const log: string[] = []
        const service = tracked(log, "A")
        let inFlight: Promise<void> | undefined

        const app = makeApp({
            providers: [service],
            onModuleUnmount: (container) => {
                log.push("module:unmount")
                inFlight = container.resolve(Module).destroy()
            },
        })
        app.mount()
        log.length = 0

        app.unmount()
        await inFlight

        // The unmount walk has already written `unmounted` by the time the hook runs, and `unmounted` is a
        // state destroy() accepts — so the claim goes through and the drain follows the walk out.
        expect(log).toEqual(["A:unmount", "module:unmount", "A:destroy"])
        expect(app.status).toBe(ModuleStatus.Destroyed)
        expect(service.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
    })
})

// 3. Re-init after a failed init
// ========================================
//
// Retrying was the old behaviour and it was a bug factory: `#collectInstances` re-armed the container's
// adoption listeners, and `#runInitPhase` re-notified every instance that had already been initialized
// before the throw. The alternative ruling — ✗, throw on a second init — was rejected: a failed init is
// already reported by the first call's throw, and React's render path would then get a second, less
// informative error on every re-render of the same module.

describe("init() after a failed init", () => {
    function failedApp(log: string[]): App {
        const app = new App({
            providers: [tracked(log, "A"), tracked(log, "B", { throwOn: "init" }), tracked(log, "C")],
            onModuleInit: () => log.push("module:init"),
            onModuleDestroy: () => log.push("module:destroy"),
        })
        expect(() => app.init()).toThrow("B init")
        return app
    }

    it("is REFUSED — nothing is constructed and nothing is re-notified", () => {
        const log: string[] = []
        const app = failedApp(log)
        log.length = 0

        // Round 5's rationale for ignoring rather than throwing was that React's render path would then get
        // a second, less informative error on every re-render. Round 6 throws anyway, and the rationale is
        // answered on the caller's side instead: `AppProvider` arms only a `created` App, so a failed one is
        // never re-inited and the ORIGINAL init error stays the only error React ever sees.
        expect(() => app.init()).toThrow(refuses("init", "failed"))
        expect(() => app.init()).toThrow(refuses("init", "failed"))

        // What has not changed is the thing the ruling was actually about: no retry, so the old bug factory
        // — re-armed adoption listeners, onModuleInit re-fired on everything already built — stays dead.
        expect(log).toEqual([])
        expect(app.status).toBeOneOf([ModuleStatus.Created, ModuleStatus.Failed])
    })

    it("refuses every later phase signal by name", () => {
        const log: string[] = []
        const app = failedApp(log)
        log.length = 0

        expect(() => app.init()).toThrow(refuses("init", "failed"))
        expect(() => app.mount()).toThrow(refuses("mount", "failed"))
        expect(() => app.unmount()).toThrow(refuses("unmount", "failed"))

        expect(log).toEqual([])
        expect(app.status).not.toBe(ModuleStatus.Mounted)
    })

    // RULING 6 RESTORED — the heterogeneous drain, which round 6 had turned into a permanent leak. The
    // instance set is genuinely mixed: A got its onModuleInit, B threw inside it, C was constructed by the
    // eager pass and never reached. Round 7 sorts them by what they OWN rather than by how they ended:
    // A and B ran a hook that may have taken something, so both are drained; C never did, so calling its
    // onModuleDestroy would be releasing something it was never given.
    it("is destroyed, and drains the heterogeneous set down to what actually inited", async () => {
        const log: string[] = []
        const app = failedApp(log)
        log.length = 0

        await app.destroy()

        // Reverse registration order, C absent: `registered` is the one participant status the drain skips.
        expect(log).toEqual(["B:destroy", "A:destroy", "module:destroy"])
        expect(app.status).toBe(ModuleStatus.Destroyed)
    })
})

// 4. Destroy on a module that never inited
// ========================================

describe("destroy() on a module that never inited", () => {
    // RESTORED AS A BEHAVIOUR, with the original ruling's reasoning intact. `created` is back in the
    // allow-set because a caller that builds a module and then changes its mind has to be able to dispose
    // of it. It is the cheapest possible claim: no init means no eager pass, so not one provider was ever
    // constructed and the drain has nothing to reach — including the module's OWN destroy hook, which is
    // registered as a participant by the init phase that never ran.
    it("is accepted, and constructs nothing on the way out", async () => {
        const log: string[] = []
        const service = tracked(log, "A")
        const app = new App({
            providers: [service],
            onModuleDestroy: () => log.push("module:destroy"),
        })

        await app.destroy()

        expect(log).toEqual([])
        expect(service.counts.destroy).toBe(0)
        expect(app.status).toBe(ModuleStatus.Destroyed)
    })

    it("claims the node even though it was never attached to begin with", async () => {
        const app = makeApp()
        app.mount()
        const child = new Module(app, {})

        // Attachment happens inside mount(), past the `created` gate, so a never-inited child was never
        // reachable from its parent — the claim's detach is a no-op and the parent's tree is untouched.
        expect(app.children.size).toBe(0)

        await child.destroy()

        expect(child.status).toBeOneOf([ModuleStatus.Destroying, ModuleStatus.Destroyed])
        expect(child.status).toBe(ModuleStatus.Destroyed)
        expect(child.status).not.toBe(ModuleStatus.Mounted)
        expect(app.children.size).toBe(0)
        assertTreeInvariant(app)
    })

    it("drains what init built when it was inited first", async () => {
        const log: string[] = []
        const app = makeApp()
        app.mount()
        const child = new Module(app, {
            providers: [tracked(log, "C")],
            onModuleDestroy: () => log.push("module:destroy"),
        })

        child.init()
        log.length = 0
        await child.destroy()

        // The contrast with the first cell: the same call, on the same shape, one init apart.
        expect(log).toEqual(["C:destroy", "module:destroy"])
        expect(child.status).toBe(ModuleStatus.Destroyed)
        assertTreeInvariant(app)
    })
})

// 5. Claim ordering
// ========================================

describe("the claim walk", () => {
    it("flips the whole subtree to claimed before any node's drain awaits", async () => {
        const seen: ModuleStatus[][] = []

        const app = makeApp()
        const child = makeChild(app, {})
        const grandchild = makeChild(child, {
            providers: [
                destroyProbe(() => {
                    seen.push([app.status, child.status, grandchild.status])
                }),
            ],
        })
        grandchild.mount()
        child.mount()
        app.mount()

        expect([app.status, child.status, grandchild.status]).toEqual([
            ModuleStatus.Mounted,
            ModuleStatus.Mounted,
            ModuleStatus.Mounted,
        ])

        // Round 5 destroyed straight from `mounted`. That path is closed, so the property is re-expressed
        // over the ruled one — mount, unmount, destroy — which is the only way a live tree is torn down now.
        app.unmount()
        await app.destroy()

        // The probe runs inside the FIRST node to drain (children-first, so the grandchild), at its first
        // synchronous line. Every ancestor is already claimed and none of them is still mounted:
        // `#claimSubtree` is one synchronous pass over the subtree, and no await happens inside it.
        const snapshot = seen[0]!
        expect(snapshot.length).toBe(3)

        for (const status of snapshot) {
            expect(status).toBeOneOf([ModuleStatus.Destroying, ModuleStatus.Destroyed])
            expect(status).not.toBe(ModuleStatus.Mounted)
        }
    })

    it("refuses to start from a mounted node — unmount is the required first step", async () => {
        const app = makeApp()
        const child = makeChild(app, {})
        child.mount()
        app.mount()

        await expect(app.destroy()).rejects.toThrow(refuses("destroy", "mounted"))

        // Refused at the gate, ahead of `#claimSubtree`: not one node in the subtree was claimed or detached.
        expect([app.status, child.status]).not.toContain(ModuleStatus.Destroying)
        expect([app.status, child.status]).not.toContain(ModuleStatus.Destroyed)
        expect(app.children.size).toBe(1)
        assertTreeInvariant(app)
    })
})

// 7. Remount
// ========================================
//
// `unmounted → mount()` used to be the spent-module no-op, on the reading that a module gets one life.
// It is now a REMOUNT: the mount phase and the whole cascade run again on the same instance. The reading
// that replaced it is that unmount and mount are OPPOSITES — a module is spent by destruction, which is
// the only phase that releases anything, and not by a retirement it can be called back from. That is what
// lets React's cleanup schedule a destroy instead of performing one and take it back if the setup returns.

describe("mount() after unmount()", () => {
    it("re-runs the phase and the cascade over the whole retired subtree", () => {
        const log: string[] = []
        const app = makeApp({ providers: [tracked(log, "P")] })
        const child = makeChild(app, { providers: [tracked(log, "C")] })
        const grandchild = makeChild(child, { providers: [tracked(log, "G")] })
        grandchild.mount()
        child.mount()
        app.mount()

        app.unmount()
        log.length = 0

        app.mount()

        // Parent-first on the way back in, exactly as on the first mount — the cascade does not know the
        // difference, because `initialized` and `unmounted` are the same answer to "will you take a cascade",
        // which is exactly why mount() accepts the two of them and nothing else.
        expect(log).toEqual(["P:mount", "C:mount", "G:mount"])
        expect([app.status, child.status, grandchild.status]).toEqual([
            ModuleStatus.Mounted,
            ModuleStatus.Mounted,
            ModuleStatus.Mounted,
        ])
        assertTreeInvariant(app)
    })

    it("does not re-init, and does not rebuild the instance set", () => {
        const log: string[] = []
        const service = tracked(log, "A")
        const app = makeApp({ providers: [service], onModuleInit: () => log.push("module:init") })

        app.mount()
        app.unmount()
        log.length = 0
        app.mount()

        // A remount is a MOUNT, not a rebuild: same instances, no second init phase, no reconstruction.
        expect(log).toEqual(["A:mount"])
        expect(service.counts).toEqual({ init: 1, mount: 2, unmount: 1, destroy: 0 })
    })

    it("is available again after each retirement, however many times", () => {
        const log: string[] = []
        const service = tracked(log, "A")
        const app = makeApp({ providers: [service] })

        for (let cycle = 0; cycle < 3; cycle++) {
            app.mount()
            app.unmount()
        }

        expect(service.counts).toEqual({ init: 1, mount: 3, unmount: 3, destroy: 0 })
    })
})

// 8. Mounting a corpse
// ========================================

describe("mount() on a claimed module", () => {
    // RESOLVED, the owner's way. Round 4 ruled that a corpse must refuse LOUDLY, since a silent no-op hands
    // back a module holding released resources and hides the bug until they are used. Round 5 could not
    // express it — mount() gated on the two states it accepted and let everything else fall through the same
    // silent door. Round 6 makes every gate a throw, so the ruling lands without a special case for it.
    it("refuses from the moment the claim lands, and again once it is complete", async () => {
        const log: string[] = []
        // A participant to drain: with none at all the phase never awaits anything, and `destroying` is
        // over before `destroy()` has even handed its promise back.
        const app = makeApp({ providers: [tracked(log, "A")] })
        app.mount()
        app.unmount()

        const inFlight = app.destroy()

        // `#claimSubtree` is synchronous, so the status is already `destroying` before the drain awaits, and
        // the refusal distinguishes the two windows by name.
        expect(app.status).toBe(ModuleStatus.Destroying)
        expect(() => app.mount()).toThrow(refuses("mount", "destroying"))
        expect(app.status).not.toBe(ModuleStatus.Mounted)

        await inFlight

        expect(app.status).toBe(ModuleStatus.Destroyed)
        expect(() => app.mount()).toThrow(refuses("mount", "destroyed"))
        expect(app.status).not.toBe(ModuleStatus.Mounted)
    })

    it("is joined by unmount() — but NOT by destroy(), which collapses instead", async () => {
        const log: string[] = []
        const app = makeApp({ providers: [tracked(log, "A")] })
        app.mount()
        app.unmount()
        await app.destroy()
        log.length = 0

        // The split round 7 settles. `unmount()` on a corpse is a caller that has lost track of the state,
        // and hears so. `destroy()` on one is a caller asking for something it already has — the same
        // request the claim walk collapses when two of them race — so it is answered rather than refused.
        expect(() => app.unmount()).toThrow(refuses("unmount", "destroyed"))
        await expect(app.destroy()).resolves.toBeUndefined()
        expect(log).toEqual([])
    })
})

// 9. The cascaded node that threw
// ========================================
//
// Rounds 3 and 4 argued about what state to strand this node in, and round 4 gave it a tombstone of its
// own — `mount_failed` — on the grounds that its failure reached no caller. Round 5 has no tombstone to
// give: the initiator's rollback walks the whole severed subtree through `#unmountTree`, so the node that
// threw comes out `unmounted` like every other node in the island. `failed` belongs to the node whose
// mount() was CALLED, not to a node the cascade reached.
//
// What round 4 pinned here still holds, for a different reason each time: the node is inert to mount()
// because its parent is not mounted, not because its own state is terminal.

describe("a cascaded node whose own mount phase threw", () => {
    function stranded(log: string[]): { parent: Module; child: Module } {
        const app = makeApp()
        app.mount()

        const parent = makeChild(app, { providers: [tracked(log, "P")] })
        const child = makeChild(parent, { providers: [tracked(log, "C", { throwOn: "mount" })] })
        child.mount()

        expect(() => parent.mount()).toThrow("C mount")

        return { parent, child }
    }

    it("is inert but honest: unmounted, not mounted, not destroyed", () => {
        const log: string[] = []
        const { child } = stranded(log)

        expect(child.status).toBe(ModuleStatus.Unmounted)
        expect(child.status).not.toBeOneOf([ModuleStatus.Created, ModuleStatus.Failed])
        expect(child.status).not.toBe(ModuleStatus.Mounted)
        expect(child.status).not.toBe(ModuleStatus.Destroyed)
    })

    it("REFUSES mount() — its parent is `failed`, and that branch is spent", () => {
        const log: string[] = []
        const { child } = stranded(log)
        log.length = 0

        // `unmounted` IS an accepted state, so this call reaches the body — and meets the parent guard.
        // FLIPPED from a silent no-op: the old shape attached first and then declined to cascade, which
        // left the corpse holding a link. The refusal is ahead of the attach.
        expect(() => child.mount()).toThrow(
            "Cannot mount a module onto a failed parent — that branch is spent, so the child could never go live under it. Mount it under a live parent, or rebuild the branch first."
        )

        expect(log).toEqual([])
        expect(child.status).not.toBe(ModuleStatus.Mounted)
        expect(child.status).toBe(ModuleStatus.Unmounted)
    })

    it("refuses unmount() — it is `unmounted` already, and that is not a state unmount() accepts", () => {
        const log: string[] = []
        const { child } = stranded(log)
        log.length = 0

        expect(() => child.unmount()).toThrow(refuses("unmount", "unmounted"))
        expect(log).toEqual([])
        expect(child.status).not.toBe(ModuleStatus.Mounted)
    })

    it("takes destroy() and drains what it built", async () => {
        const log: string[] = []
        const { child } = stranded(log)
        log.length = 0

        await expect(child.destroy()).resolves.toBeUndefined()

        expect(log).toEqual(["C:destroy"])
        expect(child.status).toBe(ModuleStatus.Destroyed)
    })
})

// 10. `failed` ⇒ detached
// ========================================
//
// The premise under round 7's widened destroy() gate, and the reason admitting `failed` cannot resurrect a
// zombie into a live tree. A module only reaches `failed` out of init or out of mount, and neither leaves it
// reachable from its parent: attachment happens INSIDE mount(), so a failed init was never attached at all,
// and mount()'s rollback detaches before it writes the status. So a caller destroying a `failed` module is
// always working on an island it holds the only reference to — nothing in the live tree can see the claim.

describe("a module that failed", () => {
    it("is absent from its parent's children, out of init and out of mount alike", () => {
        const log: string[] = []
        const app = makeApp()
        app.mount()

        // Init: attachment is a mount-phase step, so this child never entered the tree to begin with.
        const failedInit = new Module(app, { providers: [tracked(log, "I", { throwOn: "init" })] })
        expect(() => failedInit.init()).toThrow("I init")

        expect(failedInit.status).toBe(ModuleStatus.Failed)
        expect(app.children.has(failedInit)).toBe(false)

        // Mount: attached by mount()'s first statement, and detached again by its catch, before `failed`.
        const failedMount = makeChild(app, { providers: [tracked(log, "M", { throwOn: "mount" })] })
        expect(() => failedMount.mount()).toThrow("M mount")

        expect(failedMount.status).toBe(ModuleStatus.Failed)
        expect(app.children.has(failedMount)).toBe(false)
        expect(app.children.size).toBe(0)
        assertTreeInvariant(app)
    })
})

// 11. The drain's participant filter
// ========================================
//
// Round 7's second half. Admitting `failed` to destroy()'s allow-set puts the drain in front of a
// participant set no other phase ever sees: instances that were CONSTRUCTED by the eager pass but never
// reached by the init loop. `onModuleDestroy` is the release half of a pair whose acquire half is
// `onModuleInit`, so calling it on one of those would be releasing something never acquired.

describe("the destroy drain", () => {
    it("skips a participant that never inited, and drains every one that did", async () => {
        const log: string[] = []
        const inited = tracked(log, "A")
        const threw = tracked(log, "B", { throwOn: "init" })
        const unreached = tracked(log, "C")

        const app = new App({ providers: [inited, threw, unreached] })
        expect(() => app.init()).toThrow("B init")

        // All three are constructed — the eager pass runs before the init loop — and all three are
        // participants. What separates them is how far the loop got: A inited, B threw inside its own
        // onModuleInit, C was never called at all.
        expect(log).toEqual(["A:ctor", "B:ctor", "C:ctor", "A:init"])
        log.length = 0

        await app.destroy()

        // `failed` is drained like any other state — B's hook may well have taken something before it threw.
        // `registered` is the one status skipped.
        expect(log).toEqual(["B:destroy", "A:destroy"])
        expect(inited.counts.destroy).toBe(1)
        expect(threw.counts.destroy).toBe(1)
        expect(unreached.counts).toEqual({ init: 0, mount: 0, unmount: 0, destroy: 0 })
        expect(app.status).toBe(ModuleStatus.Destroyed)
    })
})

// 12. Catch-up during the mount cascade
// ========================================
//
// `#mountTree` writes `mounted` BEFORE it walks its children, not after. The window that closes is narrow
// and entirely real: a lazy provider declared by a parent and first resolved from inside a DESCENDANT's
// mount hook is adopted by the parent, and `#catchUpParticipant` reads the parent's status to decide how
// far to catch it up. With the assignment after the cascade, that read landed on `initialized` — so the
// instance was inited and never mounted, on a module that was about to be `mounted`, and its onModuleMount
// was skipped for the whole of that mount's life while its onModuleUnmount would still pair against nothing.

describe("a lazy participant resolved mid-cascade", () => {
    it("catches up to `mounted` on the declaring parent, not to its pre-cascade status", async () => {
        const log: string[] = []
        const service = tracked(log, "L")
        const parent = makeApp({
            providers: [{ provide: service, useClass: service, lazy: true } as Provider],
        })

        // The resolve happens inside the CHILD's mount phase, which the parent's cascade drives — so the
        // parent is mid-mount at the moment its own lazy provider is first built.
        const child = makeChild(parent, {
            onModuleMount: (container) => {
                log.push("child:mount")
                container.resolve(service as never)
            },
        })
        child.mount()

        expect(log).toEqual([])

        parent.mount()

        // Both phases in the catch-up, in the cascade's own order. Before the reorder this was
        // `["child:mount", "L:ctor", "L:init"]` — no mount, permanently.
        expect(log).toEqual(["child:mount", "L:ctor", "L:init", "L:mount"])
        expect(service.counts).toEqual({ init: 1, mount: 1, unmount: 0, destroy: 0 })

        // And the pairing holds all the way out, which is what the missing mount used to break.
        parent.unmount()
        await parent.destroy()

        expect(service.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
    })
})

// 13. Late participation during destroy
// ========================================
//
// The corpse gate used to refuse `destroying` and `destroyed` alike, which silently dropped every lazy
// provider first resolved from inside a destroy hook — the one moment a teardown is most likely to build
// something. It now refuses `destroyed` only. A module that is still DRAINING adopts the late arrival and
// gives it the machine's own short path: `onModuleInit`, then the drain's `onModuleDestroy`, and neither
// mount hook, because it never mounted and is owed nothing on that side.
//
// Two halves make that work. The catch-up gets a `destroying` arm that stops at `initialized` and swallows a
// throw the way the drain does — the module is already going, and the asymmetry law says teardown runs to
// completion. And the drain RE-SCANS: its walk is a snapshot, so a participant appended behind the cursor
// would otherwise be left inited and never destroyed. Each pass can only add lazies from a finite singleton
// set, so the loop ends; recursion through a late participant's own hooks falls out of the re-scan.
//
// Resolution after the drain has finished is still refused — `lazy.test.ts` holds that half.

describe("a lazy participant resolved mid-drain", () => {
    it("lives the short path — onModuleInit, then its destroy, and neither mount hook", async () => {
        const log: string[] = []
        const late = tracked(log, "L")
        const app = makeApp({
            providers: [
                { provide: late, useClass: late, lazy: true } as Provider,
                {
                    provide: Symbol("resolver"),
                    useFactory: () => {
                        const owner = inject(Module)
                        return {
                            onModuleDestroy: () => {
                                log.push("R:destroy")
                                owner.container.resolve(late as never)
                            },
                        }
                    },
                },
            ],
        })
        app.mount()
        app.unmount()
        log.length = 0

        await app.destroy()

        // Built inside the resolver's hook, caught up to `initialized` only, and paired by the pass after.
        expect(log).toEqual(["R:destroy", "L:ctor", "L:init", "L:destroy"])
        expect(late.counts).toEqual({ init: 1, mount: 0, unmount: 0, destroy: 1 })
        expect(app.status).toBe(ModuleStatus.Destroyed)
    })

    it("catches up against a parent that is claimed but not yet drained", async () => {
        const log: string[] = []
        const late = tracked(log, "L")
        const parent = makeApp({
            providers: [{ provide: late, useClass: late, lazy: true } as Provider],
        })

        // The claim walk takes the whole subtree first, so the child drains while the parent is `destroying`
        // with its own drain still ahead of it. The lazy belongs to the parent, and the parent still owes it.
        const child = makeChild(parent, {
            onModuleDestroy: (container) => {
                log.push("child:destroy")
                container.resolve(late as never)
            },
        })
        child.mount()
        parent.mount()
        parent.unmount()
        log.length = 0

        await parent.destroy()

        expect(log).toEqual(["child:destroy", "L:ctor", "L:init", "L:destroy"])
        expect(late.counts).toEqual({ init: 1, mount: 0, unmount: 0, destroy: 1 })
        expect(parent.status).toBe(ModuleStatus.Destroyed)
    })

    it("re-enters the same rule from a late participant's own hooks, and still terminates", async () => {
        const log: string[] = []
        const L1 = Symbol("late-1")
        const L2 = Symbol("late-2")
        const L3 = Symbol("late-3")

        /** A lazy whose named hook resolves `next`, so each arrival can drag another one in behind it. */
        function chained(token: symbol, label: string, on: "init" | "destroy", next: symbol): Provider {
            return {
                provide: token,
                lazy: true,
                useFactory: () => {
                    const owner = inject(Module)
                    log.push(`${label}:ctor`)
                    return {
                        onModuleInit: () => {
                            log.push(`${label}:init`)
                            if (on === "init") owner.container.resolve(next)
                        },
                        onModuleDestroy: () => {
                            log.push(`${label}:destroy`)
                            if (on === "destroy") owner.container.resolve(next)
                        },
                    }
                },
            } as Provider
        }

        const app = makeApp({
            providers: [
                chained(L1, "L1", "init", L2),
                chained(L2, "L2", "destroy", L3),
                {
                    provide: L3,
                    lazy: true,
                    useFactory: () => {
                        log.push("L3:ctor")
                        return {
                            onModuleInit: () => log.push("L3:init"),
                            onModuleDestroy: () => log.push("L3:destroy"),
                        }
                    },
                },
                {
                    provide: Symbol("resolver"),
                    useFactory: () => {
                        const owner = inject(Module)
                        return {
                            onModuleDestroy: () => {
                                log.push("R:destroy")
                                owner.container.resolve(L1)
                            },
                        }
                    },
                },
            ],
        })
        app.mount()
        app.unmount()
        log.length = 0

        await app.destroy()

        // Three passes. The first drains the eager resolver, which builds L1, whose own init builds L2. The
        // second takes those two newest-first, and L2's destroy builds L3. The third takes L3, and the
        // fourth finds nothing left to take.
        expect(log).toEqual([
            "R:destroy",
            "L1:ctor",
            "L1:init",
            "L2:ctor",
            "L2:init",
            "L2:destroy",
            "L3:ctor",
            "L3:init",
            "L1:destroy",
            "L3:destroy",
        ])
        expect(app.status).toBe(ModuleStatus.Destroyed)
    })

    it("costs the participant and not the teardown when its late onModuleInit throws", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
        const log: string[] = []
        const late = tracked(log, "L", { throwOn: "init" })
        const app = makeApp({
            providers: [
                { provide: late, useClass: late, lazy: true } as Provider,
                {
                    provide: Symbol("resolver"),
                    useFactory: () => {
                        const owner = inject(Module)
                        return {
                            onModuleDestroy: () => {
                                log.push("R:enter")
                                owner.container.resolve(late as never)
                                log.push("R:exit")
                            },
                        }
                    },
                },
            ],
        })
        app.mount()
        app.unmount()
        log.length = 0

        await expect(app.destroy()).resolves.toBeUndefined()

        // The throw is swallowed at the catch-up, so the resolve returns and the hook that made it runs on.
        // The participant is `failed`, not `registered` — it RAN, so the drain still pairs it (see §11).
        expect(log).toEqual(["R:enter", "L:ctor", "R:exit", "L:destroy"])
        expect(late.counts).toEqual({ init: 0, mount: 0, unmount: 0, destroy: 1 })
        expect(errorSpy).toHaveBeenCalledWith("module.destroy", expect.any(Error))
        expect(app.status).toBe(ModuleStatus.Destroyed)

        errorSpy.mockRestore()
    })
})

// 14. Resolution before init
// ========================================
//
// The gate that gives `initializing` its reason to exist. A module's container refuses every read while the
// module's status is `created`, `failed` or `destroyed`, and serves `initializing` through `destroying` —
// resolution during the DRAIN is the late-participation feature of §13, not an accident to be closed, but a
// read after the drain has finished has nothing left to attach to and is refused at the ask.
//
// It is an ordinary `beforeResolution` hook, armed when the lifecycle is CONSTRUCTED rather than when it is
// inited: a read against a module whose participants were never collected is the thing being refused, so
// arming at init() would be arming after the horse has gone. Nothing about it is special-cased in the
// kernel — a hook that throws refuses the operation for every caller on that container, which is exactly
// the door this needs.
//
// Scoping falls out of the chain rule for free. Resolution events fire on the container the read was
// INITIATED from, so each module gates only the reads made against itself; a child asking for a token its
// parent owns is judged by the CHILD's status, and the parent's hook — which fires for the materialization,
// not the read — never gets a vote.

describe("resolution before init", () => {
    const TOKEN = Symbol("gated")

    it("refuses a read from a module that has not been armed, and serves it once armed", () => {
        const app = new App({ providers: [{ provide: TOKEN, useValue: "value" } as Provider] })

        expect(() => app.container.resolve(TOKEN)).toThrow(
            /Cannot resolve gated from a module whose status is "created"/
        )

        app.init()
        expect(app.container.resolve(TOKEN)).toBe("value")
    })

    it("refuses a read from a module whose init failed", () => {
        const log: string[] = []
        const app = new App({ providers: [tracked(log, "A", { throwOn: "init" })] })

        expect(() => app.init()).toThrow("A init")
        expect(app.status).toBe(ModuleStatus.Failed)

        expect(() => app.container.resolve(Module)).toThrow(
            /Cannot resolve Module from a module whose status is "failed"/
        )
    })

    it("still serves a read taken during the drain", async () => {
        const log: string[] = []
        const app = makeApp({
            providers: [{ provide: TOKEN, useClass: tracked(log, "L"), lazy: true } as Provider],
            onModuleDestroy: (container) => {
                container.resolve(TOKEN)
            },
        })

        await app.destroy()

        // `destroying` is inside the served range on purpose: §13's late participant arrives through a
        // resolve taken from a destroy hook, and a gate that refused it would delete that feature.
        expect(log).toEqual(["L:ctor", "L:init", "L:destroy"])
    })

    it("refuses a read once the drain has finished", async () => {
        const app = makeApp({ providers: [{ provide: TOKEN, useValue: "value" } as Provider] })
        expect(app.container.resolve(TOKEN)).toBe("value")

        await app.destroy()

        // The other side of the line the cell above draws. `destroying` is served because a destroy hook
        // resolving a lazy is the late-participation feature; `destroyed` is refused because there is no
        // phase left to pair an init with, so anything built here would be stranded the moment it existed.
        expect(() => app.container.resolve(TOKEN)).toThrow(
            /Cannot resolve gated from a module whose status is "destroyed"/
        )
    })

    it("gates a child's read on the CHILD's status, never the parent's", () => {
        const parent = makeApp({ providers: [{ provide: TOKEN, useValue: "parent" } as Provider] })
        parent.mount()

        const child = new Module(parent, {})

        // Same token, same instant, two containers — and the answer is decided by the module the read was
        // made against. The parent is mounted and serving; the child has not been armed.
        expect(parent.container.resolve(TOKEN)).toBe("parent")
        expect(() => child.container.resolve(TOKEN)).toThrow(
            /Cannot resolve gated from a module whose status is "created"/
        )

        child.init()
        expect(child.container.resolve(TOKEN)).toBe("parent")
    })
})

// 15. Guards with no other witness
// ========================================
//
// Three lines in the lifecycle that nothing else in the suite would notice the loss of. Each cell below is
// written so that DELETING the line it guards makes it fail — which is the only property that makes a
// regression pin worth its runtime.

describe("guards with no other witness", () => {
    it("does not write `mounted` back over a claim taken from inside the mount phase", async () => {
        // The guard: `#mountTree` writes `mounted` only `if (status !== Destroying)`. A destroy sent from a
        // provider's onModuleMount claims the module SYNCHRONOUSLY — `#claimSubtree` runs before `destroy()`
        // reaches its first await — and then the mount phase returns into that assignment.
        const log: string[] = []
        const reenter = once()
        let inFlight: Promise<void> | undefined

        const app = makeApp()
        const child = makeChild(app, {
            providers: [tracked(log, "C")],
            onModuleMount: (container) => {
                reenter(() => {
                    inFlight = container.resolve(Module).destroy()
                })
            },
        })
        app.mount()

        child.mount()

        // THE assertion that fails if the guard goes. By the time `mount()` returns the claim has happened
        // and the drain has not: an unguarded assignment would report `mounted` right here, and the drain
        // arriving later would still land on `destroyed`, so every other observation in this cell would look
        // identical. The corpse is only visible in this window.
        expect(child.status).toBe(ModuleStatus.Destroying)
        expect(child.status).not.toBe(ModuleStatus.Mounted)

        await inFlight

        expect(child.status).toBe(ModuleStatus.Destroyed)
        expect(app.children.has(child)).toBe(false)
        assertTreeInvariant(app)
    })

    it("rethrows a live module's catch-up failure to the caller that triggered it", async () => {
        // The guard: `#catchUpParticipant`'s catch marks the participant `failed`, reports it with the
        // module's id, and RETHROWS. The rethrow is what stops a resolve() handing back a half-built
        // instance whose onModuleInit threw; the id is what makes the report actionable in a tree.
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
        const log: string[] = []
        const TOKEN = Symbol("catch-up-failure")
        const service = tracked(log, "L", { throwOn: "init" })

        const app = makeApp({ providers: [{ provide: TOKEN, useClass: service, lazy: true } as Provider] })
        app.mount()

        expect(() => app.container.resolve(TOKEN)).toThrow("L init")

        expect(errorSpy).toHaveBeenCalledWith(
            `Lazy lifecycle catch-up failed in module ${app.id}.`,
            expect.objectContaining({ status: "failed" }),
            expect.any(Error)
        )

        // `failed` is not `registered`: the participant ran, so the drain still owes it a destroy.
        app.unmount()
        await app.destroy()

        expect(log).toEqual(["L:ctor", "L:destroy"])
        expect(service.counts).toEqual({ init: 0, mount: 0, unmount: 0, destroy: 1 })
    })

    it("reports the mount error and the rollback's own errors as one AggregateError", async () => {
        // The guard: mount()'s catch does not swallow the rollback. `A` mounts and then throws on the way
        // back out, so the unmount walk that rolls the failed mount back fails too — and both halves have
        // to reach the caller, or the visible error is the wrong one.
        const log: string[] = []
        const app = makeApp({
            providers: [tracked(log, "A", { throwOn: "unmount" }), tracked(log, "B", { throwOn: "mount" })],
        })

        let thrown: unknown
        try {
            app.mount()
        } catch (error) {
            thrown = error
        }

        expect(thrown).toBeInstanceOf(AggregateError)
        const aggregate = thrown as AggregateError
        expect(aggregate.message).toBe("Module mount failed and rollback encountered errors")

        // Mount error first, then whatever the rollback collected — `B` never mounted, so only `A` had an
        // unmount to fail.
        expect(aggregate.errors.map((error: Error) => error.message)).toEqual(["B mount", "A unmount"])
        expect(app.status).toBe(ModuleStatus.Failed)
    })
})

// 16. The unhealthy-tree walk
// ========================================
//
// The self-check in §14 asks whether THIS module can serve a read. This asks whether its branch can. After
// the self-check passes, the gate walks `parent` upward and refuses if any ancestor is `failed` or
// `destroyed` — the two states a module never comes back from. A `destroying` ancestor is SERVED, because a
// drain in progress is still a drain and §13's late participation happens inside one.
//
// What it closes: a read served under a spent ancestor builds an instance into a subtree whose owner has
// already gone. Materialization is reported to the OWNER (D53's chain rule), so a lazy owned by a failed
// parent was adopted BY the failed parent — a participant appended to a module whose phases are over, with
// no destroy left to pair against its init. The instance leaked for the process's lifetime.
//
// The walk is only affordable because the claim path stopped resolving: `#children()` reads
// `child.lifecycle` directly now. While it went through the container, refusing reads under a failed
// ancestor made a failed subtree UNDESTROYABLE — the claim's own read was refused — which is why this
// landed one round after it was first written.

describe("the unhealthy-tree walk", () => {
    const PARENT_LAZY = Symbol("branch.parent-lazy")
    const PARENT_EAGER = Symbol("branch.parent-eager")
    const CHILD_LOCAL = Symbol("branch.child-local")

    /** A mounted app over a parent whose own mount throws, with a child and grandchild built beneath it. */
    function poisonedBranch(log: string[]): { parent: Module; child: Module; grandchild: Module } {
        const app = makeApp()
        app.mount()

        const parent = makeChild(app, {
            providers: [
                tracked(log, "P", { throwOn: "mount" }),
                { provide: PARENT_EAGER, useValue: "eager" } as Provider,
                { provide: PARENT_LAZY, useClass: tracked(log, "L"), lazy: true } as Provider,
            ],
        })
        const child = makeChild(parent, { providers: [{ provide: CHILD_LOCAL, useValue: "local" } as Provider] })
        const grandchild = makeChild(child, {})

        // Warm the parent's eager singleton through the child while the branch is still healthy, so the
        // cache-hit case below is a genuine cache hit rather than a first construction.
        expect(child.container.resolve(PARENT_EAGER)).toBe("eager")

        grandchild.mount()
        child.mount()
        expect(() => parent.mount()).toThrow("P mount")
        expect(parent.status).toBe(ModuleStatus.Failed)

        return { parent, child, grandchild }
    }

    it("refuses a child's read of a lazy owned by its failed parent, building nothing", () => {
        const log: string[] = []
        const { parent, child } = poisonedBranch(log)
        log.length = 0

        // THE hole this closes. Materialization is reported to the OWNER, so this read used to construct
        // the lazy and adopt it into the FAILED parent — a participant on a module whose phases are over,
        // owed a destroy that will never run.
        expect(() => child.container.resolve(PARENT_LAZY)).toThrow(
            new RegExp(`unhealthy module tree — failed branch: ${parent.id}`)
        )

        // Refused at the ASK: no constructor ran, so there is nothing to have adopted.
        expect(log).toEqual([])
    })

    it("closes the whole branch, not just the reads that reach the failed module", () => {
        const log: string[] = []
        const { parent, child, grandchild } = poisonedBranch(log)
        const unhealthy = new RegExp(`unhealthy module tree — failed branch: ${parent.id}`)

        // A binding the CHILD owns outright, which never touches the parent's container.
        expect(() => child.container.resolve(CHILD_LOCAL)).toThrow(unhealthy)

        // And a CACHE HIT on the parent's eager singleton, built while the branch was still healthy. The
        // rule is binary and about the branch, not about what a given read would have had to build.
        expect(() => child.container.resolve(PARENT_EAGER)).toThrow(unhealthy)

        // Depth: the walk is recursive, so a grandchild two levels under the failure is closed too, and
        // names the same culprit rather than its own healthy parent.
        expect(() => grandchild.container.resolve(CHILD_LOCAL)).toThrow(unhealthy)
        expect(() => grandchild.container.resolve(PARENT_EAGER)).toThrow(unhealthy)
    })

    it("names the CULPRIT, not the module that asked", () => {
        const log: string[] = []
        const { parent, grandchild } = poisonedBranch(log)

        const thrown = (() => {
            try {
                grandchild.container.resolve(CHILD_LOCAL)
            } catch (error) {
                return (error as Error).message
            }
            return ""
        })()

        expect(thrown).toContain(parent.id)
        expect(thrown).not.toContain(grandchild.id)
    })

    it("leaves a healthy tree alone", () => {
        const log: string[] = []
        const app = makeApp()
        app.mount()

        const parent = makeChild(app, {
            providers: [
                { provide: PARENT_EAGER, useValue: "eager" } as Provider,
                { provide: PARENT_LAZY, useClass: tracked(log, "L"), lazy: true } as Provider,
            ],
        })
        const child = makeChild(parent, { providers: [{ provide: CHILD_LOCAL, useValue: "local" } as Provider] })
        child.mount()
        parent.mount()

        // The control. Same shape, nothing failed, every read served — including the lazy, which is
        // constructed on demand and adopted by the parent that owns it.
        expect(child.container.resolve(CHILD_LOCAL)).toBe("local")
        expect(child.container.resolve(PARENT_EAGER)).toBe("eager")
        expect(child.container.resolve(PARENT_LAZY)).toBeDefined()
        expect(log).toEqual(["L:ctor", "L:init", "L:mount"])
    })

    it("serves reads under an ancestor that is still DRAINING", async () => {
        const log: string[] = []
        const entered = deferredGate()
        const release = deferredGate()

        const Blocking = class {
            async onModuleDestroy(): Promise<void> {
                entered.resolve()
                await release.promise
            }
        }

        const app = makeApp()
        app.mount()
        const child = makeChild(app, {
            providers: [
                Blocking as unknown as Provider,
                { provide: CHILD_LOCAL, useValue: "local" } as Provider,
            ],
        })
        child.mount()

        app.unmount()
        const inFlight = app.destroy()
        await entered.promise

        // The blocker sits on the CHILD deliberately. `#claimSubtree` claims the whole subtree
        // synchronously and the drain runs children-first, so parking it on the app would leave the child
        // already `destroyed` by the time the app's own hook ran — its SELF-check would refuse and the walk
        // would never be consulted. Blocking the child holds both levels in `destroying` at once, which is
        // the only window where the walk's `destroying` arm is the thing under test.
        expect(app.status).toBe(ModuleStatus.Destroying)
        expect(child.status).toBe(ModuleStatus.Destroying)

        // Served, both levels: §13's late participation happens inside exactly this window, and refusing
        // here would delete that feature rather than protect anything.
        expect(child.container.resolve(CHILD_LOCAL)).toBe("local")

        release.resolve()
        await inFlight
    })
})

function deferredGate(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void
    const promise = new Promise<void>((settle) => {
        resolve = settle
    })
    return { promise, resolve }
}
