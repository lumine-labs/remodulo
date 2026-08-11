import { describe, expect, it } from "vitest"
import { fireEvent, render } from "@testing-library/react"
import type { ReactNode } from "react"

import { inject } from "@remodulo/container"
import type { Provider } from "../../src/core/provider.types.js"
import { Module } from "../../src/core/module.js"
import { useModuleContext } from "../../src/react/useModuleContext.js"
import { ModuleProvider } from "../../src/react/ModuleProvider.js"
import type { HookCounts } from "../setup/helpers.js"
import { flush, makeApp, makeChild, phase, tracked } from "../setup/helpers.js"
import { assertTreeInvariant } from "../setup/invariants.js"
import { Root } from "../setup/react.js"

// Ordering torture.
// ========================================
//
// Pre-1.0 hardening for the three ordering axes the existing suites leave open:
//
//   1. a THREE-level module tree driven by the real renderer, all four phases end to end;
//   2. collection order inside one module when a provider injects another — resolution order, not
//      declaration order, is what the lifecycle records;
//   3. the two lazy timings that bracket mount — resolved from inside another provider's `onModuleInit`
//      (before the mount signal) and resolved from a component event long after the module mounted.
//
// Ordering of the *signals* (parent-first / child-first mount, subtree unmount, sibling reversal) is
// already pinned imperatively in `ordering.test.ts`; nothing here repeats it.

const ONCE: HookCounts = { init: 1, mount: 1, unmount: 1, destroy: 1 }

describe("module tree ordering", () => {
    it("runs all four phases parent → child → grandchild across three nested ModuleProviders", async () => {
        const log: string[] = []
        const parent = tracked(log, "P")
        const child = tracked(log, "C")
        const grandchild = tracked(log, "G")

        const { unmount } = render(
            <Root>
                <ModuleProvider providers={[parent]}>
                    <ModuleProvider providers={[child]}>
                        <ModuleProvider providers={[grandchild]}>
                            <div />
                        </ModuleProvider>
                    </ModuleProvider>
                </ModuleProvider>
            </Root>
        )

        // Render is top-down, so init lands parent-first; the mount cascade then repeats that order from
        // the app down, even though React's effects fire child-first.
        expect(phase(log, "init")).toEqual(["P:init", "C:init", "G:init"])
        expect(phase(log, "mount")).toEqual(["P:mount", "C:mount", "G:mount"])

        log.length = 0
        unmount()
        expect(phase(log, "unmount")).toEqual(["G:unmount", "C:unmount", "P:unmount"])

        await flush()
        expect(phase(log, "destroy")).toEqual(["G:destroy", "C:destroy", "P:destroy"])
        expect([parent.counts, child.counts, grandchild.counts]).toEqual([ONCE, ONCE, ONCE])
    })

    it("destroys all three levels from a single root signal", async () => {
        const log: string[] = []
        const root = tracked(log, "P")
        const middle = tracked(log, "C")
        const leaf = tracked(log, "G")

        const app = makeApp({ providers: [root] })
        const child = makeChild(app, { providers: [middle] })
        const grandchild = makeChild(child, { providers: [leaf] })
        grandchild.mount()
        child.mount()
        app.mount()
        assertTreeInvariant(app)

        app.unmount()
        assertTreeInvariant(app)
        log.length = 0

        await app.destroy()

        expect(log).toEqual(["G:destroy", "C:destroy", "P:destroy"])
        expect([root.counts, middle.counts, leaf.counts]).toEqual([ONCE, ONCE, ONCE])
        assertTreeInvariant(app)
    })
})

describe("providers within one module", () => {
    /**
     * `Owner` injects `Dep` and is DECLARED FIRST. Collection resolves in declaration order but observes on
     * activation, so `Dep` — constructed to satisfy `Owner`'s constructor — lands in the participant set
     * first. Resolution order is the semantic that holds; declaration order only decides where a resolve
     * *starts*.
     */
    function dependencyPair(log: string[]): Provider[] {
        const DEPENDENCY = Symbol("dependency")
        const dependency = tracked(log, "Dep")

        class Owner {
            readonly dependency = inject(DEPENDENCY)

            constructor() {
                log.push("Owner:ctor")
            }
            onModuleInit(): void {
                log.push("Owner:init")
            }
            onModuleMount(): void {
                log.push("Owner:mount")
            }
            onModuleUnmount(): void {
                log.push("Owner:unmount")
            }
            onModuleDestroy(): void {
                log.push("Owner:destroy")
            }
        }

        return [
            { provide: Owner, useClass: Owner } as Provider,
            { provide: DEPENDENCY, useClass: dependency } as Provider,
        ]
    }

    it("inits and mounts the dependency before the dependent that declared itself first", () => {
        const log: string[] = []
        const module = makeApp({ providers: dependencyPair(log) })

        expect(phase(log, "ctor")).toEqual(["Dep:ctor", "Owner:ctor"])
        expect(phase(log, "init")).toEqual(["Dep:init", "Owner:init"])

        log.length = 0
        module.mount()

        expect(log).toEqual(["Dep:mount", "Owner:mount"])
    })

    it("unmounts and destroys the dependent before the dependency it injected", async () => {
        const log: string[] = []
        const module = makeApp({ providers: dependencyPair(log) })
        module.mount()
        log.length = 0

        module.unmount()
        expect(log).toEqual(["Owner:unmount", "Dep:unmount"])

        log.length = 0
        await module.destroy()
        expect(log).toEqual(["Owner:destroy", "Dep:destroy"])
    })
})

describe("lazy timing", () => {
    it("gives a lazy provider resolved during another provider's init the full four phases", async () => {
        const log: string[] = []
        const LAZY = Symbol("lazy")
        const EAGER = Symbol("eager")
        const lazyService = tracked(log, "L")

        const module = makeApp({
            providers: [
                {
                    provide: EAGER,
                    useFactory: () => {
                        const owner = inject(Module)
                        return {
                            onModuleInit: () => {
                                log.push("E:init")
                                // Resolved mid-init: the init phase walks the participant set live, so the
                                // arrival is reached by the same pass that triggered it.
                                owner.container.resolve(LAZY)
                            },
                            onModuleMount: () => log.push("E:mount"),
                            onModuleUnmount: () => log.push("E:unmount"),
                            onModuleDestroy: () => log.push("E:destroy"),
                        }
                    },
                },
                { provide: LAZY, useClass: lazyService, lazy: true } as Provider,
            ],
        })

        expect(phase(log, "init")).toEqual(["E:init", "L:init"])

        log.length = 0
        module.mount()
        expect(log).toEqual(["E:mount", "L:mount"])

        log.length = 0
        module.unmount()
        await module.destroy()
        expect(log).toEqual(["L:unmount", "E:unmount", "L:destroy", "E:destroy"])

        // Full participation: resolved before the mount signal, it is indistinguishable from an eager one.
        expect(lazyService.counts).toEqual(ONCE)
    })

    /**
     * MEASURED SEMANTIC — late adoption is init-only, NOT init+mount.
     *
     * A lazy provider first resolved from a component event, long after the module mounted, catches up with
     * `onModuleInit` alone: `ModuleLifecycle.#appendInstance` calls the init hook and nothing else, so mount
     * — a tree event that has already gone past — is never replayed for it. It then receives `onModuleUnmount`
     * at teardown despite never having mounted, because unmount walks the participant set, not a
     * "was mounted" flag. `lazy.test.ts` pins the same asymmetry on the imperative drive; this is the
     * renderer's version of it, where the resolve happens in a real event handler after commit.
     */
    it("adopts a lazy provider resolved from a post-mount component event with init only", async () => {
        const log: string[] = []
        const LAZY = Symbol("lazy-late")
        const lazyService = tracked(log, "L")

        function Trigger(): ReactNode {
            const { module } = useModuleContext()
            return (
                <button type="button" onClick={() => module.container.resolve(LAZY)}>
                    resolve
                </button>
            )
        }

        const { getByRole, unmount } = render(
            <Root>
                <ModuleProvider providers={[{ provide: LAZY, useClass: lazyService, lazy: true } as Provider]}>
                    <Trigger />
                </ModuleProvider>
            </Root>
        )
        expect(log).toEqual([])

        fireEvent.click(getByRole("button"))

        // The click lands well after the module mounted, so the catch-up runs both phases on arrival.
        expect(log).toEqual(["L:ctor", "L:init", "L:mount"])
        expect(lazyService.counts.mount).toBe(1)

        log.length = 0
        unmount()
        await flush()

        expect(log).toEqual(["L:unmount", "L:destroy"])
        expect(lazyService.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
    })
})
