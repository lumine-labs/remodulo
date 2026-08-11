import { beforeAll, describe, expect, it } from "vitest"

import { App, Module } from "../../src/core/module.js"
import { PropsRef } from "../../src/primitives/props-ref.js"
import { EAGER, exercise, makeProviders, type EagerService } from "./fixtures.js"
import { LeakTracker, assertGcEnabled, forceGc, scrub, settle } from "./gc.js"

// Reference hazards
// ========================================
//
// The churn suites answer "does the happy path leak". These answer "which edge would leak if it did" —
// one focused probe per structure that holds a reference across a teardown boundary. Each keeps exactly
// one thing alive and drops the rest, so a survivor names its own retaining edge.

describe("hazard: parent Module's children set", () => {
    beforeAll(() => {
        assertGcEnabled()
    })

    it("drops a destroyed child while the parent stays alive", async () => {
        const tracker = new LeakTracker()
        const app = new App()
        app.init()
        app.mount()

        await childGeneration(tracker, app)

        expect(app.children.size).toBe(0)

        await scrub(() => childGeneration(new LeakTracker(), app), 3)

        // `ModuleLifecycle.#claimSubtree` calls `parent.removeChild(child)` synchronously at the top of
        // destroy(). Without it the parent's Set would pin every dead generation.
        expect(tracker.aliveByLabel()).toEqual({})

        app.unmount()
        await app.destroy()
    }, 60_000)

    it("still holds a child that was mounted but never destroyed", async () => {
        // The negative control: `unmount()` does not detach — only destroy() does. If this ever starts
        // reporting 0 children, detach has moved and the test above stopped proving anything.
        const app = new App()
        app.init()
        app.mount()

        const child = new Module(app, {})
        child.init()
        child.mount()
        child.unmount()

        expect(app.children.size).toBe(1)

        await child.destroy()
        expect(app.children.size).toBe(0)

        app.unmount()
        await app.destroy()
    })
})

describe("hazard: ModuleLifecycle's collected-instance list", () => {
    beforeAll(() => {
        assertGcEnabled()
    })

    it("KNOWN DEFECT: a destroyed module that is still referenced pins every singleton it built", async () => {
        const tracker = new LeakTracker()
        const corpse = await destroyedButHeld(tracker)

        await settle()
        await forceGc(8)

        const alive = tracker.aliveByLabel()
        console.log(`\n[hazard: instance list after destroy] held module id=${corpse.id}\n${tracker.report()}\n`)

        // There were TWO retaining edges here. `#runDestroyPhase` now clears its map in a `finally`, so
        //     Module → #lifecycle (ModuleLifecycle) → #participants (Map) → every adopted instance
        // is cut whether teardown succeeded or threw. The second one survives:
        //     Module → container (Container) → the entry's singleton cache → the instance
        // destroy() detaches the module from its parent and runs the hooks, but it never unbinds or
        // disposes the container, so `container.resolve(TOKEN)` after destroy still returns the identical
        // pre-destroy instance. Nothing in the shipped React path holds a destroyed module (ModuleProvider
        // swaps its state and drops the old one), so this is latent rather than an observed leak — but any
        // consumer that keeps a Module in a ref, a log or a devtools panel keeps its whole object graph.
        // The fix is container teardown in #runDestroyPhase, not another Set to clear.
        expect(alive.EagerService ?? 0).toBe(1)
        expect(alive.LazyService ?? 0).toBe(1)
    }, 60_000)

    it("releases those same instances once the destroyed module itself is dropped", async () => {
        const tracker = new LeakTracker()

        await destroyedAndDropped(tracker)
        await scrub(() => destroyedAndDropped(new LeakTracker()), 3)

        expect(tracker.aliveByLabel()).toEqual({})
    }, 60_000)
})

describe("hazard: the module's container-level hook", () => {
    beforeAll(() => {
        assertGcEnabled()
    })

    it("collects an abandoned container, its bindings and its hook without destroy()", async () => {
        const tracker = new LeakTracker()

        // `#collectParticipants` arms one `afterMaterialize` hook whose closure captures the
        // ModuleLifecycle, which reaches the Module, which reaches the Container the hook rides on. That is
        // a cycle — fine for a tracing collector, fatal for refcounting. The hook is never disposed, so its
        // lifetime IS the container's; abandoning the module without ever calling destroy() is the sharpest
        // way to ask whether that retains anything.
        await abandoned(tracker)
        await scrub(() => abandoned(new LeakTracker()), 3)

        console.log(`\n[hazard: abandoned container]\n${tracker.report()}\n`)
        expect(tracker.aliveByLabel()).toEqual({})
    }, 60_000)
})

describe("hazard: PropsRef subscriptions from a destroyed generation", () => {
    beforeAll(() => {
        assertGcEnabled()
    })

    it("releases the generation when the subscriber unsubscribes", async () => {
        const tracker = new LeakTracker()
        const props = new PropsRef<{ n: number }>({ props: { n: 0 } })
        const app = new App()
        app.init()
        app.mount()

        await subscribedGeneration(tracker, app, props, true)
        await scrub(() => subscribedGeneration(new LeakTracker(), app, props, true), 3)

        expect(tracker.aliveByLabel()).toEqual({})

        app.unmount()
        await app.destroy()
    }, 60_000)

    it("KNOWN DEFECT (caller-side): a subscriber left behind pins the dead generation's instance", async () => {
        const tracker = new LeakTracker()
        const props = new PropsRef<{ n: number }>({ props: { n: 0 } })
        const app = new App()
        app.init()
        app.mount()

        for (let i = 0; i < 25; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            await subscribedGeneration(tracker, app, props, false)
        }

        await settle()
        await forceGc(8)

        const alive = tracker.aliveByLabel()
        console.log(`\n[hazard: PropsRef subscriber not released]\n${tracker.report()}\n`)

        // Retaining edge:
        //     PropsRef (pinned by usePropsRef's useState, survives every rebuild)
        //       → #subscribers (Set) → subscriber closure → the destroyed generation's instance
        // Module destroy does not touch PropsRef — it cannot, the ref is owned by the component, not the
        // module. So this is the caller's contract: whatever subscribes must unsubscribe in
        // onModuleUnmount/onModuleDestroy. Worth pinning because it is the one edge in the graph that
        // survives a rebuild by design, and 25 generations leak 25 payloads with zero symptoms.
        expect(alive.Subscriber ?? 0).toBe(25)
        expect(alive.EagerService ?? 0).toBe(25)

        app.unmount()
        await app.destroy()
    }, 60_000)
})

// Probes
// ========================================

async function childGeneration(tracker: LeakTracker, parent: App): Promise<void> {
    const child = tracker.track("Module", new Module(parent, { providers: makeProviders(tracker) }))
    tracker.track("Container", child.container)
    child.init()
    child.mount()
    exercise(tracker, child)

    child.unmount()
    await child.destroy()
}

/** Returns the destroyed module so the caller keeps it reachable — the whole point of the probe. */
async function destroyedButHeld(tracker: LeakTracker): Promise<App> {
    const app = new App({ providers: makeProviders(tracker) })
    app.init()
    app.mount()
    exercise(tracker, app)

    app.unmount()
    await app.destroy()

    return app
}

async function destroyedAndDropped(tracker: LeakTracker): Promise<void> {
    const app = tracker.track("App", new App({ providers: makeProviders(tracker) }))
    tracker.track("Container", app.container)
    app.init()
    app.mount()
    exercise(tracker, app)

    app.unmount()
    await app.destroy()
}

/** Built, mounted, resolved — then simply dropped. No unmount, no destroy. */
async function abandoned(tracker: LeakTracker): Promise<void> {
    const app = tracker.track("App", new App({ providers: makeProviders(tracker) }))
    tracker.track("Container", app.container)
    app.init()
    app.mount()

    const child = tracker.track("Module", new Module(app, { providers: makeProviders(tracker) }))
    tracker.track("Container", child.container)
    child.init()
    child.mount()
    exercise(tracker, child)

    await settle()
}

async function subscribedGeneration(
    tracker: LeakTracker,
    parent: App,
    props: PropsRef<{ n: number }>,
    release: boolean
): Promise<void> {
    const child = tracker.track("Module", new Module(parent, { providers: makeProviders(tracker, props) }))
    tracker.track("Container", child.container)
    child.init()
    child.mount()

    const service = child.container.resolve<EagerService>(EAGER)
    const subscriber = tracker.track("Subscriber", (next: { n: number }) => {
        service.peer = next
    })
    const off = props.onUpdate(subscriber)
    props.update({ n: props.current.n + 1 })

    child.unmount()
    await child.destroy()

    if (release) off()
}
