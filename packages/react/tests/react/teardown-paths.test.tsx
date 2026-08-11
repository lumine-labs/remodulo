import { act, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { StrictMode, type ReactNode } from "react"

import { App, Module } from "../../src/core/module.js"
import { ModuleStatus } from "../../src/core/module-lifecycle.types.js"
import { AppProvider } from "../../src/react/AppProvider.js"
import { ModuleProvider } from "../../src/react/ModuleProvider.js"
import { useModuleContext } from "../../src/react/useModuleContext.js"
import type { Provider } from "../../src/types.js"
import { Root, svc } from "../setup/react.js"
import { refuses } from "../setup/helpers.js"
import { assertTreeInvariant } from "../setup/invariants.js"

// The teardown and failure paths React drives.
// ========================================
//
// Everything here is reached through the React layer rather than through the imperative API, because the
// interleavings only exist there: a deferred destroy landing on a module an ancestor already claimed, an
// effect that throws mid-cascade, a component that re-renders over a module which failed its init.

// The mount race, and why nothing here gates it.
// ========================================
//
// RULED OUT OF SCOPE by the owner, recorded so a future reader finds the ruling rather than the hole. The
// shape is real on paper: the destroy timer fires a macrotask after the cleanup, so a module could in
// principle be claimed between a parent's teardown and a child's re-setup, and `mount()` would then be
// asked to attach onto a dead parent. It is unreachable in supported usage, and the three ways to reach it
// are each unsupported by design rather than by omission:
//
//   * `<Activity>` is not supported, ever — a long hide buries its module and the reveal is refused
//     (`environment-torture`), which is the ruling, not a bug to fix;
//   * `<Suspense>` ABOVE a `<ModuleProvider>` is not supported — see the three cases below;
//   * `<StrictMode>` cannot interleave the timer at all — its double-invoke is synchronous, so no
//     macrotask can land between the two halves.
//
// So mount-onto-a-dead-parent is deliberately ungated. Adding a gate would buy a guarantee for
// configurations the library already declines to support, and cost a check on every mount.
//
// THE SUSPENSE RULE, ruled by the owner: a ModuleProvider must never be hidden after it has committed;
// anything that only delays its first mount is supported. Three cases settle every arrangement:
//
//   ILLEGAL  <Suspense><ModuleProvider><LazyChild/></ModuleProvider></Suspense>
//            Suspendable content directly inside a module suspends a boundary ABOVE the provider, which
//            hides a committed module tree — the unsupported hide/reveal path. Doctrine, not a target:
//            deliberately UNTESTED as a supported shape. What it costs when done anyway is measured in
//            `integration-torture`'s "Suspense at module level", where each retry compounds an abandoned
//            generation that is inited and never destroyed.
//
//   LEGAL    <Suspense><ModuleProvider><Suspense><LazyChild/></Suspense></ModuleProvider></Suspense>
//            The inner boundary absorbs it, so the provider commits and is never hidden by its own
//            content.
//
//   LEGAL    const Wrapper = React.lazy(...) rendering <ModuleProvider>…</ModuleProvider>, under
//            <Suspense>. The suspension precedes the provider's existence — there is no module to hide.
//
// Both legal shapes are pinned in `integration-torture`, "the supported Suspense shapes".

describe("the deferred destroy timer", () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it("fires on a module an ancestor already claimed, and does not throw", async () => {
        const log: string[] = []
        let child: Module | undefined

        function Capture(): ReactNode {
            child = useModuleContext().module
            return null
        }

        const view = render(
            <Root providers={[svc(log, "A")]}>
                <ModuleProvider providers={[svc(log, "C")]}>
                    <Capture />
                </ModuleProvider>
            </Root>
        )

        expect(child).toBeInstanceOf(Module)

        // React tears the tree down from the top, so both modules get a cleanup and both schedule a
        // destroy. The App's claim walk takes the child with it, so by the time the CHILD's own timer
        // fires there is nothing left for it to claim.
        act(() => {
            view.unmount()
        })

        expect(() => {
            act(() => {
                vi.runAllTimers()
            })
        }).not.toThrow()

        // Awaiting drains the destroy promises the timers started.
        await act(async () => {
            await Promise.resolve()
        })

        expect(child?.status).toBe(ModuleStatus.Destroyed)
        expect(log).toEqual(["A:init", "C:init", "A:mount", "C:mount", "C:unmount", "A:unmount", "C:destroy", "A:destroy"])
    })

    it("never stacks two timers on one module", async () => {
        const clearSpy = vi.spyOn(globalThis, "clearTimeout")
        const log: string[] = []

        // StrictMode runs setup → cleanup → setup on the SAME module, so the module sees two cleanups
        // across its life with a setup in between. Each cleanup schedules; each setup cancels.
        const view = render(
            <StrictMode>
                <Root providers={[svc(log, "A")]} />
            </StrictMode>
        )

        act(() => {
            view.unmount()
        })

        // The whole point of `cancelDestroy` running first inside `scheduleDestroy`: an older handle would
        // otherwise be unreachable and uncancellable, and the module would be claimed by whichever timer
        // won. One module, one live timer.
        expect(clearSpy).toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(1)

        act(() => {
            vi.runAllTimers()
        })
        await act(async () => {
            await Promise.resolve()
        })

        // And exactly one drain came out of it.
        expect(log.filter((entry) => entry === "A:destroy")).toHaveLength(1)
    })
})

describe("a cascade that throws in the React layer", () => {
    it("surfaces the child's mount failure and leaves nothing mounted under an unmounted parent", async () => {
        const log: string[] = []
        const Boom = class {
            onModuleMount(): void {
                throw new Error("child mount failed")
            }
        }

        let app: App | undefined
        function CaptureApp(): ReactNode {
            app = useModuleContext().module as App
            return null
        }

        // `useModuleLifecycle` mounts inside an effect, so the child's throw leaves the commit — with no
        // boundary in the path the throw IS the report, which is this suite's established measurement.
        expect(() =>
            render(
                <Root providers={[svc(log, "A")]}>
                    <CaptureApp />
                    <ModuleProvider providers={[Boom as unknown as Provider]}>
                        <div />
                    </ModuleProvider>
                </Root>
            )
        ).toThrow("child mount failed")

        expect(app).toBeInstanceOf(App)

        // The invariant that matters after a failed cascade: no live island. A module whose mount threw is
        // detached and rolled back, so nothing mounted can be hanging off something that is not.
        assertTreeInvariant(app as App)
    })
})


// Probes
// ========================================

function silenceReactErrorLog(): () => void {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    return () => spy.mockRestore()
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void
    const promise = new Promise<void>((settle) => {
        resolve = settle
    })
    return { promise, resolve }
}

describe("AppProvider over an App it cannot serve", () => {
    /** React reports a recovered render error through `onRecoverableError`; capture it so nothing escapes. */
    function collectRecoverable(): { seen: unknown[]; options: { onRecoverableError: (error: unknown) => void } } {
        const seen: unknown[] = []
        return { seen, options: { onRecoverableError: (error: unknown) => seen.push(error) } }
    }

    it("logs the original cause, then refuses every render after it", () => {
        const logged: unknown[] = []
        const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
            logged.push(...args)
        })
        const { seen, options } = collectRecoverable()

        const cause = new Error("app init failed")
        const app = new App({
            onModuleInit: () => {
                throw cause
            },
        })
        const tree = (
            <AppProvider app={app}>
                <div />
            </AppProvider>
        )

        expect(() => render(tree, options)).toThrow("App failed to initialize.")
        expect(app.status).toBe(ModuleStatus.Failed)

        // THE channel, and the reason the arming is wrapped. React discards the attempt that threw, and it
        // only reports a discarded error when the retry RECOVERS — which never happens now, because the
        // retry refuses. So React's own bookkeeping carries nothing (`seen` is empty, measured), and
        // `AppProvider` logs the cause itself on the way past. Without that line the consumer's own error
        // would reach them through no channel at all.
        //
        // Two arguments: a label, then the thrown object ITSELF rather than a formatted string, so a
        // consumer's `instanceof` check and their stack both survive the trip. The reference identity of
        // the second argument is the half that matters.
        expect(logged).toHaveLength(2)
        expect(logged[0]).toBe("App failed to initialize:")
        expect(logged[1]).toBe(cause)
        expect(seen).toEqual([])

        // `failed` is sticky and nothing re-arms it, so every later render refuses the same way — never the
        // gate's `Cannot init() a module whose status is "failed"`, which would bury the cause.
        expect(() => render(tree, options)).toThrow("App failed to initialize.")

        // And the cause is logged ONCE across both renders, not once per render or once per StrictMode
        // pass: only the attempt that found the App `created` ever reaches the arming block.
        expect(logged).toHaveLength(2)
        expect(logged[1]).toBe(cause)

        spy.mockRestore()
    })

    it("logs the cause exactly once under StrictMode, which double-invokes the render body", () => {
        const logged: unknown[] = []
        const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
            logged.push(...args)
        })
        const { options } = collectRecoverable()

        const cause = new Error("strict init failed")
        const app = new App({
            onModuleInit: () => {
                throw cause
            },
        })

        expect(() =>
            render(
                <StrictMode>
                    <AppProvider app={app}>
                        <div />
                    </AppProvider>
                </StrictMode>,
                options
            )
        ).toThrow("App failed to initialize.")

        // MEASURED rather than reasoned: StrictMode double-invokes the render body, but the second
        // invocation never happens when the first one throws, and every attempt after this one finds the
        // App `failed` and stops at the refusal above the arming block. One cause, logged once — as one
        // two-argument call, not two calls.
        expect(logged).toHaveLength(2)
        expect(logged[1]).toBe(cause)

        spy.mockRestore()
    })

    it("refuses a destroyed App rather than reviving it", async () => {
        const restore = silenceReactErrorLog()
        const { options } = collectRecoverable()

        const app = new App()
        app.init()
        await app.destroy()
        expect(app.status).toBe(ModuleStatus.Destroyed)

        expect(() =>
            render(
                <AppProvider app={app}>
                    <div />
                </AppProvider>,
                options
            )
        ).toThrow("App was destroyed. Provide a fresh App.")

        restore()
    })

    it("refuses an App still draining, before the claim has settled", async () => {
        const restore = silenceReactErrorLog()
        const { options } = collectRecoverable()

        // Parked mid-drain: the claim is synchronous, the hook is not, so the App sits in `destroying`.
        const entered = deferred()
        const release = deferred()
        const Blocking = class {
            async onModuleDestroy(): Promise<void> {
                entered.resolve()
                await release.promise
            }
        }

        const app = new App({ providers: [Blocking as unknown as Provider] })
        app.init()
        const inFlight = app.destroy()
        await entered.promise
        expect(app.status).toBe(ModuleStatus.Destroying)

        // Same refusal as a settled corpse: a claim is permanent, so there is nothing to wait for.
        expect(() =>
            render(
                <AppProvider app={app}>
                    <div />
                </AppProvider>,
                options
            )
        ).toThrow("App was destroyed. Provide a fresh App.")

        release.resolve()
        await inFlight
        restore()
    })
})
