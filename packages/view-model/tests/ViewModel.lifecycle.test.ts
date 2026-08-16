import { App, Module } from "@remodulo/react/core"
import { describe, expect, it } from "vitest"

import { ViewModel } from "../src/ViewModel"

// ViewModel driven by the REAL module lifecycle
// ========================================
//
// The suite beside this one drives the hooks by hand, which pins what they do but not that the module
// calls them the way they assume. These cells go through `App`/`Module` instead, and each one mirrors a
// reproduction that failed before the fix: an async `onDestroy` whose work landed after `destroy()` had
// already resolved, and a remount that stacked a second subscription because nothing released at unmount.

describe("ViewModel: async onDestroy through the drain", () => {
    it("completes before `await app.destroy()` resolves", async () => {
        const log: string[] = []

        class Async extends ViewModel {
            protected override async onDestroy(): Promise<void> {
                log.push("onDestroy start")
                await new Promise((resolve) => setTimeout(resolve, 20))
                log.push("onDestroy end")
            }
        }

        const app = new App({ providers: [Async] })
        app.init()
        app.mount()
        app.resolver.resolve(Async)
        app.unmount()

        await app.destroy()
        log.push("destroy() returned")

        // The whole point: the awaited work is finished BEFORE the caller's await comes back. Dropping the
        // promise put "destroy() returned" in the middle of this list.
        expect(log).toEqual(["onDestroy start", "onDestroy end", "destroy() returned"])
    })

    it("still releases tracked disposers when an async onDestroy rejects", async () => {
        const log: string[] = []

        class Failing extends ViewModel {
            protected override onInit(): void {
                this.track(() => log.push("disposer"))
            }
            protected override async onDestroy(): Promise<void> {
                await Promise.resolve()
                throw new Error("async destroy blew up")
            }
        }

        const app = new App({ providers: [Failing] })
        app.init()
        app.resolver.resolve(Failing)

        // The drain contains a participant's failure rather than abandoning the rest of the teardown, so
        // the module still comes down — and the `finally` still ran.
        await app.destroy()

        expect(log).toEqual(["disposer"])
    })
})

describe("ViewModel: remount through the real lifecycle", () => {
    it("keeps one live subscription across a mount/unmount/mount/unmount cycle", async () => {
        let live = 0
        const peaks: number[] = []

        class Subscriber extends ViewModel {
            protected override onMount(): void {
                live += 1
                peaks.push(live)
                this.track(() => {
                    live -= 1
                })
            }
        }

        const app = new App()
        app.init()
        app.mount()

        const child = new Module(app, { providers: [Subscriber] })
        child.init()
        child.mount()
        child.resolver.resolve(Subscriber)
        expect(live).toBe(1)

        child.unmount()
        expect(live).toBe(0)

        child.mount()
        expect(live).toBe(1)

        child.unmount()
        expect(live).toBe(0)

        // Never two at once: the reproduction that motivated this showed `live: 2` after the remount,
        // because the first subscription was still open when the second was made.
        expect(peaks).toEqual([1, 1])

        await child.destroy()
        app.unmount()
        await app.destroy()
        expect(live).toBe(0)
    })

    it("drains a constructor-time track when the module is destroyed without mounting", async () => {
        const log: string[] = []

        class Eager extends ViewModel {
            constructor() {
                super()
                this.track(() => log.push("disposer"))
            }
        }

        const app = new App({ providers: [Eager] })
        app.init()
        app.resolver.resolve(Eager)

        expect(log).toEqual([])
        await app.destroy()

        // The backstop: no mount ever happened, so no unmount ever will, and destroy is the only place
        // left that can release what the constructor took.
        expect(log).toEqual(["disposer"])
    })
})
