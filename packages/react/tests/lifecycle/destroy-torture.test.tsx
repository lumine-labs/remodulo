import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@testing-library/react"
import { Activity, Component, useLayoutEffect, useState, type ReactNode } from "react"

import { inject } from "@remodulo/container"
import { Module } from "../../src/core/module.js"
import { ModuleStatus } from "../../src/core/module-lifecycle.types.js"
import { ModuleProvider } from "../../src/react/ModuleProvider.js"
import { ModuleTraversal } from "../../src/core/module-traversal.js"
import { useModuleContext } from "../../src/react/useModuleContext.js"
import type { Provider } from "../../src/types.js"
import type { HookCounts } from "../setup/helpers.js"
import { flush, makeApp, makeChild, refuses, tracked } from "../setup/helpers.js"
import { assertTreeInvariant } from "../setup/invariants.js"
import { Root } from "../setup/react.js"

// Destroy torture.
// ========================================
//
// `destroy()` is the only phase that is asynchronous, the only one that claims a subtree, and the only one
// that can be called out of order by a caller holding a module reference. The five edges below are the ones
// the rest of the suite leaves open:
//
//   1. destroy with NO prior unmount, on a live mounted module and on a mounted subtree — REFUSED;
//   2. two destroys in flight at once, at microtask resolution — the collapse, and what it does NOT promise;
//   3. a descendant destroying itself while an ancestor's destroy is still draining;
//   4. destroy after a mount that threw — the imperative escape hatch, REOPENED;
//   5. unmount throwing does not cost the destroy phase — imperatively, and through ModuleProvider's
//      `try { unmount() } finally { scheduleDestroy() }` cleanup.
//
// `mounted` is the one state destroy() refuses, so section 1 pins the refusal plus the ruled path behind it.
// Everything else it serves: sections 2 and 3 pin the claimed states collapsing to a no-op rather than
// rejecting, and section 4 pins `failed` draining in full — the leak the throwing-gate round had booked.
//
// Already pinned elsewhere and deliberately not repeated: destroy ORDER (`ordering.test.ts` "destroy"),
// destroy hooks that throw (`errors.test.ts` "destroy", `errors-torture.test.tsx` "destroy errors"),
// sequential and Promise.all repeats (`idempotence.test.ts`), destroy of a module that never mounted
// (`participation.test.ts:122`) and of one that failed init (`errors-torture.test.tsx:54`).

afterEach(() => {
    vi.restoreAllMocks()
})

const ONCE: HookCounts = { init: 1, mount: 1, unmount: 1, destroy: 1 }

// 1. Destroy while still mounted
// ========================================

describe("destroy while still mounted", () => {
    /**
     * RULED PATH ENFORCEMENT — "if we called mount, we have to call unmount before destroy."
     *
     * This describe used to pin a capability: `destroy()` claimed the subtree and ran the destroy phase with
     * no unmount-if-mounted branch anywhere in it, so an instance could be notified of its death without
     * ever having been notified of its retirement. `onModuleUnmount` was skipped for good, not deferred.
     * That was the imperative caller's rope, and the round that made every gate a throw cut it: `mounted` is
     * not in destroy()'s allow-set, so the shortcut is now a refusal and the unmount is mandatory.
     *
     * What this buys is that a destroy hook can rely on its unmount hook having run — the pairing that the
     * old shortcut was the one way to break. React was already on the ruled path: its cleanup has always
     * unmounted before it scheduled the destroy.
     */
    it("refuses, and the ruled path pairs every unmount with its destroy", async () => {
        const log: string[] = []
        const service = tracked(log, "A")
        const other = tracked(log, "B")
        const module = makeApp({
            providers: [service, other],
            onModuleUnmount: () => log.push("module:unmount"),
            onModuleDestroy: () => log.push("module:destroy"),
        })
        module.mount()
        log.length = 0

        await expect(module.destroy()).rejects.toThrow(refuses("destroy", "mounted"))

        // Refused at the gate: nothing claimed, nothing drained, the module is still live.
        expect(log).toEqual([])
        expect(module.status).not.toBeOneOf([ModuleStatus.Destroying, ModuleStatus.Destroyed])
        expect(module.status).toBe(ModuleStatus.Mounted)

        module.unmount()
        await module.destroy()

        // Both phases, in order, and every instance got the pair the shortcut used to be able to break.
        expect(log).toEqual(["B:unmount", "A:unmount", "module:unmount", "B:destroy", "A:destroy", "module:destroy"])
        expect(service.counts).toEqual(ONCE)
        expect(other.counts).toEqual(ONCE)
        expect(module.status).toBeOneOf([ModuleStatus.Destroying, ModuleStatus.Destroyed])
        expect(module.status).not.toBe(ModuleStatus.Mounted)
    })

    it("refuses from the root of a mounted three-level subtree without claiming any of it", async () => {
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

        // Fully live and fully linked before the destroy.
        expect([app.status, child.status, grandchild.status]).toEqual([
            ModuleStatus.Mounted,
            ModuleStatus.Mounted,
            ModuleStatus.Mounted,
        ])
        expect(app.children.size).toBe(1)
        expect(child.children.size).toBe(1)
        assertTreeInvariant(app)
        log.length = 0

        await expect(app.destroy()).rejects.toThrow(refuses("destroy", "mounted"))

        // The gate is ahead of `#claimSubtree`, so a refused destroy is total: no level was claimed, no
        // level was detached, and the tree is exactly as live as it was.
        expect([app.status, child.status, grandchild.status]).not.toContain(ModuleStatus.Destroying)
        expect([app.status, child.status, grandchild.status]).not.toContain(ModuleStatus.Destroyed)
        expect([app.status, child.status, grandchild.status]).toEqual([
            ModuleStatus.Mounted,
            ModuleStatus.Mounted,
            ModuleStatus.Mounted,
        ])
        expect(app.children.size).toBe(1)
        expect(log).toEqual([])

        app.unmount()
        await app.destroy()

        // The ruled path reaches the same end state the shortcut used to: LIFO across the whole subtree,
        // every node claimed and unlinked, nothing left reachable by traversal.
        expect(log).toEqual([
            "G:unmount",
            "C:unmount",
            "P:unmount",
            "G:destroy",
            "C:destroy",
            "P:destroy",
        ])
        expect([root.counts, middle.counts, leaf.counts]).toEqual([ONCE, ONCE, ONCE])
        for (const node of [app, child, grandchild]) {
            expect(node.status).toBeOneOf([ModuleStatus.Destroying, ModuleStatus.Destroyed])
        }
        expect(app.children.size).toBe(0)
        expect(child.children.size).toBe(0)

        // FLIPPED when `destroyed` joined the resolution gate's refuse-set. This used to read the traversal
        // view off the corpse and assert it saw no descendants; now the corpse answers no reads at all, so
        // the question cannot be asked. The two `children.size` checks above are the direct proof, and the
        // refusal is the stronger statement: there is nothing reachable BECAUSE there is nothing to ask.
        expect(() => app.container.resolve(ModuleTraversal)).toThrow(
            /Cannot resolve ModuleTraversal from a module whose status is "destroyed"/
        )
        assertTreeInvariant(app)
    })

    it("detaches an unmounted child from a parent that stays mounted, and the parent's later unmount misses it", async () => {
        const log: string[] = []
        const parentService = tracked(log, "P")
        const childService = tracked(log, "C")
        const parent = makeApp({ providers: [parentService] })
        const child = makeChild(parent, { providers: [childService] })
        child.mount()
        parent.mount()
        log.length = 0

        // A child can still leave a LIVE parent on its own — it just has to retire itself first. Its unmount
        // does not cascade upward, so the parent is untouched and stays mounted throughout.
        await expect(child.destroy()).rejects.toThrow(refuses("destroy", "mounted"))
        child.unmount()
        await child.destroy()

        expect(log).toEqual(["C:unmount", "C:destroy"])
        expect(parent.children.size).toBe(0)
        expect(parent.status).toBe(ModuleStatus.Mounted)
        expect(parentService.counts).toEqual({ init: 1, mount: 1, unmount: 0, destroy: 0 })
        assertTreeInvariant(parent)

        // The parent's own teardown then walks a subtree the child has already left.
        log.length = 0
        parent.unmount()
        await parent.destroy()

        expect(log).toEqual(["P:unmount", "P:destroy"])
        expect(childService.counts).toEqual(ONCE)
        expect(parentService.counts).toEqual(ONCE)
    })

    /**
     * The mistake refused at both doors now, and the second one is what this comment used to characterize.
     *
     * It read: building a child under a corpse is allowed, and what stops it going live is the cascade
     * condition one level down, `if (!parent || parent.status === Mounted)`. That described a shape nobody
     * wanted — the child ATTACHED to the corpse first and was merely declined the cascade. Two guards close
     * it from both ends now: construction is refused at `new`, and `mount()` refuses a dead parent BEFORE
     * `addChild`. See "the linked-but-dead invariant" at the end of this file for the second half.
     */
    it("refuses to CREATE a child under a destroyed parent", async () => {
        const log: string[] = []
        const parent = makeApp({ providers: [tracked(log, "P")] })
        parent.mount()
        parent.unmount()
        await parent.destroy()

        expect(parent.status).toBe(ModuleStatus.Destroyed)
        log.length = 0

        // The end of a three-round migration for one mistake. It began as "the child inits, attaches, and
        // sits inert under the corpse — the caller owns getting rid of it"; then the ancestor walk moved
        // the refusal to `init()`; now the guard refuses at `new`. Each step moved it closer to the line
        // that is actually wrong, and there was never anything useful to do with the object it returned.
        expect(() => new Module(parent, { providers: [tracked(log, "C")] })).toThrow(
            'Cannot create a child module under a destroyed parent — that branch is spent, so the child could never be armed. Build it under a live parent, or rebuild the branch first.'
        )

        // Nothing built, nothing attached, nothing to dispose of.
        expect(log).toEqual([])
        expect(parent.children.size).toBe(0)
    })

    it("refuses to create a child under a parent that is still draining", async () => {
        const log: string[] = []
        const entered = deferredClaim()
        const release = deferredClaim()
        const Blocking = class {
            async onModuleDestroy(): Promise<void> {
                entered.resolve()
                await release.promise
            }
        }

        const parent = makeApp({ providers: [Blocking as unknown as Provider] })
        const inFlight = parent.destroy()
        await entered.promise
        expect(parent.status).toBe(ModuleStatus.Destroying)

        // `destroying` is refused with the dead states, NOT served the way it is for reads. The claim walk
        // took its snapshot before this child existed, so the parent's drain would never reach it, and the
        // parent lands `destroyed` moments later — a dead end with extra steps.
        expect(() => new Module(parent, {})).toThrow(
            'Cannot create a child module under a destroying parent — that branch is spent, so the child could never be armed. Build it under a live parent, or rebuild the branch first.'
        )

        release.resolve()
        await inFlight
        expect(log).toEqual([])
    })
})

// 2. Two destroys in flight
// ========================================

describe("two destroys in flight", () => {
    /**
     * MEASURED SEMANTIC — the second call RESOLVES on a microtask, long before the first finishes.
     *
     * `destroy()` is `async`, so everything up to its first `await` runs synchronously: `#claimSubtree()`
     * and the whole subtree's flip to `destroying` are both done by the time the first call has returned its
     * promise. The second call therefore finds an already-claimed subtree, gets an empty node list back, and
     * falls straight out of the loop. It is a no-op, and it is NOT a join on the work in flight.
     *
     * Practical consequence, and the price of collapsing rather than refusing: `await module.destroy()` only
     * means "destroyed" for the caller that won the claim. The loser's promise resolves while hooks are
     * still draining, and there is no handle anywhere that lets it wait for them — `module.status` is the
     * only read that tells the two apart.
     */
    it("resolves the second call before the first has run a single destroy hook", async () => {
        const log: string[] = []
        const first = tracked(log, "A", { destroyDelay: 20 })
        const second = tracked(log, "B", { destroyDelay: 20 })
        const module = makeApp({
            providers: [first, second],
            onModuleDestroy: () => log.push("module:destroy"),
        })
        module.mount()
        module.unmount()
        log.length = 0

        const settled: string[] = []
        const winner = module.destroy().then(() => settled.push("winner"))
        const loser = module.destroy().then(
            () => settled.push("loser"),
            (error: Error) => {
                throw new Error(`the loser rejected, but a claimed module collapses: ${error.message}`)
            }
        )

        await loser

        // The second promise is already settled — as a RESOLUTION — while the first has not reached one hook.
        // The module is claimed but not yet spent, which is the honest answer the promise cannot carry.
        expect(settled).toEqual(["loser"])
        expect(module.status).toBeOneOf([ModuleStatus.Destroying, ModuleStatus.Destroyed])
        expect(module.status).not.toBe(ModuleStatus.Destroyed)
        expect(log).toEqual([])

        await winner

        // Reversed order, each hook exactly once across BOTH calls, and the loser settled first.
        expect(settled).toEqual(["loser", "winner"])
        expect(log).toEqual(["B:destroy", "A:destroy", "module:destroy"])
        expect(first.counts).toEqual(ONCE)
        expect(second.counts).toEqual(ONCE)
    })

    it("duplicates nothing when the second call targets a child of the first call's subtree", async () => {
        const log: string[] = []
        const parentService = tracked(log, "P", { destroyDelay: 15 })
        const childService = tracked(log, "C", { destroyDelay: 15 })
        const parent = makeApp({ providers: [parentService] })
        const child = makeChild(parent, { providers: [childService] })
        child.mount()
        parent.mount()
        parent.unmount()
        log.length = 0

        const outer = parent.destroy()
        const inner = child.destroy()

        // The child was claimed by the parent's synchronous head, so its own call collapses ahead of the
        // work — and the child is still drained exactly once, by the walk that took it.
        await expect(inner).resolves.toBeUndefined()
        expect(log).toEqual([])

        await outer
        expect(log).toEqual(["C:destroy", "P:destroy"])
        expect(parentService.counts).toEqual(ONCE)
        expect(childService.counts).toEqual(ONCE)
    })
})

// 3. Destroy during an ancestor's destroy
// ========================================

describe("destroy during an ancestor's destroy", () => {
    it("collapses when a child destroys itself while the ancestor's drain is mid-flight", async () => {
        const log: string[] = []
        const parentService = tracked(log, "P")
        const childService = tracked(log, "C", { destroyDelay: 40 })
        const parent = makeApp({ providers: [parentService] })
        const child = makeChild(parent, { providers: [childService] })
        child.mount()
        parent.mount()
        parent.unmount()
        log.length = 0

        const ancestor = parent.destroy()

        // Land inside the child's own 40ms destroy hook: the claim is done, the drain is not.
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(log).toEqual([])

        // Collapsed rather than joined, and it adds nothing: the call resolves while the ancestor still has
        // the claim and has not finished with it. The child is not yet `destroyed` at this point.
        await expect(child.destroy()).resolves.toBeUndefined()
        expect(child.status).not.toBe(ModuleStatus.Destroyed)
        expect(log).toEqual([])

        await ancestor

        expect(log).toEqual(["C:destroy", "P:destroy"])
        expect(parentService.counts).toEqual(ONCE)
        expect(childService.counts).toEqual(ONCE)
    })

    /**
     * MEASURED SEMANTIC — a re-entrant `module.destroy()` from inside a destroy hook cannot deadlock, and it
     * no longer costs the hook its tail either.
     *
     * The hook is being awaited by `#runDestroyPhase`, which is being awaited by the very `destroy()` the
     * hook calls again. That would be a self-join if the guard were a promise; because it is the synchronous
     * `destroying` status — already set before the first hook ran — the re-entrant call settles immediately
     * and nothing hangs.
     *
     * HOW it settles has now moved twice. The throwing-gate round made it reject, which propagated out of
     * the `await`, abandoned the rest of the hook body and left one `console.error("module.destroy", …)` as
     * the only trace. Collapsing the claimed states puts it back to resolving, so the hook runs to its end
     * and the drain has nothing to report. This is the one place the collapse buys something concrete
     * beyond tidiness: `destroy()` is the signal most likely to be re-sent by a service tearing itself down,
     * and it is now the one signal that can be.
     */
    it("does not deadlock when a provider's own destroy hook calls module.destroy(), and completes the hook", async () => {
        const log: string[] = []
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
        const parentService = tracked(log, "P")
        const parent = makeApp({ providers: [parentService] })
        const child = makeChild(parent, {
            providers: [
                {
                    provide: Symbol("self-destructing"),
                    useFactory: () => {
                        const owner = inject(Module)
                        return {
                            onModuleDestroy: async () => {
                                log.push("R:enter")
                                await owner.destroy()
                                log.push("R:exit")
                            },
                        }
                    },
                },
            ],
        })
        child.mount()
        parent.mount()
        parent.unmount()
        log.length = 0

        await parent.destroy()

        // "R:exit" is back: the re-entrant call resolved, so the `await` returned and the hook ran on.
        expect(log).toEqual(["R:enter", "R:exit", "P:destroy"])
        expect(parentService.counts).toEqual(ONCE)

        // And nothing to report — the drain saw no error at all.
        expect(errorSpy).not.toHaveBeenCalled()
    })
})

// 4. Destroy after a failed mount
// ========================================

describe("destroy after a failed mount", () => {
    /**
     * THE ESCAPE HATCH, REOPENED. This section existed to check it, the throwing-gate round closed it, and
     * the round after that admitted `failed` back into destroy()'s allow-set to open it again.
     *
     * A mount that aborted halfway leaves instances in three different states — mounted-then-rolled-back,
     * throwing, never reached — and all three are participants that ran their `onModuleInit`, so all three
     * are drained. That is what makes the failure survivable: it is not the caller's fault that one
     * provider's `onModuleMount` threw, and the cost of refusing was every instance in the module,
     * permanently.
     *
     * The invariant that makes this safe rather than reckless is that `failed` implies DETACHED (pinned in
     * `rulings.test.ts` §10): mount()'s catch removes the module from its parent before it writes the
     * status, so the caller is always claiming an island nothing live can see.
     */
    it("destroys the module in full, draining every instance it built", async () => {
        const log: string[] = []
        const mounted = tracked(log, "A")
        const thrower = tracked(log, "B", { throwOn: "mount" })
        const unreached = tracked(log, "C")
        const app = makeApp()
        app.mount()

        const module = makeChild(app, {
            providers: [mounted, thrower, unreached],
            onModuleDestroy: () => log.push("module:destroy"),
        })
        log.length = 0

        expect(() => module.mount()).toThrow("B mount")
        // The rollback retires what had already mounted, and lands the module in `failed`.
        expect(log).toEqual(["A:mount", "A:unmount"])
        log.length = 0

        await module.destroy()

        // Reverse registration order, and no state is skipped: every one of the three reached its
        // onModuleInit during the init phase, so every one of them owns something to release.
        expect(log).toEqual(["C:destroy", "B:destroy", "A:destroy", "module:destroy"])
        expect(mounted.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
        expect(thrower.counts).toEqual({ init: 1, mount: 0, unmount: 0, destroy: 1 })
        expect(unreached.counts).toEqual({ init: 1, mount: 0, unmount: 0, destroy: 1 })
        expect(module.status).toBe(ModuleStatus.Destroyed)
    })

    it("leaves the failed module detached, unreachable, and destroyable exactly once", async () => {
        const log: string[] = []
        const service = tracked(log, "A")
        const app = makeApp()
        app.mount()

        const module = makeChild(app, { providers: [service, tracked(log, "B", { throwOn: "mount" })] })
        expect(() => module.mount()).toThrow("B mount")

        // mount()'s catch detached it, so the caller holding the reference is the only route back to it —
        // and that route now works. The repeat collapses on the claim like any other.
        expect(app.children.size).toBe(0)
        await module.destroy()
        await expect(module.destroy()).resolves.toBeUndefined()
        expect(module.status).toBe(ModuleStatus.Destroyed)
        expect(service.counts.destroy).toBe(1)

        // And the live App above it is untouched by any of it — the failure stayed bounded to the island.
        expect(app.status).toBe(ModuleStatus.Mounted)
        app.unmount()
        await app.destroy()
        expect(service.counts.destroy).toBe(1)
    })
})

// 5. Unmount errors do not cost the destroy phase
// ========================================

type BoundaryProps = { children?: ReactNode; onError?: (error: unknown) => void }

class Boundary extends Component<BoundaryProps, { error: unknown }> {
    state: { error: unknown } = { error: null }

    static getDerivedStateFromError(error: unknown): { error: unknown } {
        return { error }
    }

    componentDidCatch(error: unknown): void {
        this.props.onError?.(error)
    }

    render(): ReactNode {
        return this.state.error ? <span data-testid="fallback">caught</span> : this.props.children
    }
}

describe("unmount errors do not cost the destroy phase", () => {
    it("imperative: every destroy hook still runs after unmount threw an AggregateError", async () => {
        const log: string[] = []
        const before = tracked(log, "A")
        const thrower = tracked(log, "B", { throwOn: "unmount" })
        const after = tracked(log, "C")
        const module = makeApp({
            providers: [before, thrower, after],
            onModuleUnmount: () => log.push("module:unmount"),
            onModuleDestroy: () => log.push("module:destroy"),
        })
        module.mount()
        log.length = 0

        let caught: unknown
        try {
            module.unmount()
        } catch (error) {
            caught = error
        }

        expect(caught).toBeInstanceOf(AggregateError)
        expect((caught as AggregateError).errors.map((error) => (error as Error).message)).toEqual(["B unmount"])
        expect(log).toEqual(["C:unmount", "A:unmount", "module:unmount"])
        log.length = 0

        // The failed unmount changes nothing about the destroy phase: same participant set, same order.
        await module.destroy()

        expect(log).toEqual(["C:destroy", "B:destroy", "A:destroy", "module:destroy"])
        expect(before.counts).toEqual(ONCE)
        expect(after.counts).toEqual(ONCE)
        expect(thrower.counts).toEqual({ init: 1, mount: 1, unmount: 0, destroy: 1 })
    })

    /**
     * MEASURED SEMANTIC — the React path, and where the AggregateError lands.
     *
     * `ModuleProvider`'s cleanup is `try { module.unmount() } finally { scheduleDestroy(module) }`. The
     * finally is what makes a throwing `onModuleUnmount` survivable: the destroy is still scheduled, so no
     * instance is left holding resources, and the error is then free to leave the cleanup.
     *
     * Where it lands, measured on React 19.2 + jsdom, depends on whether a boundary is in the deletion path:
     *
     *   * no boundary — the AggregateError is RETHROWN out of the commit, i.e. out of `unmount()` / `act()`.
     *     `console.error` is not called and no window `error` event fires; the throw itself is the report.
     *   * boundary above the deleted subtree — React routes it to `componentDidCatch`, logs its own
     *     "The above error occurred in <ModuleProvider>" line to `console.error`, and the boundary swaps in
     *     its fallback. A throwing unmount hook therefore takes the boundary's whole subtree down with it.
     *
     * Either way the destroy phase is already SCHEDULED by the time the error is visible, because the
     * finally ran before the throw propagated; it runs a macrotask later, which is what `flush()` waits for.
     */
    it("React: destroys the module even though unmount threw, and rethrows out of the commit", async () => {
        const log: string[] = []
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
        const survivor = tracked(log, "A")
        const thrower = tracked(log, "B", { throwOn: "unmount" })

        const { unmount } = render(
            <Root>
                <ModuleProvider providers={[survivor, thrower]}>
                    <div />
                </ModuleProvider>
            </Root>
        )
        log.length = 0

        expect(() => unmount()).toThrow(AggregateError)
        await flush()

        // The finally ran: both instances got their destroy even though the unmount walk failed.
        expect(log).toEqual(["A:unmount", "B:destroy", "A:destroy"])
        expect(survivor.counts).toEqual(ONCE)
        expect(thrower.counts).toEqual({ init: 1, mount: 1, unmount: 0, destroy: 1 })

        // MEASURED: with no boundary in the path the throw IS the report — React logs nothing itself.
        expect(errorSpy).not.toHaveBeenCalled()
    })

    it("React: an ErrorBoundary above the removed subtree receives the AggregateError, destroy still completes", async () => {
        const log: string[] = []
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
        const survivor = tracked(log, "A")
        const thrower = tracked(log, "B", { throwOn: "unmount" })
        const caught: unknown[] = []
        let show: (visible: boolean) => void = () => {}

        function Harness(): ReactNode {
            const [visible, setVisible] = useState(true)
            show = setVisible
            return (
                <Root>
                    <Boundary onError={(error) => caught.push(error)}>
                        {visible ? (
                            <ModuleProvider providers={[survivor, thrower]}>
                                <div />
                            </ModuleProvider>
                        ) : null}
                    </Boundary>
                </Root>
            )
        }

        const { getByTestId } = render(<Harness />)
        log.length = 0

        // Does NOT escape the act — the boundary is in the deletion path and swallows it.
        await act(async () => show(false))
        await flush()

        expect(caught).toHaveLength(1)
        expect(caught[0]).toBeInstanceOf(AggregateError)
        expect((caught[0] as AggregateError).errors.map((error) => (error as Error).message)).toEqual(["B unmount"])
        expect(getByTestId("fallback")).toBeInTheDocument()

        // Same completeness as the no-boundary path.
        expect(log).toEqual(["A:unmount", "B:destroy", "A:destroy"])
        expect(survivor.counts).toEqual(ONCE)
        expect(thrower.counts).toEqual({ init: 1, mount: 1, unmount: 0, destroy: 1 })

        // React reports the caught commit error itself, so there IS a console line on this path.
        expect(errorSpy).toHaveBeenCalled()
    })

    it("React: a throwing module unmount hook does not stop the parent module's own teardown", async () => {
        const log: string[] = []
        vi.spyOn(console, "error").mockImplementation(() => {})
        const parentService = tracked(log, "P")
        const childService = tracked(log, "C")

        const { unmount } = render(
            <Root>
                <ModuleProvider providers={[parentService]}>
                    <ModuleProvider
                        providers={[childService]}
                        onModuleUnmount={() => {
                            throw new Error("hook unmount boom")
                        }}
                    >
                        <div />
                    </ModuleProvider>
                </ModuleProvider>
            </Root>
        )
        log.length = 0

        expect(() => unmount()).toThrow(AggregateError)
        await flush()

        // MEASURED: React walks a deleted tree TOP-DOWN, so the App's cleanup lands first and its unmount
        // cascade is what runs both modules' unmount hooks — child-first within the cascade, which is where
        // the ordering below comes from. The nested providers' own cleanups then find their modules already
        // retired and stay silent, by the hook's `status === mounted` check rather than by the module absorbing them.
        expect(log).toEqual(["C:unmount", "P:unmount", "C:destroy", "P:destroy"])
        expect(parentService.counts).toEqual(ONCE)
        expect(childService.counts).toEqual(ONCE)
    })
})



// 6. The linked-but-dead invariant
// ========================================
//
// An INVARIANT, not scenario support. `mount()` refuses a `failed | destroying | destroyed` parent before
// `addChild`, so a corpse can never take a link. Together with the construction guard at `new`, that makes
// linked-but-dead unrepresentable through the public API, which is what lets `assertTreeInvariant`'s third
// rule read "a claimed node has no attached children" rather than the weaker "no MOUNTED children".
//
// It is deliberately NOT paired with a check in `useModuleLifecycle`. The hook mounts on `isResting` alone
// and has no parent test, so a sequence that reaches this state surfaces as a loud throw out of the effect
// rather than being quietly absorbed. The machine enforces the invariant; the React layer does not paper
// over it. The one sequence that could produce it — a parent claimed between a child's construction and its
// mount — needs `<Activity>` or Suspense above a provider, both unsupported by design, so this guard should
// be unreachable in supported usage. If it ever fires, that is the news.
//
// One cell: the invariant itself. The end-to-end scenario is not tested, because the scenario is not
// supported.

describe("the linked-but-dead invariant", () => {
    it("refuses mount() onto a parent destroyed after the child was built", async () => {
        const log: string[] = []
        const parent = makeApp({ providers: [tracked(log, "P")] })
        const child = makeChild(parent, { providers: [tracked(log, "C")] })

        // Construction and init both passed against a healthy parent — the child owes nobody an apology.
        expect(child.status).toBe(ModuleStatus.Initialized)

        await parent.destroy()
        expect(parent.status).toBe(ModuleStatus.Destroyed)

        expect(() => child.mount()).toThrow(
            "Cannot mount a module onto a destroyed parent — that branch is spent, so the child could never go live under it. Mount it under a live parent, or rebuild the branch first."
        )

        // Refused ahead of the attach, so the corpse holds nothing and the child is exactly as it was.
        expect(parent.children.size).toBe(0)
        expect(child.status).toBe(ModuleStatus.Initialized)
        expect(child.status).not.toBe(ModuleStatus.Failed)
        assertTreeInvariant(parent)

        // Still the caller's to dispose of, and the short path takes it.
        await child.destroy()
        expect(log).toEqual(["P:ctor", "P:init", "C:ctor", "C:init", "P:destroy", "C:destroy"])
    })
})

/** A promise a test can settle by hand, for parking a module mid-drain. */
function deferredClaim(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void
    const promise = new Promise<void>((settle) => {
        resolve = settle
    })
    return { promise, resolve }
}
