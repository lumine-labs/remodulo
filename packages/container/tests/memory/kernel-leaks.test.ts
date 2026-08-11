import { beforeAll, describe, expect, it } from "vitest"

import { Container } from "../../src/container.js"
import { Resolver } from "../../src/resolver.js"
import { Scope, type AfterResolutionEvent } from "../../src/container.types.js"
import { activeFrame } from "../../src/frame.js"
import { inject } from "../../src/injector.js"
import { LeakTracker, assertGcEnabled, scrub } from "./gc.js"

// Kernel leak detection
// ========================================
//
// The container has exactly two places a reference can outlive its owner, and this file is one test per
// retaining edge rather than one churn scenario:
//
//   1. Per-container state — `#entries`, `#order`, `#modes`, `#aliasTargets`, `#hooks`, and the `cache`
//      hanging off each `Entry`. All of it is owned by the Container instance, so the claim is that
//      dropping the container drops the graph. There is no kernel-global registry for it to also live in,
//      and "there is no registry" is only a claim until something asserts the consequence.
//   2. `frame.ts`'s `currentFrame` — a MODULE-GLOBAL slot. It is restored in a `finally`, so a completed
//      read leaves it null. The interesting case is the throwing read: a stale frame there would pin the
//      container, the whole request cache and the token chain for the lifetime of the process, and it
//      would do so invisibly, because the next read overwrites the slot and the tests all still pass.
//      That is the regression class this file exists for.
//
// Reachability discipline: every scenario runs inside its own function. A tracked object held in a test
// function's local is reachable by definition — see the note at the top of gc.ts.

describe("kernel: what survives a dropped container", () => {
    beforeAll(() => {
        assertGcEnabled()
    })

    it("lets a dropped container's singleton instances go", async () => {
        const tracker = new LeakTracker()

        buildGraphAndDrop(tracker)
        await scrub(() => {
            buildGraphAndDrop(new LeakTracker())
        })

        console.log(`\n[dropped container]\n${tracker.report()}\n`)
        expect(tracker.aliveByLabel()).toEqual({})
    })

    it("lets a hook's closure die with the container that held it", async () => {
        // `on` pushes the hook onto the container's own per-event list, and nothing else refers to it —
        // deliberately, so a fork inherits none of it and no kernel-global registry outlives the container.
        // The cost of that choice is that the hook outlives nothing and everything it closed over is only
        // as reachable as the container. `Sink` is what the closure captures, and it is tracked separately
        // from the instances so the report says which of the two survived.
        const tracker = new LeakTracker()

        observeAndDrop(tracker)
        await scrub(() => {
            observeAndDrop(new LeakTracker())
        })

        console.log(`\n[dropped listener]\n${tracker.report()}\n`)
        expect(tracker.aliveByLabel()).toEqual({})
    })

    it("lets a container that was viewed through `Resolver.for` go, cache entry and all", async () => {
        // `Resolver.#cache` is the one process-lived table the kernel keeps, so it is the one place a
        // container could be retained for the life of the process. It is a WeakMap, and the resolver it
        // holds strongly references the container it views — the pair is exactly the ephemeron cycle a
        // `Map` would leak and a `WeakMap` does not. `Resolver` is tracked separately from the container so
        // the report says which of the two survived.
        const tracker = new LeakTracker()

        viewAndDrop(tracker)
        await scrub(() => {
            viewAndDrop(new LeakTracker())
        })

        console.log(`\n[canonical resolver]\n${tracker.report()}\n`)
        expect(tracker.aliveByLabel()).toEqual({})
    })

    it("leaves the module-global frame holding nothing after a completed read or either throwing one", async () => {
        // Three ways out of a root read, all three unwinding through the same `finally` in `runInFrame`.
        // The two throwing paths are the ones worth the test: a cycle throws from `#assertAcyclic` with
        // frames already pushed, and a missing binding throws from `#readSingle` underneath a frame that
        // the outer construction pushed. Either one leaving `currentFrame` set would pin its container.
        const tracker = new LeakTracker()

        completedRead(tracker)
        expect(activeFrame()).toBeNull()

        cyclicRead(tracker)
        expect(activeFrame()).toBeNull()

        missingBindingRead(tracker)
        expect(activeFrame()).toBeNull()

        await scrub(() => {
            completedRead(new LeakTracker())
            cyclicRead(new LeakTracker())
            missingBindingRead(new LeakTracker())
        })

        console.log(`\n[frame slot]\n${tracker.report()}\n`)
        expect(tracker.aliveByLabel()).toEqual({})
    })
})

describe("kernel: what a LIVE container does not retain", () => {
    beforeAll(() => {
        assertGcEnabled()
    })

    it("collects a request-scoped instance once the read that created it has returned", async () => {
        // The sharper spelling of the claim: the container stays alive for the whole test, so a survivor
        // here is the request cache itself being retained rather than the container being retained.
        //
        // `Root` is transient on purpose. As a singleton it would be cached on the entry and would hold
        // its `Shared` field forever — correctly, and the test would be pinning the wrong thing.
        const container = new Container()
        container.register({ provide: Shared, useClass: Shared, scope: Scope.Request })
        container.register({ provide: Root, useClass: Root, scope: Scope.Transient })

        const tracker = new LeakTracker()

        readRequestScoped(tracker, container)
        await scrub(() => {
            readRequestScoped(new LeakTracker(), container)
        })

        console.log(`\n[request cache]\n${tracker.report()}\n`)
        expect(tracker.aliveByLabel()).toEqual({})

        // The container really was alive the whole time, so the collection above was not a side effect of
        // the container going first.
        expect(container.isRegistered(Shared)).toBe(true)
    })

    it("collects a hook's closure once its disposer has run, with the container still serving reads", async () => {
        // The other release path. The dropped-container cell above proves a hook dies WITH its container;
        // this one proves the disposer frees it while the container lives on — which is the path a
        // long-lived container actually takes, and the one where a leak would accumulate rather than
        // vanish with the owner. `on` splices the listener out of its event's list, so what has to become
        // unreachable is the closure and everything it captured, with the registry itself untouched.
        const container = new Container()
        container.register(Dependency)

        const tracker = new LeakTracker()

        observeAndDispose(tracker, container)
        await scrub(() => {
            observeAndDispose(new LeakTracker(), container)
        })

        console.log(`\n[disposed listener]\n${tracker.report()}\n`)
        expect(tracker.aliveByLabel()).toEqual({})

        // The container was strongly held for the whole cell, so the collection above is attributable to
        // the disposer and not to the container dying — and it still reads, so the registry survived the
        // splice intact.
        expect(container.resolve(Dependency)).toBeInstanceOf(Dependency)
    })

    it("keeps a twice-attached hook's closure while one of its two registrations remains", async () => {
        // The counterweight to the cell above, and the reason a disposer is per-ATTACHMENT rather than per
        // function: the same hook attached twice is two registrations, so one disposer must leave the
        // closure reachable through the other. Asserting survival is the safe direction — a reachable
        // object is never collected — so this discriminates against a disposer that detached both.
        const container = new Container()
        container.register(Dependency)

        const tracker = new LeakTracker()

        attachTwiceAndDisposeOnce(tracker, container)
        await scrub(() => {
            attachTwiceAndDisposeOnce(new LeakTracker(), container)
        })

        // The only cell in this file whose PASS condition is a survivor, so the label says so — `RETAINED 1`
        // in the report below is the expected reading, not the failure it is everywhere else.
        console.log(`\n[half-disposed listener — RETAINED 1 is the pass]\n${tracker.report()}\n`)
        expect(tracker.aliveCount("HalfDisposedSink")).toBe(1)
    })

    it("does not retain what `construct` builds", async () => {
        // `construct` builds in the container's context without registering the class or anything it
        // reaches, so there is no entry to cache the instance on and nothing should hold it. Its injected
        // singleton dependency is a different matter — that one IS the container's, and stays.
        const container = new Container()
        container.register(Dependency)

        const tracker = new LeakTracker()
        const dependency = container.resolve(Dependency)

        constructAndDrop(tracker, container)
        await scrub(() => {
            constructAndDrop(new LeakTracker(), container)
        })

        console.log(`\n[construct]\n${tracker.report()}\n`)
        expect(tracker.aliveByLabel()).toEqual({})

        // The counterweight: the registered singleton the constructed instances injected is still the
        // container's own, and is still there. Otherwise "nothing survived" could just mean "nothing built".
        expect(container.resolve(Dependency)).toBe(dependency)
    })
})

// Fixtures
// ========================================

class Dependency {
    readonly payload = new Array(2_000).fill("dependency")
}

class Consumer {
    readonly dependency = inject(Dependency)
    readonly payload = new Array(2_000).fill("consumer")
}

class Shared {
    readonly payload = new Array(2_000).fill("shared")
}

class Root {
    readonly shared = inject(Shared)
}

class Standalone {
    readonly dependency = inject(Dependency)
    readonly payload = new Array(2_000).fill("standalone")
}

// Scenarios
// ========================================
//
// Each returns void and keeps every reference in its own frame, so the objects are genuinely unreachable
// the moment it returns.

function buildGraphAndDrop(tracker: LeakTracker): void {
    const container = tracker.track("Container", new Container())
    container.register(Dependency)
    container.register(Consumer)

    tracker.track("Consumer", container.resolve(Consumer))
    tracker.track("Dependency", container.resolve(Dependency))
}

function observeAndDrop(tracker: LeakTracker): void {
    const container = tracker.track("Container", new Container())
    container.register(Dependency)

    const sink = tracker.track("Sink", { seen: [] as unknown[] })
    container.on("afterMaterialize", ({ instance }) => {
        sink.seen.push(instance)
    })

    tracker.track("Dependency", container.resolve(Dependency))
    expect(sink.seen).toHaveLength(1)
}

function viewAndDrop(tracker: LeakTracker): void {
    const container = tracker.track("ViewedContainer", new Container())
    container.register(Dependency)

    const resolver = tracker.track("Resolver", Resolver.for(container))
    expect(resolver).toBe(Resolver.for(container))

    tracker.track("ViewedDependency", resolver.resolve(Dependency))
}

function completedRead(tracker: LeakTracker): void {
    const container = tracker.track("CompletedContainer", new Container())
    container.register(Dependency)
    container.register(Consumer)

    tracker.track("CompletedConsumer", container.resolve(Consumer))
}

function cyclicRead(tracker: LeakTracker): void {
    const container = tracker.track("CycleContainer", new Container())

    // Declared here rather than at module scope: as module-level classes they would be reachable from the
    // module record forever, and the tokens are half of what a stale frame's `chain` would be pinning.
    class Ping {
        readonly pong = inject(Pong)
    }
    class Pong {
        readonly ping = inject(Ping)
    }

    container.register(Ping)
    container.register(Pong)
    tracker.track("CycleToken", Ping)
    tracker.track("CycleToken", Pong)

    expect(() => container.resolve(Ping)).toThrow(/Circular dependency found/)
}

function missingBindingRead(tracker: LeakTracker): void {
    const container = tracker.track("MissingContainer", new Container())

    // The throw has to happen UNDER a pushed frame to be worth anything: a bare `resolve` of an
    // unregistered token throws before `runInFrame` is ever reached. Injecting the missing token from a
    // constructor body puts the failure inside the outer construction's frame, which is the unwind path
    // the `finally` exists for.
    class NeedsMissing {
        readonly missing = inject("nothing-is-registered-for-this")
    }

    container.register(NeedsMissing)
    tracker.track("MissingToken", NeedsMissing)

    expect(() => container.resolve(NeedsMissing)).toThrow(/is not registered in this container or any ancestor/)
}

function readRequestScoped(tracker: LeakTracker, container: Container): void {
    const root = container.resolve(Root)
    tracker.track("RequestScoped", root.shared)
}

function constructAndDrop(tracker: LeakTracker, container: Container): void {
    tracker.track("Constructed", container.construct(Standalone))
}

function attachTwiceAndDisposeOnce(tracker: LeakTracker, container: Container): void {
    const sink = tracker.track("HalfDisposedSink", { seen: [] as unknown[] })
    const hook = ({ instance }: AfterResolutionEvent): void => {
        sink.seen.push(instance)
    }

    const detachFirst = container.on("afterResolution", hook)
    container.on("afterResolution", hook)

    // Two registrations, so one read calls it twice; after one disposer, one more read adds ONE. That is
    // the same claim the assertion below makes about reachability, stated in calls rather than in bytes.
    container.resolve(Dependency)
    expect(sink.seen).toHaveLength(2)

    detachFirst()
    container.resolve(Dependency)
    expect(sink.seen).toHaveLength(3)
}

function observeAndDispose(tracker: LeakTracker, container: Container): void {
    const sink = tracker.track("DisposedSink", { seen: [] as unknown[] })
    const detach = container.on("afterResolution", ({ instance }) => {
        sink.seen.push(instance)
    })

    // `afterResolution` rather than a materialization event: the container outlives every round here, so
    // its singleton is built once and every later read is a cache hit. This event fires on those too,
    // which is what makes "the hook demonstrably ran before it was disposed" true on every round.
    container.resolve(Dependency)
    expect(sink.seen).toHaveLength(1)

    detach()
}
