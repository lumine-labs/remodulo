import { describe, expect, it } from "vitest"

import { Container } from "../../src/container.js"
import type { EntrySnapshot, InjectionToken } from "../../src/container.types.js"

// The metadata plane.
// ========================================
//
// `parent`, `entry`, `entries` and `registrations` are the read surface a layer above uses to SEE a
// container without resolving through it. Three rulings drive everything below:
//
// 1. The metadata plane is strictly LOCAL. No modes, no chain walk. `parent` is exposed instead, so a
//    "nearest" or "chained" metadata question is a caller loop — pinned in "traversal is userland".
// 2. An alias appears as ITSELF. Metadata describes registrations; resolution is what dereferences them.
//    The alias arm carries `target` and has no `scope`, because an alias owns no lifetime.
// 3. The mode guards MIRROR the value plane's, message for message: `entry` refuses a collection the way
//    `resolve` does, `entries` refuses a single registration the way `resolveAll` does. The claim consulted
//    is this container's own — a token it does not declare is absent, not a conflict, so `[]` stands.
//    `registrations()` is the exception by construction: the whole own census, mode-agnostic.
//
// Snapshots never leak the source payload, the listeners or the cache — the arms below are the whole of
// what a consumer is offered.

// Helpers
// ========================================

const TOKEN = Symbol("TOKEN")
const MULTI = Symbol("MULTI")
const ALIAS = Symbol("ALIAS")
const ABSENT = Symbol("ABSENT")

class Service {}
class Other {}

/** The thrown message, so two reads can be compared without either test hardcoding a copy. */
function messageOf(read: () => unknown): string {
    try {
        read()
    } catch (error) {
        return (error as Error).message
    }
    throw new Error("expected the read to throw")
}

/** What a userland "chained" metadata query looks like: walk `parent`, accumulate own entries. */
function walkChained(start: Container, token: InjectionToken): EntrySnapshot[] {
    const collected: EntrySnapshot[] = []
    for (let current: Container | null = start; current !== null; current = current.parent) {
        collected.push(...current.entries(token))
    }
    return collected
}

// entry()
// ========================================

describe("entry", () => {
    it("describes an own single registration", () => {
        const container = new Container()
        container.register({ provide: TOKEN, useClass: Service, scope: "transient" })

        const snapshot = container.entry(TOKEN)
        expect(snapshot).toEqual({ kind: "class", token: TOKEN, scope: "transient", multi: false })
    })

    it("reports the scope a registration settled on, not the one it was written with", () => {
        const container = new Container()
        container.register([{ provide: TOKEN, useValue: "value" }, Service])

        expect(container.entry(TOKEN)).toEqual({
            kind: "value",
            token: TOKEN,
            scope: "singleton",
            multi: false,
        })
        expect(container.entry(Service)).toEqual({
            kind: "class",
            token: Service,
            scope: "singleton",
            multi: false,
        })
    })

    it("is undefined for a token this container does not declare", () => {
        expect(new Container().entry(ABSENT)).toBeUndefined()
    })

    it("is undefined for a token only an ancestor declares — the metadata plane never walks up", () => {
        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "value" })

        const child = parent.fork()
        expect(child.entry(TOKEN)).toBeUndefined()
        expect(child.resolve(TOKEN)).toBe("value")
    })

    it("refuses a collection with exactly the message resolve refuses it with", () => {
        const container = new Container()
        container.register([
            { provide: MULTI, useClass: Service, multi: true },
            { provide: MULTI, useClass: Other, multi: true },
        ])

        expect(messageOf(() => container.entry(MULTI))).toBe(messageOf(() => container.resolve(MULTI)))
    })

    it("describes an alias as itself: target, no scope, never dereferenced", () => {
        const container = new Container()
        container.register([
            { provide: TOKEN, useClass: Service, scope: "transient" },
            { provide: ALIAS, useExisting: TOKEN },
        ])

        const snapshot = container.entry(ALIAS)
        expect(snapshot).toEqual({ kind: "alias", token: ALIAS, target: TOKEN, multi: false })

        // Not the target's snapshot wearing the alias's token: no scope, and the kind stays "alias".
        expect(snapshot && "scope" in snapshot).toBe(false)
        expect(snapshot?.kind).toBe("alias")
        expect(snapshot?.token).toBe(ALIAS)
    })

    it("carries multi on a member of a collection that is itself an alias", () => {
        const container = new Container()
        container.register([
            { provide: TOKEN, useClass: Service },
            { provide: MULTI, useExisting: TOKEN, multi: true },
        ])

        expect(container.entries(MULTI)).toEqual([{ kind: "alias", token: MULTI, target: TOKEN, multi: true }])
    })
})

// entries()
// ========================================

describe("entries", () => {
    it("lists every own member of a collection in registration order", () => {
        const container = new Container()
        container.register([
            { provide: MULTI, useClass: Service, multi: true },
            { provide: MULTI, useValue: "value", multi: true },
            { provide: MULTI, useClass: Other, scope: "transient", multi: true },
        ])

        expect(container.entries(MULTI)).toEqual([
            { kind: "class", token: MULTI, scope: "singleton", multi: true },
            { kind: "value", token: MULTI, scope: "singleton", multi: true },
            { kind: "class", token: MULTI, scope: "transient", multi: true },
        ])
    })

    // The metadata plane mirrors the value plane's guards completely: entry/resolve refuse a collection,
    // entries/resolveAll refuse a single registration, and each pair refuses it with the same message.
    it("refuses a single registration with exactly the message resolveAll refuses it with", () => {
        const container = new Container()
        container.register({ provide: TOKEN, useValue: "value" })

        expect(messageOf(() => container.entries(TOKEN))).toBe(messageOf(() => container.resolveAll(TOKEN)))
    })

    it("reads its OWN mode claim, not the chain's — a child that declares nothing still answers []", () => {
        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "value" })

        const child = parent.fork()
        expect(child.entries(TOKEN)).toEqual([])
        expect(() => parent.entries(TOKEN)).toThrow()
    })

    it("is empty for a token this container does not declare", () => {
        expect(new Container().entries(ABSENT)).toEqual([])
    })

    it("returns ONLY this container's members of a chained collection", () => {
        const parent = new Container()
        parent.register([
            { provide: MULTI, useClass: Service, multi: true },
            { provide: MULTI, useClass: Other, multi: true },
        ])

        const child = parent.fork()
        child.register({ provide: MULTI, useValue: "child", multi: true })

        expect(child.entries(MULTI)).toEqual([
            { kind: "value", token: MULTI, scope: "singleton", multi: true },
        ])
        expect(parent.entries(MULTI)).toHaveLength(2)
        expect(child.resolveAll(MULTI, "chained")).toHaveLength(3)
    })
})

// registrations()
// ========================================

describe("registrations", () => {
    it("snapshots every own registration in registration order, alias arm included", () => {
        const container = new Container()
        container.register([
            { provide: TOKEN, useValue: "value" },
            { provide: ALIAS, useExisting: TOKEN },
            { provide: MULTI, useClass: Service, scope: "transient", multi: true },
            { provide: MULTI, useFactory: () => new Other(), multi: true },
        ])

        expect(container.registrations()).toEqual([
            { kind: "value", token: TOKEN, scope: "singleton", multi: false },
            { kind: "alias", token: ALIAS, target: TOKEN, multi: false },
            { kind: "class", token: MULTI, scope: "transient", multi: true },
            { kind: "factory", token: MULTI, scope: "singleton", multi: true },
        ])
    })

    // `registrations()` is mode-agnostic where the per-token reads are not: it is the whole own census,
    // so reproducing it token by token means asking each token through the read its mode admits.
    it("agrees with entry and entries token by token", () => {
        const container = new Container()
        container.register([
            { provide: MULTI, useClass: Service, multi: true },
            { provide: MULTI, useClass: Other, multi: true },
            { provide: TOKEN, useValue: "value" },
        ])

        expect(container.registrations()).toEqual([...container.entries(MULTI), container.entry(TOKEN)])
    })
})

// parent
// ========================================

describe("parent", () => {
    it("is the container a fork came from, and null at the root", () => {
        const root = new Container()
        const child = root.fork()
        const grandchild = child.fork()

        expect(root.parent).toBeNull()
        expect(child.parent).toBe(root)
        expect(grandchild.parent).toBe(child)
    })

    it("is null for a container built with no argument at all", () => {
        expect(new Container().parent).toBeNull()
    })

    it("makes chained traversal userland: parent + entries reproduces resolveAll chained", () => {
        const root = new Container()
        root.register({ provide: MULTI, useClass: Service, multi: true })

        const middle = root.fork()
        middle.register([
            { provide: MULTI, useClass: Other, multi: true },
            { provide: MULTI, useValue: "middle", multi: true },
        ])

        const leaf = middle.fork()
        leaf.register({ provide: MULTI, useValue: "leaf", multi: true })

        // The container walks the chain for VALUES. For METADATA the caller walks it, and lands on the
        // same set: nearest first, registration order within a level.
        const walked = walkChained(leaf, MULTI)
        expect(walked).toHaveLength(leaf.resolveAll(MULTI, "chained").length)
        expect(walked.map((snapshot) => snapshot.kind)).toEqual(["value", "class", "value", "class"])
    })

    it("makes a nearest metadata query a caller loop too", () => {
        const root = new Container()
        root.register({ provide: TOKEN, useValue: "root" })

        const leaf = root.fork().fork()

        let found: EntrySnapshot | undefined
        for (let current: Container | null = leaf; current !== null; current = current.parent) {
            found = current.entry(TOKEN)
            if (found) break
        }

        expect(found).toEqual({ kind: "value", token: TOKEN, scope: "singleton", multi: false })
        expect(leaf.entry(TOKEN)).toBeUndefined()
    })
})

// Immutability
// ========================================

describe("snapshot immutability", () => {
    it("freezes every snapshot it hands out", () => {
        const container = new Container()
        container.register([{ provide: TOKEN, useValue: "value" }, { provide: ALIAS, useExisting: TOKEN }])

        for (const snapshot of container.registrations()) {
            expect(Object.isFrozen(snapshot)).toBe(true)
            expect(() => {
                ;(snapshot as { multi: boolean }).multi = true
            }).toThrow(TypeError)
        }
    })

    it("mints a fresh object per call — equal by value, never the same reference", () => {
        const container = new Container()
        container.register([
            { provide: TOKEN, useClass: Service },
            { provide: MULTI, useClass: Other, multi: true },
        ])

        const first = container.entry(TOKEN)
        const second = container.entry(TOKEN)

        expect(first).toEqual(second)
        expect(first).not.toBe(second)
        expect(container.registrations()[0]).not.toBe(first)

        // Same claim for the collection read, which is the only one MULTI is allowed to answer.
        const [member] = container.entries(MULTI)
        expect(container.entries(MULTI)[0]).toEqual(member)
        expect(container.entries(MULTI)[0]).not.toBe(member)
    })

    it("cannot be used to reach the implementation or the cache", () => {
        const container = new Container()
        container.register({ provide: TOKEN, useClass: Service })
        container.on("afterMaterialize", () => {})
        container.resolve(TOKEN)

        expect(Object.keys(container.entry(TOKEN) as object).sort()).toEqual([
            "kind",
            "multi",
            "scope",
            "token",
        ])
    })

    it("grows exactly one key when the registration carried metadata", () => {
        const container = new Container()
        container.register({ provide: TOKEN, useClass: Service, metadata: { policy: "eager" } })

        expect(Object.keys(container.entry(TOKEN) as object).sort()).toEqual([
            "kind",
            "metadata",
            "multi",
            "scope",
            "token",
        ])
    })
})

// Metadata passthrough
// ========================================
//
// The extension point. A registration may carry an opaque `metadata` bag, and every door of the metadata
// plane hands it back exactly as it was registered — that is the whole contract, because the container
// itself never reads a key of it. It exists so a layer above can express policy the container has no
// mechanism for (lazy, in `@remodulo/react`'s case) without a side-table keyed on registrations it does not
// own. `registration.test.ts` pins the write moment; this block pins what the read surface then shows.

describe("metadata passthrough", () => {
    it("surfaces the registered bag through entry, entries and registrations alike", () => {
        const container = new Container()
        container.register([
            { provide: TOKEN, useClass: Service, metadata: { policy: "eager" } },
            { provide: MULTI, useValue: "first", multi: true, metadata: { slot: 1 } },
            { provide: MULTI, useValue: "second", multi: true, metadata: { slot: 2 } },
        ])

        expect(container.entry(TOKEN)).toEqual({
            kind: "class",
            token: TOKEN,
            scope: "singleton",
            multi: false,
            metadata: { policy: "eager" },
        })
        expect(container.entries(MULTI).map((snapshot) => snapshot.metadata)).toEqual([{ slot: 1 }, { slot: 2 }])
        expect(container.registrations().map((snapshot) => snapshot.metadata)).toEqual([
            { policy: "eager" },
            { slot: 1 },
            { slot: 2 },
        ])
    })

    it("gives every member of a collection its own bag, not the first member's", () => {
        const container = new Container()
        container.register([
            { provide: MULTI, useClass: Service, multi: true, metadata: { name: "service" } },
            { provide: MULTI, useClass: Other, scope: "transient", multi: true, metadata: { name: "other" } },
            { provide: MULTI, useValue: "plain", multi: true },
        ])

        const [first, second, third] = container.entries(MULTI)

        expect(first.metadata).toEqual({ name: "service" })
        expect(second.metadata).toEqual({ name: "other" })
        expect(first.metadata).not.toBe(second.metadata)
        // Per member, not per token: one member carrying no bag does not inherit its neighbour's.
        expect("metadata" in third).toBe(false)
    })

    it("carries the bag on the alias arm too, which is why the field sits on both arms", () => {
        const container = new Container()
        container.register([
            { provide: TOKEN, useClass: Service },
            { provide: ALIAS, useExisting: TOKEN, metadata: { policy: "eager" } },
        ])

        expect(container.entry(ALIAS)).toEqual({
            kind: "alias",
            token: ALIAS,
            target: TOKEN,
            multi: false,
            metadata: { policy: "eager" },
        })
        // Described, never dereferenced: the target's own absent bag is not what the alias reports.
        expect("metadata" in (container.entry(TOKEN) as object)).toBe(false)
    })

    it("hands out the one frozen bag on every mint, though the snapshot around it is fresh", () => {
        const container = new Container()
        container.register({ provide: TOKEN, useClass: Service, metadata: { policy: "eager" } })

        const first = container.entry(TOKEN)
        const second = container.entry(TOKEN)

        // The snapshot is minted per call; the bag inside it was already frozen at registration, so there
        // is nothing left for a per-call copy to protect.
        expect(first).not.toBe(second)
        expect(first?.metadata).toBe(second?.metadata)
        expect(container.registrations()[0].metadata).toBe(first?.metadata)
    })

    it("freezes the bag SHALLOWLY — a nested object inside it is not frozen", () => {
        // The honest boundary. `register` copies and freezes the bag it was handed; whatever that bag points
        // AT is still the caller's object, and writing through it is not refused and not invisible. A caller
        // wanting depth freezes its own structure before handing it over.
        const nested = { eager: false }

        const container = new Container()
        container.register({ provide: TOKEN, useClass: Service, metadata: { policy: nested } })

        const bag = container.entry(TOKEN)?.metadata as { policy: { eager: boolean } }

        expect(Object.isFrozen(bag)).toBe(true)
        expect(Object.isFrozen(bag.policy)).toBe(false)

        // Shallow both ways: the nested object was not copied either, so it is the very one registered.
        expect(bag.policy).toBe(nested)
        nested.eager = true
        expect((container.entry(TOKEN)?.metadata as { policy: { eager: boolean } }).policy.eager).toBe(true)
    })
})
