import { act, cleanup, render } from "@testing-library/react"
import { beforeAll, describe, expect, it } from "vitest"
import { useEffect, type ReactNode } from "react"

import type { Provider } from "../../src/core/provider.types.js"
import { App, type Module } from "../../src/core/module.js"
import { ModuleStatus } from "../../src/core/module-lifecycle.types.js"
import { PropsRef } from "../../src/primitives/props-ref.js"
import { AppProvider } from "../../src/react/AppProvider.js"
import { createModuleComponent } from "../../src/react/createModuleComponent.js"
import { useModule, useModuleRebuild } from "../../src/react/useModuleContext.js"
import { useResolve } from "../../src/react/useResolve.js"
import { EAGER, LAZY, makeProviders, type EagerService, type LazyService } from "./fixtures.js"
import { HeapTrend, LeakTracker, assertGcEnabled, scrub, settle } from "./gc.js"

// React-level leak detection
// ========================================
//
// The same scenario through the real React surface — `AppProvider` → `createModuleComponent` →
// `ModuleProvider` → `useResolve` — at x100 rather than x1000, because each iteration is four `act()`
// flushes through jsdom rather than a handful of container calls. Going through the factory rather than a
// bare `ModuleProvider` is the point: it brings in `usePropsRef`, whose PropsRef is pinned by `useState`
// and therefore outlives every rebuild of the module it is registered into.

const ITERATIONS = 100
const SAMPLE_EVERY = 25

type Hold = { rebuild: (() => void) | null }
type Track = <T extends object>(label: string, value: T) => T

describe("react: mount → resolve → lazy → rebuild → unmount, x100", () => {
    beforeAll(() => {
        assertGcEnabled()
    })

    it("leaves no App, Module, Container, provider instance, PropsRef or subscriber reachable", async () => {
        const tracker = new LeakTracker()
        const trend = new HeapTrend()

        await trend.sample(0)

        for (let i = 1; i <= ITERATIONS; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            await cycle(tracker)

            if (i % SAMPLE_EVERY === 0) {
                // eslint-disable-next-line no-await-in-loop
                await trend.sample(i)
            }
        }

        await scrub(() => cycle(new LeakTracker()), 3)

        const alive = tracker.aliveByLabel()
        console.log(`\n[react x${ITERATIONS}] ${trend.report()}\n${tracker.report()}\n`)

        expect(alive).toEqual({})

        // Smoke alarms; the WeakRef assertion above is the verdict. 100 cycles of retained fibers,
        // containers and payloads would add ~15MB+ on top of a ~54MB jsdom baseline.
        expect(trend.ratio).toBeLessThan(3)
        expect(trend.growthMB).toBeLessThan(15)
    }, 300_000)
})

// One mount/rebuild/unmount cycle
// ========================================

async function cycle(tracker: LeakTracker): Promise<void> {
    const track: Track = (label, value) => tracker.track(label, value)

    const app = tracker.track("App", new App())
    tracker.track("Container", app.container)

    const hold: Hold = { rebuild: null }
    // `null`: createModuleComponent auto-registers the PropsRef itself, and one token takes one binding.
    const make = (): Provider[] => makeProviders(tracker, null)

    // mount → resolve providers → trigger lazy provider construction (all three inside <Probe/>)
    const view = render(
        <AppProvider app={app}>
            <Feature n={0} make={make}>
                <Probe track={track} hold={hold} />
            </Feature>
        </AppProvider>
    )

    // rebuild
    act(() => hold.rebuild?.())
    await settle()

    // a props change through the auto-bridged PropsRef, so the surviving ref has actually notified the
    // subscriber belonging to the post-rebuild generation
    view.rerender(
        <AppProvider app={app}>
            <Feature n={1} make={make}>
                <Probe track={track} hold={hold} />
            </Feature>
        </AppProvider>
    )

    // unmount — ModuleProvider unmounts and destroys the module; nobody awaits that promise, hence settle()
    view.unmount()
    cleanup()
    await settle()

    hold.rebuild = null

    // `AppProvider`'s cleanup already unmounted and destroyed the App, and `settle()` above waited for the
    // deferred destroy to land — so the belt-and-braces `app.destroy()` this used to end on is now a
    // refusal. Asserting the arc completed is the stronger check anyway: if React ever stopped destroying
    // the App, this line would fail here rather than being silently papered over by a manual destroy.
    expect(app.status).toBe(ModuleStatus.Destroyed)
}

// Components
// ========================================

const Feature = createModuleComponent<{ n: number; make: () => Provider[] }>((props) => ({
    providers: props.make(),
}))

function Probe({ track, hold }: { track: Track; hold: Hold }): ReactNode {
    const module: Module = useModule()
    hold.rebuild = useModuleRebuild()

    const eager = useResolve<EagerService>(EAGER)
    // Resolving the lazy token here is what constructs it — it is skipped by the module's eager pass.
    const lazy = useResolve<LazyService>(LAZY)
    const props = useResolve<PropsRef<{ n: number }>>(PropsRef)

    useEffect(() => {
        track("Module", module)
        track("Container", module.container)
        track("PropsRef", props)

        const subscriber = track("Subscriber", (next: { n: number }) => {
            eager.peer = next.n === lazy.payload.length ? lazy : eager
        })

        return props.onUpdate(subscriber)
    }, [track, module, props, eager, lazy])

    return <span>{lazy.payload.length}</span>
}
