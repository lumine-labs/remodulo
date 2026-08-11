import { beforeAll, describe, expect, it } from "vitest"

import { App, Module } from "../../src/core/module.js"
import { PropsRef } from "../../src/primitives/props-ref.js"
import { EAGER, exercise, makeProviders } from "./fixtures.js"
import { HeapTrend, LeakTracker, assertGcEnabled, forceGc, scrub, settle } from "./gc.js"

// Core-level leak detection
// ========================================
//
// The owner's scenario, driven straight against the classes, x1000:
//
//     mount → resolve providers → trigger lazy provider construction → rebuild → unmount
//
// "rebuild" at this level is what `ModuleProvider` actually does: construct a second `Module` from the same
// parent, init/mount it, then unmount + destroy the first. The generations overlap exactly as they do in
// React, which is the only way the hand-off can be caught retaining the old one.
//
// Every iteration runs inside `scenario()`. That is load-bearing, not style: locals of a live frame are
// reachable by definition, so a loop that inlined this would assert nothing.

const ITERATIONS = 1000
const SAMPLE_EVERY = 250

describe("core: mount → resolve → lazy → rebuild → unmount, x1000", () => {
    beforeAll(() => {
        assertGcEnabled()
    })

    it("leaves no Module, Container, provider instance, PropsRef or subscriber reachable", async () => {
        const tracker = new LeakTracker()
        const trend = new HeapTrend()
        const childrenAfterRebuild = new Set<number>()
        const childrenAfterTeardown = new Set<number>()

        await trend.sample(0)

        for (let i = 1; i <= ITERATIONS; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            const observed = await scenario(tracker)
            childrenAfterRebuild.add(observed.duringRebuild)
            childrenAfterTeardown.add(observed.afterTeardown)

            if (i % SAMPLE_EVERY === 0) {
                // eslint-disable-next-line no-await-in-loop
                await trend.sample(i)
            }
        }

        await scrub(() => scenario(new LeakTracker()))

        const alive = tracker.aliveByLabel()

        // Diagnostics land in the runner output whether or not the assertions hold.
        console.log(`\n[core x${ITERATIONS}] ${trend.report()}\n${tracker.report()}\n`)

        // The real check.
        expect(alive).toEqual({})

        // Parent/child bookkeeping: during the overlap the parent holds exactly the two live generations,
        // and after each generation destroys itself the parent's children set is empty again.
        expect([...childrenAfterRebuild]).toEqual([2])
        expect([...childrenAfterTeardown]).toEqual([0])

        // Smoke alarms. Generous on purpose — the WeakRef assertion above is the verdict. A run that
        // retained its instances would add ~160MB of payload here; healthy drift measures ~2-5MB.
        expect(trend.ratio).toBeLessThan(3)
        expect(trend.growthMB).toBeLessThan(25)
    }, 180_000)

    it("does not accumulate dead children on a long-lived parent", async () => {
        const tracker = new LeakTracker()
        // The parent's own instances go to a throwaway tracker: they are meant to stay alive for the whole
        // test, and mixing them into `tracker` would show up as a permanent survivor in the report.
        const app = new App({ providers: makeProviders(new LeakTracker()) })
        app.init()
        app.mount()

        for (let i = 0; i < ITERATIONS; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            await generation(tracker, app)
        }

        // The parent is still alive and still holds its own instances; only the children should be gone.
        await scrub(() => generation(new LeakTracker(), app))

        const alive = tracker.aliveByLabel()
        console.log(`\n[long-lived parent x${ITERATIONS}]\n${tracker.report()}\n`)

        expect(app.children.size).toBe(0)
        expect(alive.Module ?? 0).toBe(0)
        expect(alive.Container ?? 0).toBe(0)

        app.unmount()
        await app.destroy()
    }, 180_000)
})

// Scenario
// ========================================

type Observed = { duringRebuild: number; afterTeardown: number }

async function scenario(tracker: LeakTracker): Promise<Observed> {
    const app = tracker.track("App", new App({ providers: makeProviders(tracker) }))
    tracker.track("Container", app.container)
    app.init()
    app.mount()

    // mount → resolve providers → trigger lazy provider construction
    const first = tracker.track("Module", new Module(app, { providers: makeProviders(tracker) }))
    tracker.track("Container", first.container)
    first.init()
    first.mount()
    exercise(tracker, first)

    // rebuild — the replacement is built and mounted while the outgoing generation is still attached,
    // then the old one is unmounted and destroyed. Exactly ModuleProvider's swap.
    const second = tracker.track("Module", new Module(app, { providers: makeProviders(tracker) }))
    tracker.track("Container", second.container)
    second.init()
    second.mount()
    exercise(tracker, second, 2)

    const duringRebuild = app.children.size
    first.unmount()
    await first.destroy()

    // unmount
    second.unmount()
    await second.destroy()

    const afterTeardown = app.children.size

    app.unmount()
    await app.destroy()

    return { duringRebuild, afterTeardown }
}

/** One child generation under a parent that outlives it. */
async function generation(tracker: LeakTracker, parent: App): Promise<void> {
    const child = tracker.track("Module", new Module(parent, { providers: makeProviders(tracker) }))
    tracker.track("Container", child.container)
    child.init()
    child.mount()
    exercise(tracker, child)

    child.unmount()
    await child.destroy()
}

// PropsRef that outlives the module
// ========================================
//
// `usePropsRef` pins its PropsRef with `useState`, so the instance survives every rebuild of the module it
// is registered into. That makes it the one object in the graph that can outlive a generation while still
// holding a reference into it — the subscriber set.

describe("core: PropsRef across generations", () => {
    beforeAll(() => {
        assertGcEnabled()
    })

    it("releases a generation whose subscriber unsubscribed on destroy", async () => {
        const tracker = new LeakTracker()
        const props = new PropsRef<{ n: number }>({ props: { n: 0 } })
        const app = new App()
        app.init()
        app.mount()

        for (let i = 0; i < 200; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            await subscribingGeneration(tracker, app, props, true, i)
        }

        await scrub(() => subscribingGeneration(new LeakTracker(), app, props, true, 0))

        console.log(`\n[PropsRef, subscriber released]\n${tracker.report()}\n`)
        expect(tracker.aliveByLabel()).toEqual({})

        app.unmount()
        await app.destroy()
    }, 120_000)
})

async function subscribingGeneration(
    tracker: LeakTracker,
    parent: App,
    props: PropsRef<{ n: number }>,
    release: boolean,
    n: number
): Promise<void> {
    const child = tracker.track("Module", new Module(parent, { providers: makeProviders(tracker, props) }))
    tracker.track("Container", child.container)
    child.init()
    child.mount()

    const service = child.container.resolve<{ peer: unknown }>(EAGER)
    const subscriber = tracker.track("Subscriber", (next: { n: number }) => {
        service.peer = next
    })
    const off = props.onUpdate(subscriber)
    props.update({ n })

    child.unmount()
    await child.destroy()

    if (release) off()
}
