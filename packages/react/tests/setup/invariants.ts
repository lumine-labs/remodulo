import { expect } from "vitest"

import type { Module } from "../../src/core/module.js"
import { ModuleStatus } from "../../src/core/module-lifecycle.types.js"

// Cross-node invariants
// ========================================
//
// Every other assertion in the suite reads ONE node's status. These read the PAIRINGS — the facts that
// involve a node and its parent at the same time, which is where a single-status refactor can go wrong
// without any individual node ever looking wrong.
//
// The status alphabet is `created | initializing | initialized | mounted | unmounted | destroying |
// destroyed | failed`. `initializing` is the one transient in it, and it is not a caller-observable state:
// the init phase is synchronous, so the only reads that can ever land on it are the lifecycle's own — which
// is the whole point, since it is what lets the resolution gate serve the eager pass and refuse everyone
// else. Every status a caller CAN observe is still a settled one, so these pairings stay total rather than
// "settled-tree only". No arm below needs it: attachment happens inside mount(), long past init.
//
//   * a `mounted` child hangs off a `mounted` parent. A mounted child under a parent that is not mounted is
//     a live island, and there is no longer any way to produce one through the public API: a mount whose
//     cascade throws rolls the whole severed subtree back through the unmount walk.
//   * an attached child is `initialized`. Attachment happens inside `mount()`, past the `created` gate, so
//     an un-initialized child can never be reachable from a parent's `children`.
//   * a `claimed` node has NO ATTACHED CHILDREN. Both doors that could link one are shut: construction
//     under a dead parent is refused at `new`, and `mount()` refuses a `failed | destroying | destroyed`
//     parent BEFORE `addChild`, so a child whose parent died between its construction and its mount is
//     turned away rather than linked. `#claimSubtree` unlinks everything it claimed and nothing can link
//     itself back on, which makes linked-but-dead unrepresentable through the public API.
//
// "Is initialized" is `status !== created && status !== failed`, which reads `failed` as "did not arrive" —
// but a `failed` node has always been detached by the rollback that failed it, so it is never reachable from
// a parent's `children` either.
//
// All three have a NEGATIVE CONTROL in `rulings.test.ts` (§1), forcing each illegal pairing through
// `addChild`, which asks no questions. Without those, a helper that quietly stopped throwing would go on
// "passing" at every call site below.

/** Assert the legal pairings across `root` and every node attached below it. */
export function assertTreeInvariant(root: Module): void {
    const claimed = root.status === ModuleStatus.Destroying || root.status === ModuleStatus.Destroyed

    for (const child of root.children) {
        expect(claimed, `claimed ${label(root)} still has an ATTACHED child, ${label(child)}`).toBe(false)

        expect(
            child.status !== ModuleStatus.Created && child.status !== ModuleStatus.Failed,
            `${label(child)} is attached to ${label(root)} but is not initialized`
        ).toBe(true)

        if (child.status === ModuleStatus.Mounted) {
            expect(
                root.status === ModuleStatus.Mounted,
                `mounted ${label(child)} hangs off ${label(root)}, which is not mounted`
            ).toBe(true)
        }

        assertTreeInvariant(child)
    }
}

function label(module: Module): string {
    return `module ${module.id}`
}
