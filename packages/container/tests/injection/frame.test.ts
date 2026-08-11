import { describe, expect, it, vi } from "vitest"

import { Container } from "../../src/container.js"
import { Scope } from "../../src/container.types.js"
import { activeFrame } from "../../src/frame.js"
import { inject, injectAll, injectOptional, runInInjectionContext } from "../../src/injector.js"

// The construction frame.
// ========================================
//
// `inject` is a bare function, not a decorator and not a parameter. It reads ONE module-scope variable: the
// frame the container pushed before it started constructing — "a single synchronous cache of the container
// that's about to construct". Everything in this file is that variable's contract:
//
//   pushed   around every construction and every factory invocation, in a try/finally;
//   nested   inner constructions push their own and restore the outer one on the way out;
//   absent   outside construction, which is an error rather than a silent undefined.
//
// Synchronous by definition. There is no async version and no continuation-local storage: a frame lives
// exactly as long as the call stack that pushed it.

describe("injection sites", () => {
    it("injects into a field initializer", () => {
        class Dependency {}
        class Consumer {
            readonly dependency = inject(Dependency)
        }

        const container = new Container()
        container.register([Dependency, Consumer])

        expect(container.resolve(Consumer).dependency).toBe(container.resolve(Dependency))
    })

    it("injects into a constructor body", () => {
        class Dependency {}
        class Consumer {
            readonly dependency: Dependency
            constructor() {
                this.dependency = inject(Dependency)
            }
        }

        const container = new Container()
        container.register([Dependency, Consumer])

        expect(container.resolve(Consumer).dependency).toBe(container.resolve(Dependency))
    })

    it("injects into both at once, field initializers first", () => {
        // Field initializers run before the constructor body — the ordinary JS rule, and the frame is up
        // for both, so neither site is privileged.
        const order: string[] = []
        class Field {}
        class Body {}
        class Consumer {
            readonly field = ((): Field => {
                order.push("field")
                return inject(Field)
            })()
            readonly body: Body
            constructor() {
                order.push("body")
                this.body = inject(Body)
            }
        }

        const container = new Container()
        container.register([Field, Body, Consumer])
        const consumer = container.resolve(Consumer)

        expect(order).toEqual(["field", "body"])
        expect(consumer.field).toBe(container.resolve(Field))
        expect(consumer.body).toBe(container.resolve(Body))
    })

    it("injects inside a useFactory body", () => {
        const NAME = Symbol("NAME")
        const BUILT = Symbol("BUILT")

        const container = new Container()
        container.register([
            { provide: NAME, useValue: "alpha" },
            { provide: BUILT, useFactory: () => ({ name: inject<string>(NAME) }) },
        ])

        expect(container.resolve<{ name: string }>(BUILT)).toEqual({ name: "alpha" })
    })

    it("takes injectOptional and injectAll at the same sites", () => {
        const PLUGINS = Symbol("PLUGINS")
        const MISSING = Symbol("MISSING")

        class Consumer {
            readonly plugins = injectAll<string>(PLUGINS)
            readonly missing = injectOptional(MISSING)
        }

        const container = new Container()
        container.register([
            { provide: PLUGINS, useValue: "a", multi: true },
            { provide: PLUGINS, useValue: "b", multi: true },
            Consumer,
        ])

        const consumer = container.resolve(Consumer)
        expect(consumer.plugins).toEqual(["a", "b"])
        expect(consumer.missing).toBeUndefined()
    })
})

describe("outside a construction frame", () => {
    it("throws rather than returning undefined", () => {
        class Service {}

        expect(() => inject(Service)).toThrow(/was called outside a construction frame/)
    })

    it("names the caller and the token, and covers all three ways to get here", () => {
        const TOKEN = Symbol("Config")

        const message = ((): string => {
            try {
                inject(TOKEN)
                return ""
            } catch (error) {
                return (error as Error).message
            }
        })()

        expect(message.startsWith("inject(Config) was called outside a construction frame.")).toBe(true)
        // Not in construction at all...
        expect(message).toMatch(/constructor body, a field initializer, or a `useFactory` body/)
        // ...or past the first `await` of an async factory, where the frame is already gone...
        expect(message).toMatch(/BEFORE the first `await`/)
        // ...or two copies of the package, each with its own module-scope frame.
        expect(message).toMatch(/two copies of @remodulo\/container in one process/)
    })

    it("says which function was called", () => {
        const TOKEN = Symbol("T")

        expect(() => injectAll(TOKEN)).toThrow(/^injectAll\(T\) was called outside/)
        expect(() => injectOptional(TOKEN)).toThrow(/^injectOptional\(T\) was called outside/)
    })

    it("is gone again after the construction that opened it returns", () => {
        class Dependency {}
        class Consumer {
            readonly dependency = inject(Dependency)
        }

        const container = new Container()
        container.register([Dependency, Consumer])
        container.resolve(Consumer)

        expect(() => inject(Dependency)).toThrow(/outside a construction frame/)
    })

    it("is gone once an async factory yields", async () => {
        // The rule the error message states, measured: the frame is a synchronous stack discipline, so
        // everything after the first `await` runs with whatever frame is current THEN — none, here.
        const NAME = Symbol("NAME")
        const BUILT = Symbol("BUILT")
        let afterAwait: unknown

        const container = new Container()
        container.register([
            { provide: NAME, useValue: "alpha" },
            {
                provide: BUILT,
                useFactory: async () => {
                    const before = inject<string>(NAME)
                    await Promise.resolve()
                    afterAwait = (() => {
                        try {
                            return inject<string>(NAME)
                        } catch (error) {
                            return error
                        }
                    })()
                    return { before }
                },
            },
        ])

        await container.resolve<Promise<{ before: string }>>(BUILT)

        expect(afterAwait).toBeInstanceOf(Error)
        expect((afterAwait as Error).message).toMatch(/outside a construction frame/)
    })
})

describe("nesting", () => {
    it("restores the outer frame when an inner construction returns", () => {
        // The failure this pins: if the inner construction left ITS frame installed, `second` would be
        // resolved against the wrong container and the wrong graph. Both injects here run in `Outer`'s
        // frame, with a whole construction in between.
        const FIRST = Symbol("FIRST")
        const SECOND = Symbol("SECOND")

        class Inner {
            readonly first = inject<string>(FIRST)
        }
        class Outer {
            readonly before = inject<string>(FIRST)
            readonly inner = inject(Inner)
            readonly after = inject<string>(SECOND)
        }

        const container = new Container()
        container.register([
            { provide: FIRST, useValue: "first" },
            { provide: SECOND, useValue: "second" },
            Inner,
            Outer,
        ])

        const outer = container.resolve(Outer)
        expect([outer.before, outer.inner.first, outer.after]).toEqual(["first", "first", "second"])
    })

    it("restores it across a factory nested inside a constructor and vice versa", () => {
        const LEAF = Symbol("LEAF")
        const VIA_FACTORY = Symbol("VIA_FACTORY")
        const TAIL = Symbol("TAIL")

        class Consumer {
            readonly built = inject<{ leaf: string }>(VIA_FACTORY)
            readonly tail = inject<string>(TAIL)
        }

        const container = new Container()
        container.register([
            { provide: LEAF, useValue: "leaf" },
            { provide: TAIL, useValue: "tail" },
            { provide: VIA_FACTORY, useFactory: () => ({ leaf: inject<string>(LEAF) }) },
            Consumer,
        ])

        const consumer = container.resolve(Consumer)
        expect(consumer.built.leaf).toBe("leaf")
        expect(consumer.tail).toBe("tail")
    })

    it("keeps a three-deep nest anchored correctly at every level", () => {
        const order: string[] = []
        class C {
            constructor() {
                order.push("C")
            }
        }
        class B {
            readonly c = inject(C)
            constructor() {
                order.push("B")
            }
        }
        class A {
            readonly b = inject(B)
            constructor() {
                order.push("A")
            }
        }

        const container = new Container()
        container.register([A, B, C])
        const a = container.resolve(A)

        expect(order).toEqual(["C", "B", "A"])
        expect(a.b.c).toBe(container.resolve(C))
    })
})

describe("a constructor that throws", () => {
    it("propagates the original error unwrapped", () => {
        class Exploding {
            constructor() {
                throw new Error("boom from a constructor")
            }
        }

        const container = new Container()
        container.register(Exploding)

        expect(() => container.resolve(Exploding)).toThrowError("boom from a constructor")
    })

    it("still restores the frame — the next construction injects normally", () => {
        // The try/finally pin. Without it the frame would be left installed by the throwing construction
        // and the next `inject` would silently read the wrong container instead of failing.
        class Dependency {}
        class Exploding {
            constructor() {
                throw new Error("boom")
            }
        }
        class Consumer {
            readonly dependency = inject(Dependency)
        }

        const container = new Container()
        container.register([Dependency, Exploding, Consumer])

        expect(() => container.resolve(Exploding)).toThrow("boom")
        expect(() => inject(Dependency)).toThrow(/outside a construction frame/)
        expect(container.resolve(Consumer).dependency).toBe(container.resolve(Dependency))
    })

    it("restores the OUTER frame when the thrower is nested", () => {
        const TOKEN = Symbol("TOKEN")

        class Exploding {
            constructor() {
                throw new Error("boom")
            }
        }
        class Outer {
            readonly caught: unknown
            readonly token: string
            constructor() {
                try {
                    inject(Exploding)
                    this.caught = null
                } catch (error) {
                    this.caught = error
                }
                // The outer frame is back, so this resolves against the same container as before.
                this.token = inject<string>(TOKEN)
            }
        }

        const container = new Container()
        container.register([{ provide: TOKEN, useValue: "value" }, Exploding, Outer])

        const outer = container.resolve(Outer)
        expect((outer.caught as Error).message).toBe("boom")
        expect(outer.token).toBe("value")
    })
})

describe("runInInjectionContext", () => {
    it("opens a frame so bare inject works outside construction", () => {
        const TOKEN = Symbol("TOKEN")
        const container = new Container()
        container.register({ provide: TOKEN, useValue: "value" })

        expect(runInInjectionContext(container, () => inject<string>(TOKEN))).toBe("value")
    })

    it("returns whatever the callback returns, and closes the frame after", () => {
        const TOKEN = Symbol("TOKEN")
        const container = new Container()
        container.register({ provide: TOKEN, useValue: "value" })

        expect(runInInjectionContext(container, () => [inject<string>(TOKEN), 1])).toEqual(["value", 1])
        expect(() => inject(TOKEN)).toThrow(/outside a construction frame/)
    })

    it("closes the frame when the callback throws", () => {
        const container = new Container()

        expect(() =>
            runInInjectionContext(container, () => {
                throw new Error("from the callback")
            })
        ).toThrow("from the callback")
        expect(() => inject(Symbol("anything"))).toThrow(/outside a construction frame/)
    })

    it("anchors at the container it was given", () => {
        const TOKEN = Symbol("TOKEN")
        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent" })
        const child = parent.fork()
        child.register({ provide: TOKEN, useValue: "child" })

        expect(runInInjectionContext(parent, () => inject<string>(TOKEN))).toBe("parent")
        expect(runInInjectionContext(child, () => inject<string>(TOKEN))).toBe("child")
    })

    it("lends its request graph to everything built inside one call", () => {
        const DEP = Symbol("DEP")
        class Dep {}

        const container = new Container()
        container.register({ provide: DEP, useClass: Dep, scope: "request" })

        const [first, second] = runInInjectionContext(container, () => [inject(DEP), inject(DEP)])
        expect(first).toBe(second)
        expect(runInInjectionContext(container, () => inject(DEP))).not.toBe(first)
    })
})

describe("Container.construct", () => {
    it("builds a class that was never registered", () => {
        class Dependency {}
        class Unregistered {
            readonly dependency = inject(Dependency)
        }

        const container = new Container()
        container.register(Dependency)

        const built = container.construct(Unregistered)
        expect(built).toBeInstanceOf(Unregistered)
        expect(built.dependency).toBe(container.resolve(Dependency))
        expect(container.isRegistered(Unregistered)).toBe(false)
    })

    it("builds a fresh instance every call and caches nothing", () => {
        class Service {}

        const container = new Container()
        expect(container.construct(Service)).not.toBe(container.construct(Service))
    })

    it("anchors at the container it was called on", () => {
        const TOKEN = Symbol("TOKEN")
        class Probe {
            readonly value = inject<string>(TOKEN)
        }

        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent" })
        const child = parent.fork()
        child.register({ provide: TOKEN, useValue: "child" })

        expect(parent.construct(Probe).value).toBe("parent")
        expect(child.construct(Probe).value).toBe("child")
    })

    it("detects a cycle it is part of", () => {
        class Looping {
            readonly self = inject(Looping)
        }

        const container = new Container()
        container.register(Looping)

        expect(() => container.construct(Looping)).toThrow("Circular dependency found: Looping -> Looping")
    })
})

describe("cycles reached through a factory", () => {
    it("throws with the whole printed chain", () => {
        const FACTORY = Symbol("FACTORY")

        class Alpha {
            readonly built = inject(FACTORY)
        }

        const container = new Container()
        container.register([Alpha, { provide: FACTORY, useFactory: () => ({ alpha: inject(Alpha) }) }])

        expect(() => container.resolve(Alpha)).toThrow("Circular dependency found: Alpha -> FACTORY -> Alpha")
    })

    it("reports the cycle from where it closes, not from where the read began", () => {
        const ENTRY = Symbol("ENTRY")
        class Alpha {
            readonly beta = inject(Beta)
        }
        class Beta {
            readonly alpha = inject(Alpha)
        }

        const container = new Container()
        container.register([
            { provide: ENTRY, useFactory: () => inject(Alpha) },
            Alpha,
            Beta,
        ])

        // `ENTRY` opened the read but is not part of the loop, so it is not part of the message.
        expect(() => container.resolve(ENTRY)).toThrow("Circular dependency found: Alpha -> Beta -> Alpha")
    })

    it("leaves the factory-thunk workaround intact", () => {
        // The documented way to close a legitimate cycle: hold an accessor, not the instance, so the
        // dependency is not on the construction path at all.
        const GET_BETA = Symbol("GET_BETA")

        class Alpha {
            readonly getBeta = inject<() => Beta>(GET_BETA)
        }
        class Beta {
            readonly alpha = inject(Alpha)
        }

        const container = new Container()
        container.register([
            Alpha,
            Beta,
            { provide: GET_BETA, useFactory: () => () => container.resolve(Beta) },
        ])

        const alpha = container.resolve(Alpha)
        const beta = container.resolve(Beta)

        expect(beta.alpha).toBe(alpha)
        expect(alpha.getBeta()).toBe(beta)
    })
})

describe("observation sees frame-built instances", () => {
    it("reports a dependency before the instance that injected it", () => {
        const order: string[] = []
        class Dependency {}
        class Dependent {
            readonly dependency = inject(Dependency)
        }

        const container = new Container()
        container.register([Dependency, Dependent])
        container.on("afterMaterialize", ({ snapshot }) => order.push((snapshot.token as { name: string }).name))

        container.resolve(Dependent)

        expect(order).toEqual(["Dependency", "Dependent"])
    })

    it("does not let a hook replace what the injection site receives", () => {
        class Dependency {}
        class Dependent {
            readonly dependency = inject(Dependency)
        }

        const container = new Container()
        container.register([Dependency, Dependent])
        const replace = vi.fn(() => ({ replaced: true }) as never)
        container.on("afterMaterialize", ({ snapshot }) => {
            if (snapshot.token === Dependency) replace()
        })

        expect(container.resolve(Dependent).dependency).toBeInstanceOf(Dependency)
        expect(replace).toHaveBeenCalledTimes(1)
    })
})

describe("the frame slot after a throwing read", () => {
    // `describe("a constructor that throws")` above already pins the restore for a constructor body. The
    // other two ways out of a read throw from somewhere else entirely — `#assertAcyclic` for a cycle, and
    // `#readSingle` for a missing binding — and each unwinds through a different number of nested
    // `runInFrame` calls. A stale frame left by either would not fail anything immediately: the next read
    // would just quietly construct against the wrong container, with the dead graph's request cache and a
    // cycle chain that never empties. So the assertion is made twice, on the slot and on the behaviour.

    it("restores the slot after a circular dependency", () => {
        class Ping {
            readonly pong = inject(Pong)
        }
        class Pong {
            readonly ping = inject(Ping)
        }

        const container = new Container()
        container.register([Ping, Pong])

        expect(() => container.resolve(Ping)).toThrow(/Circular dependency found/)
        expect(activeFrame()).toBeNull()

        // And the next read is a clean one: a fresh graph, injecting normally.
        class Dependency {}
        class Consumer {
            readonly dependency = inject(Dependency)
        }
        container.register([Dependency, Consumer])

        expect(container.resolve(Consumer).dependency).toBe(container.resolve(Dependency))
    })

    it("restores the slot after a required binding is missing", () => {
        class NeedsMissing {
            readonly missing = inject(Symbol("NOT_REGISTERED"))
        }

        const container = new Container()
        container.register(NeedsMissing)

        expect(() => container.resolve(NeedsMissing)).toThrow(/is not registered in this container or any ancestor/)
        expect(activeFrame()).toBeNull()

        class Dependency {}
        class Consumer {
            readonly dependency = inject(Dependency)
        }
        container.register([Dependency, Consumer])

        expect(container.resolve(Consumer).dependency).toBeInstanceOf(Dependency)
    })

    it("leaves no request cache behind for the next graph to inherit", () => {
        // The sharpest consequence of a stale frame, and the one a behavioural check would miss: a request
        // cache that outlived its read would be inherited by the next one, and two supposedly separate
        // graphs would share an instance.
        const container = new Container()

        class Shared {}
        container.register({ provide: Shared, useClass: Shared, scope: Scope.Request })

        class Boom {
            constructor() {
                inject(Shared)
                throw new Error("boom")
            }
        }
        container.register(Boom)

        expect(() => container.resolve(Boom)).toThrow("boom")
        expect(activeFrame()).toBeNull()

        expect(container.resolve(Shared)).not.toBe(container.resolve(Shared))
    })
})
