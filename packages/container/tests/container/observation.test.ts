import { describe, expect, it, vi } from "vitest"

import { Container } from "../../src/container.js"
import {
    Scope,
    type AfterResolutionEvent,
    type BeforeResolutionEvent,
    type BindingEntrySnapshot,
    type EntrySnapshot,
} from "../../src/container.types.js"
import { inject } from "../../src/injector.js"

// The four events — the hooks a lifecycle layer is built on.
// ========================================
//
// `on(event, fn)` is CONTAINER-GLOBAL and takes no token: every read and every construction on this
// container reaches every hook, and a hook that cares about one token says so in its first line. The
// materialization pair is what `onResolution` used to be — it fires on construction only, on the container
// that OWNS the entry — and the resolution pair is new: it brackets every read, cache hits included, on the
// container the read was INITIATED from.

describe("afterMaterialize", () => {
    it("fires once per constructed singleton, however often it is resolved", () => {
        class Service {}
        const seen: unknown[] = []

        const container = new Container()
        container.register(Service)
        container.on("afterMaterialize", ({ instance }) => seen.push(instance))

        const first = container.resolve(Service)
        container.resolve(Service)
        container.resolve(Service)

        expect(seen).toEqual([first])
    })

    it("fires for a useValue binding on first resolve only", () => {
        const value = { kind: "constant" }
        const TOKEN = Symbol("constant")
        const seen: unknown[] = []

        const container = new Container()
        container.register({ provide: TOKEN, useValue: value })
        container.on("afterMaterialize", ({ instance }) => seen.push(instance))

        container.resolve(TOKEN)
        container.resolve(TOKEN)

        expect(seen).toEqual([value])
    })

    it("fires for a useFactory binding", () => {
        const TOKEN = Symbol("factory")
        const seen: unknown[] = []

        const container = new Container()
        container.register({ provide: TOKEN, useFactory: () => ({ built: true }) })
        container.on("afterMaterialize", ({ instance }) => seen.push(instance))

        const resolved = container.resolve(TOKEN)
        container.resolve(TOKEN)

        expect(seen).toEqual([resolved])
    })

    it("does not fire until something resolves the token", () => {
        class Service {}
        const seen: unknown[] = []

        const container = new Container()
        container.register(Service)
        container.on("afterMaterialize", ({ instance }) => seen.push(instance))

        expect(seen).toEqual([])
    })

    it("fires per instance for a transient binding", () => {
        class Service {}
        const TOKEN = Symbol("transient")
        const seen: unknown[] = []

        const container = new Container()
        container.register({ provide: TOKEN, useClass: Service, scope: Scope.Transient })
        container.on("afterMaterialize", ({ instance }) => seen.push(instance))

        const first = container.resolve(TOKEN)
        const second = container.resolve(TOKEN)
        const third = container.resolve(TOKEN)

        expect(seen).toEqual([first, second, third])
        expect(new Set(seen).size).toBe(3)
    })

    it("reports a dependency before the instance that injected it", () => {
        const B = Symbol("B")
        class Dependency {}
        class Dependent {
            readonly dependency = inject(B)
        }

        const order: unknown[] = []
        const container = new Container()
        container.register([{ provide: B, useClass: Dependency }, Dependent])
        container.on("afterMaterialize", ({ snapshot }) => order.push(snapshot.token))

        container.resolve(Dependent)

        expect(order).toEqual([B, Dependent])
    })

    it("reports the same instance the caller receives", () => {
        class Service {
            readonly id = "service"
        }
        let reported: unknown

        const container = new Container()
        container.register(Service)
        container.on("afterMaterialize", ({ instance }) => {
            reported = instance
        })

        expect(container.resolve(Service)).toBe(reported)
    })

    it("never fires for an alias, and fires for the target the alias redirects to", () => {
        class Service {}
        const ALIAS = Symbol("alias")
        const kinds: string[] = []

        const container = new Container()
        container.register([Service, { provide: ALIAS, useExisting: Service }])
        container.on("afterMaterialize", ({ snapshot }) => kinds.push(snapshot.kind))

        container.resolve(ALIAS)

        // An alias owns no binding and constructs nothing, so the only materialization is the target's.
        expect(kinds).toEqual(["class"])
    })

    it("attaching costs nothing on a container that has registered nothing", () => {
        // There is no attach-time refusal any more: `on` takes no token, so there is no token for it to
        // refuse over. A hook on an empty container is simply a hook that never fires.
        const container = new Container()
        const hook = vi.fn()

        expect(() => container.on("afterMaterialize", hook)).not.toThrow()
        expect(hook).not.toHaveBeenCalled()
    })

    it("fires for a binding registered AFTER the hook was attached", () => {
        // The reverse of what per-entry attachment did: a hook rides on the container, so it observes the
        // container's whole future rather than the entries that happened to exist at attach time.
        const TOKEN = Symbol("late")
        const seen: unknown[] = []

        const container = new Container()
        container.on("afterMaterialize", ({ instance }) => seen.push(instance))
        container.register({ provide: TOKEN, useValue: "late" })

        container.resolve(TOKEN)

        expect(seen).toEqual(["late"])
    })
})

describe("beforeMaterialize", () => {
    it("fires before the constructor body runs", () => {
        const order: string[] = []
        class Service {
            constructor() {
                order.push("constructed")
            }
        }

        const container = new Container()
        container.register(Service)
        container.on("beforeMaterialize", () => order.push("before"))
        container.on("afterMaterialize", () => order.push("after"))

        container.resolve(Service)

        expect(order).toEqual(["before", "constructed", "after"])
    })

    it("carries the token and the snapshot of the entry about to build", () => {
        const TOKEN = Symbol("described")
        class Service {}
        const seen: { token: unknown; snapshot: EntrySnapshot }[] = []

        const container = new Container()
        container.register({ provide: TOKEN, useClass: Service, scope: Scope.Transient })
        container.on("beforeMaterialize", (event) => seen.push(event))

        container.resolve(TOKEN)

        expect(seen).toEqual([
            { token: TOKEN, snapshot: { kind: "class", token: TOKEN, scope: "transient", multi: false } },
        ])
    })

    it("does not fire on a cache hit, on a request-cache hit, or for an alias", () => {
        const SINGLETON = Symbol("cached")
        const REQUEST = Symbol("request")
        const ALIAS = Symbol("aliased")
        class Shared {}
        class Pair {
            readonly a = inject(REQUEST)
            readonly b = inject(REQUEST)
        }
        const kinds: string[] = []

        const container = new Container()
        container.register([
            { provide: SINGLETON, useClass: Shared },
            { provide: REQUEST, useClass: Shared, scope: Scope.Request },
            { provide: ALIAS, useExisting: SINGLETON },
            Pair,
        ])
        container.on("beforeMaterialize", ({ snapshot }) => kinds.push(`${snapshot.kind}:${snapshot.scope}`))

        container.resolve(SINGLETON)
        container.resolve(SINGLETON)
        container.resolve(ALIAS)
        const pair = container.resolve(Pair)

        expect(pair.a).toBe(pair.b)
        // One singleton construction, one Pair construction, one request-scoped construction shared by both
        // of Pair's injection sites. The repeat read, the alias hop and the second request read add nothing.
        expect(kinds).toEqual(["class:singleton", "class:singleton", "class:request"])
    })
})

// The snapshot a materialization event receives
// ========================================
//
// Observation follows the same pattern as the metadata plane: a hook is handed the value AND the frozen
// `EntrySnapshot` of the entry that produced it. That is what lets an adoption layer decide what to do with
// an instance without keeping its own parallel index of what it attached to.

describe("the snapshot a materialization hook receives", () => {
    it("describes the entry that produced the value, not the token that was read", () => {
        const TOKEN = Symbol("described")
        class Service {}
        const seen: EntrySnapshot[] = []

        const container = new Container()
        container.register({ provide: TOKEN, useClass: Service, scope: Scope.Transient })
        container.on("afterMaterialize", ({ snapshot }) => seen.push(snapshot))

        container.resolve(TOKEN)

        expect(seen).toEqual([{ kind: "class", token: TOKEN, scope: "transient", multi: false }])
    })

    it("is the same snapshot `entry` hands out for that registration", () => {
        const TOKEN = Symbol("agreeing")
        let reported: EntrySnapshot | undefined

        const container = new Container()
        container.register({ provide: TOKEN, useFactory: () => ({ built: true }) })
        container.on("afterMaterialize", ({ snapshot }) => {
            reported = snapshot
        })

        container.resolve(TOKEN)

        expect(reported).toEqual(container.entry(TOKEN))
        expect(reported).toEqual({ kind: "factory", token: TOKEN, scope: "singleton", multi: false })
    })

    it("is frozen, like every other snapshot the container hands out", () => {
        const TOKEN = Symbol("frozen")
        let reported: EntrySnapshot | undefined

        const container = new Container()
        container.register({ provide: TOKEN, useValue: "v" })
        container.on("afterMaterialize", ({ snapshot }) => {
            reported = snapshot
        })

        container.resolve(TOKEN)

        expect(Object.isFrozen(reported)).toBe(true)
        expect(() => {
            ;(reported as { multi: boolean }).multi = true
        }).toThrow(TypeError)
    })

    it("distinguishes the members of one collection", () => {
        const TOKEN = Symbol("collection")
        class Transient {}
        const seen: string[] = []

        const container = new Container()
        container.register([
            { provide: TOKEN, useValue: "constant", multi: true },
            { provide: TOKEN, useClass: Transient, scope: Scope.Transient, multi: true },
        ])
        // `.scope` with no `kind` guard in front of it: a materialization hook's snapshot is a
        // `BindingEntrySnapshot`, and a binding always has a scope. This line not compiling is the pin.
        container.on("afterMaterialize", ({ snapshot }) =>
            seen.push(`${snapshot.kind}:${snapshot.scope}:${snapshot.multi}`)
        )

        container.resolveAll(TOKEN)

        // Two entries, and each notification carries its OWN entry's snapshot.
        expect(seen).toEqual(["value:singleton:true", "class:transient:true"])
    })

    it("pairs the value with the snapshot on every construction of a transient", () => {
        const TOKEN = Symbol("repeating")
        class Service {}
        const pairs: [unknown, string][] = []

        const container = new Container()
        container.register({ provide: TOKEN, useClass: Service, scope: Scope.Transient })
        container.on("afterMaterialize", ({ instance, snapshot }) => pairs.push([instance, snapshot.kind]))

        const first = container.resolve(TOKEN)
        const second = container.resolve(TOKEN)

        expect(pairs).toEqual([
            [first, "class"],
            [second, "class"],
        ])
        expect(first).not.toBe(second)
    })

    /**
     * A COMPILE-level pin, and the point of narrowing the payload. `beforeMaterialize` and
     * `afterMaterialize` declare `snapshot` as `BindingEntrySnapshot`, not the full `EntrySnapshot` union,
     * so `.scope` is reachable straight off a destructured parameter — which the container has already
     * earned, since an alias never materializes. The adoption filter every layer above writes is therefore
     * the line below and not `snap.kind !== "alias" && snap.scope === Scope.Singleton`.
     */
    it("hands a materialization hook a binding snapshot, so `.scope` reads without narrowing", () => {
        const TOKEN = Symbol("unnarrowed")
        class Transient {}
        const seen: unknown[] = []

        const container = new Container()
        container.register([
            { provide: TOKEN, useValue: "constant", multi: true },
            { provide: TOKEN, useClass: Transient, scope: Scope.Transient, multi: true },
        ])

        const adopt = (event: { instance: unknown; snapshot: BindingEntrySnapshot }): void => {
            if (event.snapshot.scope === Scope.Singleton) seen.push(event.instance)
        }
        container.on("afterMaterialize", adopt)

        container.resolveAll(TOKEN)

        expect(seen).toEqual(["constant"])
    })
})

// The metadata a hook receives
// ========================================
//
// Observation is the fourth door of the metadata plane, so the opaque `metadata` bag arrives here too — on
// the same snapshot, by the same passthrough. This is the door that matters most to an adoption layer: it
// gets the instance AND the policy the registration was written with, in one call, without holding a
// side-table keyed on registrations it does not own.

describe("the metadata a hook receives", () => {
    it("carries the bag the registration was written with", () => {
        const TOKEN = Symbol("described-meta")
        class Service {}
        const seen: EntrySnapshot[] = []

        const container = new Container()
        container.register({ provide: TOKEN, useClass: Service, metadata: { policy: "eager" } })
        container.on("afterMaterialize", ({ snapshot }) => seen.push(snapshot))

        container.resolve(TOKEN)

        expect(seen).toEqual([
            { kind: "class", token: TOKEN, scope: "singleton", multi: false, metadata: { policy: "eager" } },
        ])
    })

    it("is the very bag `entry` hands out, frozen and shared", () => {
        const TOKEN = Symbol("shared-meta")
        let reported: EntrySnapshot | undefined

        const container = new Container()
        container.register({ provide: TOKEN, useValue: "v", metadata: { policy: "eager" } })
        container.on("afterMaterialize", ({ snapshot }) => {
            reported = snapshot
        })

        container.resolve(TOKEN)

        expect(reported).toEqual(container.entry(TOKEN))
        expect(reported?.metadata).toBe(container.entry(TOKEN)?.metadata)
        expect(Object.isFrozen(reported?.metadata)).toBe(true)
    })

    it("distinguishes two members of one collection by their own bags", () => {
        const TOKEN = Symbol("collection-meta")
        class Transient {}
        const seen: (unknown | undefined)[] = []

        const container = new Container()
        container.register([
            { provide: TOKEN, useValue: "constant", multi: true, metadata: { policy: "eager" } },
            {
                provide: TOKEN,
                useClass: Transient,
                scope: Scope.Transient,
                multi: true,
                metadata: { policy: "lazy" },
            },
        ])

        // Two entries: each notification carries its OWN entry's bag, which is what makes the bag usable as
        // a per-registration policy channel rather than a per-token one.
        container.on("afterMaterialize", ({ snapshot }) => seen.push(snapshot.metadata))

        container.resolveAll(TOKEN)

        expect(seen).toEqual([{ policy: "eager" }, { policy: "lazy" }])
    })

    it("is absent on the snapshot when the registration carried none", () => {
        const TOKEN = Symbol("unadorned")
        class Service {}
        let reported: EntrySnapshot | undefined

        const container = new Container()
        container.register({ provide: TOKEN, useClass: Service })
        container.on("afterMaterialize", ({ snapshot }) => {
            reported = snapshot
        })

        container.resolve(TOKEN)

        expect(reported && "metadata" in reported).toBe(false)
        expect(reported?.metadata).toBeUndefined()
    })

    it("lets a hook route on the bag without the container having read a key of it", () => {
        // The shape the whole extension point exists for: policy declared at registration, acted on by the
        // layer above at construction time. The container did none of this — it stored a bag and gave it back.
        const TOKEN = Symbol("routed")
        class Eager {}
        class Lazy {}
        const adopted: string[] = []

        const container = new Container()
        container.register([
            { provide: TOKEN, useClass: Eager, multi: true, metadata: { policy: "eager" } },
            { provide: TOKEN, useClass: Lazy, multi: true, metadata: { policy: "lazy" } },
        ])

        container.on("afterMaterialize", ({ instance, snapshot }) => {
            if (snapshot.metadata?.policy !== "eager") return
            adopted.push((instance as object).constructor.name)
        })

        container.resolveAll(TOKEN)

        expect(adopted).toEqual(["Eager"])
    })
})

// Filtering, in the hook — one observation door
// ========================================
//
// There is no token-scoped registration and no attach-time filter. A hook that wants one token compares in
// its first line, against the same `EntrySnapshot` `entries()` hands out — so the adoption filter every
// layer above writes is in exactly the vocabulary the metadata plane already speaks.

describe("filtering inside the hook", () => {
    it("observes every entry when the hook declines nothing", () => {
        const TOKEN = Symbol("unfiltered")
        class Transient {}
        const seen: string[] = []

        const container = new Container()
        container.register([
            { provide: TOKEN, useValue: "constant", multi: true },
            { provide: TOKEN, useClass: Transient, scope: Scope.Transient, multi: true },
        ])
        container.on("afterMaterialize", ({ snapshot }) => seen.push(snapshot.kind))

        container.resolveAll(TOKEN)

        expect(seen).toEqual(["value", "class"])
    })

    it("reaches singleton-only adoption by returning early on the transient member", () => {
        const TOKEN = Symbol("filtered")
        class Transient {}
        const seen: unknown[] = []
        const offered: string[] = []

        const container = new Container()
        container.register([
            { provide: TOKEN, useValue: "constant", multi: true },
            { provide: TOKEN, useClass: Transient, scope: Scope.Transient, multi: true },
        ])

        container.on("afterMaterialize", ({ instance, snapshot }) => {
            offered.push(snapshot.kind)
            if (snapshot.scope !== Scope.Singleton) return
            seen.push(instance)
        })

        // Nothing is offered at attach time: a hook hears about an entry only when that entry builds.
        expect(offered).toEqual([])

        container.resolveAll(TOKEN)
        container.resolveAll(TOKEN)

        // The hook IS called for the transient member, on every one of its constructions — twice here,
        // against the singleton's single cached construction.
        expect(offered).toEqual(["value", "class", "class"])

        // And the adopted set is unchanged: the early return keeps the transient out of it.
        expect(seen).toEqual(["constant"])
    })

    it("filters by token the same way, since registration carries none", () => {
        const WANTED = Symbol("wanted")
        const IGNORED = Symbol("ignored")
        const seen: unknown[] = []

        const container = new Container()
        container.register([
            { provide: WANTED, useValue: "wanted" },
            { provide: IGNORED, useValue: "ignored" },
        ])

        container.on("afterMaterialize", ({ instance, snapshot }) => {
            if (snapshot.token !== WANTED) return
            seen.push(instance)
        })

        container.resolve(IGNORED)
        container.resolve(WANTED)

        expect(seen).toEqual(["wanted"])
    })
})

// The resolution pair — one pair per landed entry, cache hits included
// ========================================
//
// This is the half `onResolution` never had. `beforeResolution` and `afterResolution` fire on the container
// the read was made on, whether or not anything is constructed, so a layer above can see reads of an
// already-cached singleton — which is precisely the case a construction-only hook is blind to.
//
// THE PAIR BRACKETS EACH ENTRY THE READ LANDS ON, and nothing else. A single read that lands fires one
// pair; a collection read fires one pair per member, in member order. Everything that lands nothing is
// silent: an illegal read throws from the kernel's own validation before any hook, and a legal miss —
// tolerant spelling of an unregistered token, a dangling alias, an empty collection — is no resolution at
// all, so there is nothing to report. What the caller makes of a miss is the caller's business. The
// snapshot is therefore never absent.
//
// And what it announces is the ASK. The two planes report opposite sides of one read: resolution is the
// DEMAND side, so it reports entries as they were spelled — an alias read announces the alias, however
// many hops the walk behind it took — while materialization is the SUPPLY side and reports the binding
// that actually built. That is why the resolution pair carries the wide `EntrySnapshot` and the
// materialization pair carries `BindingEntrySnapshot`: only one of the two can ever see an alias.
//
// The one asymmetry left is deliberate: an ABORT can leave a `before` unpaired, because refusing is what a
// throwing hook is for and a construction that dies mid-flight really did start.

describe("the resolution pair", () => {
    it("brackets a read that constructs, around the materialization pair", () => {
        class Service {}
        const order: string[] = []

        const container = new Container()
        container.register(Service)
        container.on("beforeResolution", () => order.push("beforeResolution"))
        container.on("beforeMaterialize", () => order.push("beforeMaterialize"))
        container.on("afterMaterialize", () => order.push("afterMaterialize"))
        container.on("afterResolution", () => order.push("afterResolution"))

        container.resolve(Service)

        expect(order).toEqual(["beforeResolution", "beforeMaterialize", "afterMaterialize", "afterResolution"])
    })

    it("fires on a cache hit, where the materialization pair does not", () => {
        class Service {}
        const order: string[] = []

        const container = new Container()
        container.register(Service)
        container.resolve(Service)

        container.on("beforeResolution", () => order.push("before"))
        container.on("beforeMaterialize", () => order.push("materialize"))
        container.on("afterResolution", () => order.push("after"))

        container.resolve(Service)
        container.resolve(Service)

        expect(order).toEqual(["before", "after", "before", "after"])
    })

    it("carries the token, the width the read was made at, and the entry as spelled", () => {
        const TOKEN = Symbol("width")
        const MULTI = Symbol("width-multi")
        const seen: BeforeResolutionEvent[] = []

        const container = new Container()
        container.register([
            { provide: TOKEN, useValue: "v" },
            { provide: MULTI, useValue: "m", multi: true },
        ])
        container.on("beforeResolution", (event) => seen.push(event))

        container.resolve(TOKEN)
        container.resolve(TOKEN, "self")
        container.resolveOptional(TOKEN)
        container.resolveOr(TOKEN, "fallback", "self")
        container.resolveAll(MULTI)
        container.resolveAll(MULTI, "nearest")

        // The snapshot is how the token is REGISTERED, offered before it resolves — so a hook can route on
        // scope, kind or metadata without having to have watched the registration go by. It is never
        // absent, because an announcement only happens where an entry landed.
        const single = { kind: "value", token: TOKEN, scope: "singleton", multi: false }
        const member = { kind: "value", token: MULTI, scope: "singleton", multi: true }

        expect(seen).toEqual([
            { token: TOKEN, mode: "nearest", snapshot: single },
            { token: TOKEN, mode: "self", snapshot: single },
            { token: TOKEN, mode: "nearest", snapshot: single },
            { token: TOKEN, mode: "self", snapshot: single },
            // A collection announces per MEMBER, so the one member here reports once per read.
            { token: MULTI, mode: "chained", snapshot: member },
            { token: MULTI, mode: "nearest", snapshot: member },
        ])
    })

    it("fires NOTHING for a legal miss, in either tolerant spelling and for a dangling alias", () => {
        // Resolution is resolution: with nothing landed there was no resolution, so there is no event. What
        // the caller makes of the miss — `undefined`, a fallback — is the caller's business. A dangling
        // alias is the same story told one hop later: the walk discovers the miss before the announce site.
        const ABSENT = Symbol("absent")
        const ALIAS = Symbol("alias")
        const MISSING = Symbol("missing")
        const before = vi.fn()
        const after = vi.fn()

        const container = new Container()
        container.register({ provide: ALIAS, useExisting: MISSING })
        container.on("beforeResolution", before)
        container.on("afterResolution", after)

        expect(container.resolveOptional(ABSENT)).toBeUndefined()
        expect(container.resolveOr(ABSENT, "fallback")).toBe("fallback")
        expect(container.resolveOptional(ALIAS)).toBeUndefined()
        expect(container.resolveOr(ALIAS, "fallback")).toBe("fallback")

        expect(before).not.toHaveBeenCalled()
        expect(after).not.toHaveBeenCalled()
    })

    it("fires nothing for a collection that lands no members", () => {
        const EMPTY = Symbol("empty")
        const before = vi.fn()
        const after = vi.fn()

        const container = new Container()
        container.on("beforeResolution", before)
        container.on("afterResolution", after)

        expect(container.resolveAll(EMPTY)).toEqual([])

        expect(before).not.toHaveBeenCalled()
        expect(after).not.toHaveBeenCalled()
    })

    it("fires one pair per member of a collection, each internally symmetric", () => {
        const PLUGIN = Symbol("PLUGIN")
        class Plugin1 {}
        class Plugin2 {}
        const before: BeforeResolutionEvent[] = []
        const after: AfterResolutionEvent[] = []

        const container = new Container()
        container.register([
            { provide: PLUGIN, useClass: Plugin1, multi: true, metadata: { name: "one" } },
            { provide: PLUGIN, useClass: Plugin2, multi: true, metadata: { name: "two" } },
        ])
        container.on("beforeResolution", (event) => before.push(event))
        container.on("afterResolution", (event) => after.push(event))

        container.resolveAll(PLUGIN)

        // Two members, two pairs, in the collection's own member order — and each member's pair agrees with
        // itself on token, mode and snapshot, exactly as a single read's pair does.
        expect(before).toHaveLength(2)
        expect(after).toHaveLength(2)

        for (const index of [0, 1]) {
            expect(before[index].token).toBe(PLUGIN)
            expect(before[index].mode).toBe("chained")
            expect(after[index].mode).toBe("chained")
            expect(after[index].snapshot).toEqual(before[index].snapshot)
        }

        // The token is shared, so the snapshot is what tells the members apart — through the registration's
        // own bag, since a snapshot deliberately never names the implementation. Two members declared
        // identically would carry EQUAL snapshots and be told apart only by their instances.
        expect(before[0].snapshot.metadata).toEqual({ name: "one" })
        expect(before[1].snapshot.metadata).toEqual({ name: "two" })
        expect(after[0].instance).toBeInstanceOf(Plugin1)
        expect(after[1].instance).toBeInstanceOf(Plugin2)
    })

    it("agrees with itself: the pair from one read carries the same mode and the same snapshot", () => {
        // The two halves are one event shape. `before` carries the token because there is no instance yet;
        // `after` carries the instance because the token has already been reported. Everything else matches,
        // and it matches for an ALIAS read too, where the shared snapshot is the ask rather than the landing.
        class Service {}
        const ALIAS = Symbol("alias")
        const before: BeforeResolutionEvent[] = []
        const after: AfterResolutionEvent[] = []

        const container = new Container()
        container.register([Service, { provide: ALIAS, useExisting: Service }])
        container.on("beforeResolution", (event) => before.push(event))
        container.on("afterResolution", (event) => after.push(event))

        container.resolve(ALIAS, "self")

        expect(before).toHaveLength(1)
        expect(after).toHaveLength(1)
        expect(after[0].mode).toBe(before[0].mode)
        expect(after[0].mode).toBe("self")
        expect(after[0].snapshot).toEqual(before[0].snapshot)
        expect(after[0].snapshot).toEqual({ kind: "alias", token: ALIAS, target: Service, multi: false })
        expect(after[0].instance).toBeInstanceOf(Service)
    })

    it("carries the COLLECTION's mode on every member of a collection read", () => {
        const TOKEN = Symbol("members-mode")
        const modes: string[] = []

        const container = new Container()
        container.register([
            { provide: TOKEN, useValue: "a", multi: true },
            { provide: TOKEN, useValue: "b", multi: true },
        ])
        container.on("afterResolution", ({ mode }) => modes.push(mode))

        container.resolveAll(TOKEN, "self")

        // The members are not reads of their own, so they report the width of the read that produced them.
        expect(modes).toEqual(["self", "self"])
    })

    it("reports one afterResolution per value the read produced", () => {
        const TOKEN = Symbol("members")
        class Transient {}
        const seen: unknown[] = []

        const container = new Container()
        container.register([
            { provide: TOKEN, useValue: "constant", multi: true },
            { provide: TOKEN, useClass: Transient, multi: true, scope: Scope.Transient },
        ])
        container.on("afterResolution", ({ instance }) => seen.push(instance))

        const all = container.resolveAll(TOKEN)

        expect(seen).toEqual(all)
        expect(seen).toHaveLength(2)
    })

    it("fires exactly one pair for a single read that lands", () => {
        // The contract in one line: the pair brackets each entry a read lands on, and nothing else.
        const TOKEN = Symbol("landed")
        const before = vi.fn()
        const after = vi.fn()

        const container = new Container()
        container.register({ provide: TOKEN, useValue: "v" })
        container.on("beforeResolution", before)
        container.on("afterResolution", after)

        container.resolve(TOKEN)

        expect(before).toHaveBeenCalledTimes(1)
        expect(after).toHaveBeenCalledTimes(1)
    })

    it("never reaches a hook when the read fails the kernel's own validation", () => {
        // The precedence rule: the kernel refuses first, and refuses alone. `beforeResolution` is the
        // announcement of a read the container has AGREED to attempt, so a read it will not attempt is
        // announced to nobody — a hook cannot observe, log or refuse an operation that was never legal.
        const ABSENT = Symbol("absent")
        const SINGLE = Symbol("single")
        const COLLECTION = Symbol("collection")
        const before = vi.fn()

        const container = new Container()
        container.register([
            { provide: SINGLE, useValue: "v" },
            { provide: COLLECTION, useValue: "a", multi: true },
        ])
        container.on("beforeResolution", before)

        // A required read of nothing.
        expect(() => container.resolve(ABSENT)).toThrow(/is not registered in this container/)
        expect(() => container.resolve(ABSENT, "self")).toThrow(/is not registered in this container/)

        // A single-value read of a collection, in all three spellings that take one.
        expect(() => container.resolve(COLLECTION)).toThrow(/multi-provider collection/)
        expect(() => container.resolveOptional(COLLECTION)).toThrow(/multi-provider collection/)
        expect(() => container.resolveOr(COLLECTION, "fallback")).toThrow(/multi-provider collection/)

        // And a collection read of a single registration.
        expect(() => container.resolveAll(SINGLE)).toThrow(/is a single registration/)

        expect(before).not.toHaveBeenCalled()
    })

    it("does not let a hook refuse ahead of the kernel", () => {
        // The consequence worth stating on its own: a `beforeResolution` hook that throws refuses reads,
        // but an illegal read is refused BEFORE it, so the caller gets the kernel's diagnosis rather than
        // the hook's. Kernel errors are not interceptable, because they are not announced.
        const ABSENT = Symbol("absent")
        const hookRefusal = new Error("refused by the hook")

        const container = new Container()
        container.on("beforeResolution", () => {
            throw hookRefusal
        })

        expect(() => container.resolve(ABSENT)).toThrow(/is not registered in this container/)
        expect(() => container.resolve(ABSENT)).not.toThrow(hookRefusal)

        // And a legal miss reaches the hook no more than an illegal read does: nothing landed, so the
        // refusal never gets a chance to fire and the tolerant spelling returns its miss undisturbed.
        expect(container.resolveOptional(ABSENT)).toBeUndefined()
    })

    it("announces the ASK for an alias read, exactly once", () => {
        class Service {}
        const ALIAS = Symbol("alias")
        const announced: unknown[] = []
        const seen: EntrySnapshot[] = []

        const container = new Container()
        container.register([Service, { provide: ALIAS, useExisting: Service }])
        container.on("beforeResolution", ({ token }) => announced.push(token))
        container.on("afterResolution", ({ instance, snapshot }) => {
            seen.push(snapshot)
            expect(instance).toBeInstanceOf(Service)
        })

        const instance = container.resolve(ALIAS)

        // The resolution plane is the DEMAND side: it reports what was asked for, spelled the way the
        // caller spelled it. So the pair names the ALIAS, and the payload is deliberately mixed —
        // `snapshot` is what you asked through, `instance` is what you got. The supply side is the
        // materialization plane, and that one reports the target, as it always has.
        expect(announced).toEqual([ALIAS])
        expect(seen).toEqual([{ kind: "alias", token: ALIAS, target: Service, multi: false }])

        // ONE pair, not zero and not two: the hop is a lookup, not a second read.
        expect(announced).toHaveLength(1)
        expect(seen).toHaveLength(1)
        expect(instance).toBe(container.resolve(Service))
    })

    it("hands the resolution pair the wide snapshot union, alias arm included", () => {
        // A compile-level claim riding on a runtime one: `AfterResolutionEvent.snapshot` is `EntrySnapshot`,
        // not the `BindingEntrySnapshot` the materialization pair narrows to — it HAS to be, because an
        // alias read announces its alias entry. Reading `.target` after the `kind` guard is the pin; the
        // materialization payloads stay narrow, which the `.scope`-without-narrowing cell above pins.
        class Service {}
        const ALIAS = Symbol("alias")
        const targets: unknown[] = []

        const container = new Container()
        container.register([Service, { provide: ALIAS, useExisting: Service }])
        container.on("afterResolution", ({ snapshot }) => {
            if (snapshot.kind !== "alias") return
            targets.push(snapshot.target)
        })

        container.resolve(ALIAS)

        expect(targets).toEqual([Service])
    })

    it("stays one pair however many alias hops the read takes", () => {
        class Service {}
        const OUTER = Symbol("outer")
        const INNER = Symbol("inner")
        const announced: unknown[] = []
        const reported: unknown[] = []

        const container = new Container()
        container.register([Service, { provide: INNER, useExisting: Service }, { provide: OUTER, useExisting: INNER }])
        container.on("beforeResolution", ({ token }) => announced.push(token))
        container.on("afterResolution", ({ snapshot }) => reported.push(snapshot.token))

        const viaAlias = container.resolve(OUTER)

        // Two hops, and the intermediate is as silent as the walk that crossed it: only the ask reports.
        expect(announced).toEqual([OUTER])
        expect(reported).toEqual([OUTER])
        expect(viaAlias).toBe(container.resolve(Service))
    })

    it("announces nothing when a strict read's alias walk dead-ends", () => {
        // The walk is part of LOOKUP, so a chain that lands nowhere fails the kernel's own validation and
        // D53e's rule applies unchanged: the read never becomes legal, so it never reaches a hook.
        const ALIAS = Symbol("alias")
        const MISSING = Symbol("missing")
        const before = vi.fn()
        const after = vi.fn()

        const container = new Container()
        container.register({ provide: ALIAS, useExisting: MISSING })
        container.on("beforeResolution", before)
        container.on("afterResolution", after)

        expect(() => container.resolve(ALIAS)).toThrow(/is not registered in this container/)

        expect(before).not.toHaveBeenCalled()
        expect(after).not.toHaveBeenCalled()
    })

    it("reports an alias member of a collection as the alias member", () => {
        const TOKEN = Symbol("mixed")
        class Legacy {}
        const announced: unknown[] = []
        const kinds: string[] = []

        const container = new Container()
        container.register([
            Legacy,
            { provide: TOKEN, useValue: "direct", multi: true },
            { provide: TOKEN, useExisting: Legacy, multi: true },
        ])
        const asked: string[] = []
        container.on("beforeResolution", ({ token, snapshot }) => {
            announced.push(token)
            asked.push(snapshot.kind)
        })
        container.on("afterResolution", ({ snapshot }) => kinds.push(snapshot.kind))

        container.resolveAll(TOKEN)

        // A pair per member, both halves naming the member as it sits in the collection. The alias member
        // reports as an alias on both sides, never unwrapped to what it lands on.
        expect(announced).toEqual([TOKEN, TOKEN])
        expect(asked).toEqual(["value", "alias"])
        expect(kinds).toEqual(["value", "alias"])
    })

    it("does not fire for the reads that produce no instance", () => {
        // `isRegistered`, `entry`, `entries` and `registrations` are lookups over the metadata plane. There
        // is no instance in any of them, so there is nothing for the resolution pair to report.
        const TOKEN = Symbol("lookup")
        const before = vi.fn()

        const container = new Container()
        container.register({ provide: TOKEN, useValue: "v" })
        container.on("beforeResolution", before)

        container.isRegistered(TOKEN)
        container.entry(TOKEN)
        container.entries(Symbol("other"))
        container.registrations()

        expect(before).not.toHaveBeenCalled()
    })
})

// The chain rule
// ========================================
//
// Resolution happens where it was ASKED FOR; materialization happens where the entry LIVES. A child fork
// reading a parent-owned singleton therefore reports the read on the child and the construction on the
// parent — which is what keeps module adoption keyed on ownership: a container adopts the instances its own
// registrations produced, whoever asked for them.

describe("the chain rule", () => {
    it("splits a child's read of a parent-owned entry between the two containers", () => {
        class Service {}
        const parentEvents: string[] = []
        const childEvents: string[] = []

        const parent = new Container()
        parent.register(Service)
        const child = parent.fork()

        for (const [container, log] of [
            [parent, parentEvents],
            [child, childEvents],
        ] as const) {
            for (const event of [
                "beforeResolution",
                "afterResolution",
                "beforeMaterialize",
                "afterMaterialize",
            ] as const) {
                container.on(event, () => log.push(event))
            }
        }

        child.resolve(Service)

        expect(childEvents).toEqual(["beforeResolution", "afterResolution"])
        expect(parentEvents).toEqual(["beforeMaterialize", "afterMaterialize"])
    })

    it("reports the whole read on one container when it owns the entry", () => {
        class Service {}
        const grandchildEvents: string[] = []
        const ownerEvents: string[] = []

        const owner = new Container()
        owner.register(Service)
        owner.on("afterMaterialize", () => ownerEvents.push("afterMaterialize"))
        owner.on("afterResolution", () => ownerEvents.push("afterResolution"))

        const grandchild = owner.fork().fork()
        grandchild.on("afterMaterialize", () => grandchildEvents.push("afterMaterialize"))
        grandchild.on("afterResolution", () => grandchildEvents.push("afterResolution"))

        const resolved = grandchild.resolve(Service)

        expect(grandchildEvents).toEqual(["afterResolution"])
        expect(ownerEvents).toEqual(["afterMaterialize"])

        // Still one materialization — the owner's second read hits the cached singleton — but the owner's
        // own read is a read, so it reports one.
        expect(resolved).toBe(owner.resolve(Service))
        expect(ownerEvents).toEqual(["afterMaterialize", "afterResolution"])
    })

    it("inherits nothing: a fork made after a hook was attached carries none of it", () => {
        class Service {}
        const parentEvents: string[] = []

        const parent = new Container()
        parent.on("beforeResolution", () => parentEvents.push("beforeResolution"))

        const child = parent.fork()
        child.register(Service)
        child.resolve(Service)

        expect(parentEvents).toEqual([])
    })

    /**
     * Materialization rides on the ENTRY's owner, so a descendant that shadows a token reports its own
     * instances and the ancestor reports none of them. That is what makes shadowing safe for the lifecycle:
     * a container-level rule matched by TOKEN would let an ancestor adopt a module's shadowing instance and
     * destroy it on the ancestor's schedule instead of its own.
     */
    it("does not fire an ancestor's materialization for a shadowing binding resolved below it", () => {
        const TOKEN = Symbol("shadowed")
        const parentValue = { from: "parent" }
        const childValue = { from: "child" }
        const parentSeen: unknown[] = []
        const childSeen: unknown[] = []

        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: parentValue })
        parent.on("afterMaterialize", ({ instance }) => parentSeen.push(instance))

        const child = parent.fork()
        child.register({ provide: TOKEN, useValue: childValue })
        child.on("afterMaterialize", ({ instance }) => childSeen.push(instance))

        child.resolve(TOKEN)

        expect(childSeen).toEqual([childValue])
        expect(parentSeen).toEqual([])

        parent.resolve(TOKEN)
        expect(parentSeen).toEqual([parentValue])
        expect(childSeen).toEqual([childValue])
    })

    /**
     * Alias × chain composes, because the hop is a lookup rather than a read: nothing about where an alias
     * happens to be DECLARED can move where a read is announced. The two arrangements below differ in
     * every structural way and report identically — on the child, which is where the ask was made, and as
     * the alias, which is how it was spelled.
     */
    it("announces an alias read at the initiator, wherever the alias itself lives", () => {
        class Target {}
        const ALIAS = Symbol("alias")

        const announcements = (arrange: (parent: Container, child: Container) => void): string[] => {
            const log: string[] = []
            const parent = new Container()
            const child = parent.fork()
            arrange(parent, child)

            for (const [name, container] of [
                ["parent", parent],
                ["child", child],
            ] as const) {
                container.on("beforeResolution", ({ token }) => log.push(`${name}:before:${String(token)}`))
                container.on("afterResolution", ({ snapshot }) => log.push(`${name}:after:${snapshot.kind}`))
            }

            child.resolve(ALIAS)
            return log
        }

        const declaredBelow = announcements((parent, child) => {
            parent.register(Target)
            child.register({ provide: ALIAS, useExisting: Target })
        })

        const inheritedFromAbove = announcements((parent) => {
            parent.register([Target, { provide: ALIAS, useExisting: Target }])
        })

        const expected = [`child:before:${String(ALIAS)}`, "child:after:alias"]
        expect(declaredBelow).toEqual(expected)
        expect(inheritedFromAbove).toEqual(expected)
    })

    it("splits a chained collection read by the owner of each member", () => {
        const TOKEN = Symbol("chained")
        const parentSeen: unknown[] = []
        const childSeen: unknown[] = []
        const childRead: unknown[] = []

        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent", multi: true })
        parent.on("afterMaterialize", ({ instance }) => parentSeen.push(instance))

        const child = parent.fork()
        child.register({ provide: TOKEN, useValue: "child", multi: true })
        child.on("afterMaterialize", ({ instance }) => childSeen.push(instance))
        child.on("afterResolution", ({ instance }) => childRead.push(instance))

        expect(child.resolveAll(TOKEN)).toEqual(["child", "parent"])

        expect(childSeen).toEqual(["child"])
        expect(parentSeen).toEqual(["parent"])
        // The read was made on the child, so the child hears about every value it produced.
        expect(childRead).toEqual(["child", "parent"])
    })
})

// Refusal — what a throwing hook does
// ========================================
//
// Hooks observe or refuse; they never substitute. A `before*` hook that throws is how refusal is spelled:
// the operation does not complete and the error reaches the caller unchanged. An `after*` hook that throws
// propagates too — the work is already done by then, so what the throw buys is that a layer above cannot
// swallow its own failure silently.

describe("a hook that throws", () => {
    it("aborts the read from beforeResolution, before anything is materialized", () => {
        class Service {
            constructor() {
                built += 1
            }
        }
        let built = 0
        const refusal = new Error("refused")
        const later = vi.fn()

        const container = new Container()
        container.register(Service)
        container.on("beforeResolution", () => {
            throw refusal
        })
        container.on("beforeMaterialize", later)
        container.on("afterResolution", later)

        expect(() => container.resolve(Service)).toThrow(refusal)
        expect(built).toBe(0)
        expect(later).not.toHaveBeenCalled()
    })

    it("aborts a collection read from beforeResolution", () => {
        const TOKEN = Symbol("refused-all")
        const refusal = new Error("refused")
        const materialized = vi.fn()

        const container = new Container()
        container.register({ provide: TOKEN, useValue: "v", multi: true })
        container.on("beforeResolution", () => {
            throw refusal
        })
        container.on("afterMaterialize", materialized)

        expect(() => container.resolveAll(TOKEN)).toThrow(refusal)
        expect(materialized).not.toHaveBeenCalled()
    })

    it("aborts the construction from beforeMaterialize, and writes no cache", () => {
        // What "abort" means against the cache-before-`afterMaterialize` invariant: the refusal lands
        // BEFORE the build and therefore before the write, so the entry is left exactly as it was. The
        // constructor never ran, nothing was cached, and a later read is a first read again.
        class Service {
            constructor() {
                built += 1
            }
        }
        let built = 0
        const refusal = new Error("refused")
        const after = vi.fn()

        const container = new Container()
        container.register(Service)
        const detach = container.on("beforeMaterialize", () => {
            throw refusal
        })
        container.on("afterMaterialize", after)

        expect(() => container.resolve(Service)).toThrow(refusal)
        expect(built).toBe(0)
        expect(after).not.toHaveBeenCalled()

        // The read stayed abortable, which is the observable half of "no cache was written".
        expect(() => container.resolve(Service)).toThrow(refusal)
        expect(built).toBe(0)

        detach()
        const instance = container.resolve(Service)
        expect(built).toBe(1)
        expect(container.resolve(Service)).toBe(instance)
    })

    it("aborts a useValue materialization the same way, so it fires again on the next read", () => {
        // A constant fires ONCE — on its first successful materialization. An aborted one never
        // materialized, so the next read is still its first.
        const TOKEN = Symbol("refused-value")
        const refusal = new Error("refused")
        const seen: unknown[] = []
        let refuse = true

        const container = new Container()
        container.register({ provide: TOKEN, useValue: "v" })
        container.on("beforeMaterialize", () => {
            if (refuse) throw refusal
        })
        container.on("afterMaterialize", ({ instance }) => seen.push(instance))

        expect(() => container.resolve(TOKEN)).toThrow(refusal)
        expect(seen).toEqual([])

        refuse = false
        expect(container.resolve(TOKEN)).toBe("v")
        expect(container.resolve(TOKEN)).toBe("v")
        expect(seen).toEqual(["v"])
    })

    it("propagates from afterMaterialize, with the instance already cached", () => {
        // The asymmetry the layer above relies on: the throw reaches the caller, and the cache write it
        // came after is not undone. A retry is therefore a cache hit and fires no materialization at all.
        class Service {}
        const refusal = new Error("adoption failed")
        const materializations: unknown[] = []

        const container = new Container()
        container.register(Service)
        container.on("afterMaterialize", ({ instance }) => {
            materializations.push(instance)
            throw refusal
        })

        expect(() => container.resolve(Service)).toThrow(refusal)
        expect(materializations).toHaveLength(1)

        const second = container.resolve(Service)
        expect(second).toBe(materializations[0])
        expect(materializations).toHaveLength(1)
    })

    it("propagates from afterResolution", () => {
        const TOKEN = Symbol("after-read")
        const refusal = new Error("refused")

        const container = new Container()
        container.register({ provide: TOKEN, useValue: "v" })
        container.on("afterResolution", () => {
            throw refusal
        })

        expect(() => container.resolve(TOKEN)).toThrow(refusal)
    })

    it("stops the walk at the throwing hook", () => {
        const TOKEN = Symbol("halted")
        const order: string[] = []

        const container = new Container()
        container.register({ provide: TOKEN, useValue: "v" })
        container.on("afterMaterialize", () => order.push("first"))
        container.on("afterMaterialize", () => {
            throw new Error("refused")
        })
        container.on("afterMaterialize", () => order.push("third"))

        expect(() => container.resolve(TOKEN)).toThrow("refused")
        expect(order).toEqual(["first"])
    })

    it("leaves the frame slot clean, so the next read is unaffected", () => {
        class Service {}
        const TOKEN = Symbol("clean")

        const container = new Container()
        container.register([Service, { provide: TOKEN, useValue: "v" }])
        const detach = container.on("beforeMaterialize", () => {
            throw new Error("refused")
        })

        expect(() => container.resolve(Service)).toThrow("refused")
        detach()

        expect(container.resolve(TOKEN)).toBe("v")
        expect(container.resolve(Service)).toBeInstanceOf(Service)
    })
})

// The registry — order, disposal, reentrancy
// ========================================
//
// A container holds a LIST per event, and `on` appends to it. That is what lets the layer above observe for
// its own bookkeeping while user code observes the same event afterwards, without either one unhooking the
// other — a failure that would be silent, since a displaced hook throws nothing and asserts nothing.

describe("the hook registry", () => {
    it("notifies in registration order", () => {
        const order: string[] = []
        const TOKEN = Symbol("ordered")

        const container = new Container()
        container.register({ provide: TOKEN, useValue: "v" })
        container.on("afterMaterialize", () => order.push("first"))
        container.on("afterMaterialize", () => order.push("second"))
        container.on("afterMaterialize", () => order.push("third"))

        container.resolve(TOKEN)

        expect(order).toEqual(["first", "second", "third"])
    })

    it("keeps the events apart", () => {
        const TOKEN = Symbol("separate")
        const seen: string[] = []

        const container = new Container()
        container.register({ provide: TOKEN, useValue: "v" })
        container.on("beforeResolution", () => seen.push("beforeResolution"))
        container.on("beforeMaterialize", () => seen.push("beforeMaterialize"))

        container.resolve(TOKEN)
        container.resolve(TOKEN)

        expect(seen).toEqual(["beforeResolution", "beforeMaterialize", "beforeResolution"])
    })

    it("detaches exactly the hook the disposer came from", () => {
        const TOKEN = Symbol("detached")
        const order: string[] = []

        const container = new Container()
        container.register({ provide: TOKEN, useClass: class {}, scope: Scope.Transient })
        container.on("afterMaterialize", () => order.push("kept"))
        const detach = container.on("afterMaterialize", () => order.push("dropped"))

        container.resolve(TOKEN)
        detach()
        container.resolve(TOKEN)

        expect(order).toEqual(["kept", "dropped", "kept"])
    })

    it("is a no-op to dispose twice", () => {
        const TOKEN = Symbol("twice")
        const order: string[] = []

        const container = new Container()
        container.register({ provide: TOKEN, useClass: class {}, scope: Scope.Transient })
        const first = container.on("afterMaterialize", () => order.push("first"))
        container.on("afterMaterialize", () => order.push("second"))

        first()
        first()
        container.resolve(TOKEN)

        expect(order).toEqual(["second"])
    })

    it("keeps the same function attached twice, and detaches one attachment per disposer", () => {
        const TOKEN = Symbol("duplicated")
        let calls = 0
        const hook = (): void => {
            calls += 1
        }

        const container = new Container()
        container.register({ provide: TOKEN, useClass: class {}, scope: Scope.Transient })
        const detach = container.on("afterMaterialize", hook)
        container.on("afterMaterialize", hook)

        container.resolve(TOKEN)
        expect(calls).toBe(2)

        detach()
        container.resolve(TOKEN)
        expect(calls).toBe(3)
    })

    it("does not drag a hook registered mid-notification into the walk that is already running", () => {
        const order: string[] = []
        const TOKEN = Symbol("reentrant")
        class Service {}

        const container = new Container()
        container.register({ provide: TOKEN, useClass: Service, scope: Scope.Transient })
        container.on("afterMaterialize", () => {
            order.push("first")
            container.on("afterMaterialize", () => order.push("late"))
        })

        container.resolve(TOKEN)
        expect(order).toEqual(["first"])

        // It joins for the next event, which for a transient is the very next read.
        order.length = 0
        container.resolve(TOKEN)
        expect(order).toEqual(["first", "late"])
    })

    it("lets a hook detach itself mid-walk without disturbing the walk", () => {
        const order: string[] = []
        const TOKEN = Symbol("self-detaching")

        const container = new Container()
        container.register({ provide: TOKEN, useClass: class {}, scope: Scope.Transient })
        const detach = container.on("afterMaterialize", () => {
            order.push("once")
            detach()
        })
        container.on("afterMaterialize", () => order.push("always"))

        container.resolve(TOKEN)
        container.resolve(TOKEN)

        expect(order).toEqual(["once", "always", "always"])
    })

    it("observes without intercepting — a hook cannot change what a read hands out", () => {
        const TOKEN = Symbol("original")
        const original = { name: "original" }

        const container = new Container()
        container.register({ provide: TOKEN, useValue: original })

        // The listener signature says `void`, and the dispatcher returns the original whatever a hook does.
        container.on("afterMaterialize", () => ({ name: "replaced" }) as never)
        container.on("afterResolution", () => undefined)

        expect(container.resolve(TOKEN)).toBe(original)
    })

    it("adds nothing observable when nothing is attached", () => {
        // The hot-path pin: the empty case is what every read pays, so what it must cost is nothing at all.
        const TOKEN = Symbol("silent")
        class Service {}
        let built = 0

        const container = new Container()
        container.register([
            Service,
            {
                provide: TOKEN,
                useFactory: () => {
                    built += 1
                    return { built }
                },
                scope: Scope.Transient,
            },
        ])

        // Attached and immediately detached: the registry is empty again, and a detached hook is not called.
        const hook = vi.fn()
        for (const event of ["beforeResolution", "afterResolution", "beforeMaterialize", "afterMaterialize"] as const) {
            container.on(event, hook)()
        }

        const singleton = container.resolve(Service)
        expect(container.resolve(Service)).toBe(singleton)
        expect(container.resolve(TOKEN)).not.toBe(container.resolve(TOKEN))
        expect(built).toBe(2)
        expect(hook).not.toHaveBeenCalled()
    })

    it("mints no snapshot at all when nothing is attached", () => {
        // The fast path measured rather than asserted. A snapshot is the only thing a read freezes — the
        // metadata bag is the other `Object.freeze` in the kernel and it is sealed at REGISTRATION, so a
        // metadata-free registration leaves snapshot minting as the only source in a read.
        //
        // This is what makes the four `if (listeners.length === 0) return` guards test-guarded rather than
        // ruling-guarded: delete any one of them and its `#notify` builds a payload anyway, minting a
        // snapshot for nobody — and the zero below becomes a one.
        const TOKEN = Symbol("unfrozen")
        const container = new Container()
        container.register({ provide: TOKEN, useValue: "v" })

        const freeze = vi.spyOn(Object, "freeze")

        try {
            container.resolve(TOKEN)
            expect(freeze).not.toHaveBeenCalled()

            // One hook, one event that reaches it: a cache hit fires the resolution pair and nothing else,
            // and only `beforeResolution` is listened to. Exactly one snapshot is minted, for that hook.
            container.on("beforeResolution", () => {})
            freeze.mockClear()

            container.resolve(TOKEN)
            expect(freeze).toHaveBeenCalledTimes(1)
        } finally {
            freeze.mockRestore()
        }
    })

    it("mints exactly one snapshot per event that fires, on each of the four", () => {
        // The other half of the pin above, and what makes it discriminate: each `#notify` mints ONE
        // snapshot when it fires. So the zero measured with nothing attached is attributable to the guards
        // and to nothing else — remove any one guard and that event's payload gets built for an empty
        // list, turning the zero into a one.
        for (const event of ["beforeResolution", "afterResolution", "beforeMaterialize", "afterMaterialize"] as const) {
            const TOKEN = Symbol(`one-per-${event}`)
            const container = new Container()
            container.register({ provide: TOKEN, useValue: "v" })
            container.on(event, () => {})

            const freeze = vi.spyOn(Object, "freeze")
            try {
                // A first read fires all four; only the one with a listener mints anything.
                container.resolve(TOKEN)
                expect(freeze, `${event} minted the wrong number of snapshots`).toHaveBeenCalledTimes(1)
            } finally {
                freeze.mockRestore()
            }
        }
    })
})

describe("a hook that resolves", () => {
    // `afterMaterialize` runs AFTER the instance is cached and AFTER `runInFrame` has returned. Both halves
    // of that are observable, and neither is obvious from the call site:
    //
    //   cached first  — a hook resolving the token it was just notified about gets the instance it was
    //                   handed, instead of recursing into a second construction and notifying itself forever.
    //   frame closed  — for a root read there is no ambient frame during notification, so a hook can call
    //                   `container.resolve()` but not bare `inject()`.

    it("does not recurse when the hook resolves the token it is being notified about", () => {
        class Service {}

        const container = new Container()
        container.register(Service)

        const seen: Service[] = []
        let reentrant: Service | undefined
        container.on("afterMaterialize", ({ instance }) => {
            seen.push(instance as Service)
            reentrant = container.resolve(Service)
        })

        const resolved = container.resolve(Service)

        expect(seen).toHaveLength(1)
        expect(reentrant).toBe(resolved)
    })

    it("lets a hook resolve a DIFFERENT token, and reports that one too", () => {
        class Other {}
        class Service {}

        const container = new Container()
        container.register([Service, Other])

        const order: unknown[] = []
        container.on("afterMaterialize", ({ snapshot }) => {
            order.push(snapshot.token)
            if (snapshot.token === Service) container.resolve(Other)
        })

        container.resolve(Service)

        expect(order).toEqual([Service, Other])
    })

    it("resolves a transient a second time when the hook asks for one", () => {
        // A transient has no cache to short-circuit on, so the hook's read really does construct again —
        // and that construction reports too. One level, not an infinite regress, because the second
        // instance's notification is the one that stops asking.
        const TOKEN = Symbol("TRANSIENT")
        class Service {}

        const container = new Container()
        container.register({ provide: TOKEN, useClass: Service, scope: Scope.Transient })

        let built = 0
        container.on("afterMaterialize", () => {
            built += 1
            if (built === 1) container.resolve(TOKEN)
        })

        container.resolve(TOKEN)

        expect(built).toBe(2)
    })
})
