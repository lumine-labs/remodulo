import { describe, expect, it, vi } from "vitest"

import { Container } from "../../src/container.js"
import { Scope } from "../../src/container.types.js"
import { inject, injectAll, injectOptional, runInInjectionContext } from "../../src/injector.js"

// `{ delayed: true }` — the ask, deferred.
// ========================================
//
// Every read injector takes the same second argument, and `delayed` turns what it returns into a thunk
// over that same read. The container is captured at construction time exactly as an eager read captures
// it; only the ASK moves.
//
// What a thunk does NOT do is remember the answer. The container already decides what a repeat ask means —
// a singleton is cached there, a transient is not — so a thunk-level cache would freeze a transient into a
// per-thunk singleton and hide every repeat ask from the resolution plane. Delayed is a deferred ask, not
// a memoised one.
//
// Everything else about it is the frame's ordinary contract, which is why this file mirrors
// `inject-resolver.test.ts`: the declaring-container anchor, the sites a frame is open at, and a throw
// rather than a null outside one.

const TOKEN = Symbol("TOKEN")

describe("which container the thunk reads", () => {
    it("is the DECLARING container, not the one the read started from", () => {
        class Service {
            readonly value = inject<string>(TOKEN, { delayed: true })
        }

        const parent = new Container()
        parent.register([{ provide: TOKEN, useValue: "parent" }, Service])
        const child = parent.fork()
        child.register({ provide: TOKEN, useValue: "child" })

        // The thunk is called from outside any frame, long after construction, and still reads the
        // container that built the service.
        expect(child.resolve(Service).value()).toBe("parent")
    })

    it("is the descendant's world when the descendant declared the binding", () => {
        class Service {
            readonly viaInject = inject<string>(TOKEN)
            readonly viaDelayed = inject<string>(TOKEN, { delayed: true })
        }

        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent" })
        const child = parent.fork()
        child.register([{ provide: TOKEN, useValue: "child" }, Service])

        const service = child.resolve(Service)

        expect(service.viaDelayed()).toBe(service.viaInject)
        expect(service.viaDelayed()).toBe("child")
    })

    it("honours the mode it was given", () => {
        class Service {
            readonly nearest = inject<string>(TOKEN, { delayed: true })
            readonly own = inject<string>(TOKEN, { mode: "self", delayed: true })
        }

        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent" })
        const child = parent.fork()
        child.register(Service)

        const service = child.resolve(Service)

        // `Service` is the child's, so `self` is the child — which declares no TOKEN of its own.
        expect(service.nearest()).toBe("parent")
        expect(() => service.own()).toThrow(/not registered in this container/)
    })
})

describe("the deferral", () => {
    it("constructs nothing until the thunk is called", () => {
        const built: string[] = []
        class Dependency {
            constructor() {
                built.push("dependency")
            }
        }
        class Service {
            readonly dependency = inject(Dependency, { delayed: true })
        }

        const container = new Container()
        container.register([Dependency, Service])

        const service = container.resolve(Service)
        expect(built).toEqual([])

        service.dependency()
        expect(built).toEqual(["dependency"])
    })

    it("hands back the container's singleton, the same instance every call", () => {
        class Dependency {}
        class Service {
            readonly dependency = inject(Dependency, { delayed: true })
        }

        const container = new Container()
        container.register([Dependency, Service])
        const service = container.resolve(Service)

        expect(service.dependency()).toBe(service.dependency())
        expect(service.dependency()).toBe(container.resolve(Dependency))
    })

    it("hands back a FRESH transient every call, which a memoised thunk could not", () => {
        // The pin that distinguishes a deferred ask from a remembered one. A thunk-level cache would make
        // this transient a per-thunk singleton, and the caller would have no way to tell.
        class Transient {}
        class Service {
            readonly transient = inject(Transient, { delayed: true })
        }

        const container = new Container()
        container.register([{ provide: Transient, useClass: Transient, scope: Scope.Transient }, Service])
        const service = container.resolve(Service)

        const first = service.transient()
        const second = service.transient()

        expect(first).not.toBe(second)
        expect(first).toBeInstanceOf(Transient)
    })
})

describe("what the hook plane sees", () => {
    it("announces every call, because every call is a read", () => {
        class Transient {}
        class Service {
            readonly transient = inject(Transient, { delayed: true })
        }
        const announced: string[] = []

        const container = new Container()
        container.register([{ provide: Transient, useClass: Transient, scope: Scope.Transient }, Service])
        const service = container.resolve(Service)

        container.on("beforeResolution", () => announced.push("before"))
        container.on("afterResolution", () => announced.push("after"))

        service.transient()
        service.transient()

        // Two asks, two pairs. A memoised thunk would report the first and swallow the second.
        expect(announced).toEqual(["before", "after", "before", "after"])
    })

    it("announces a cache hit too, for a singleton asked twice", () => {
        class Dependency {}
        class Service {
            readonly dependency = inject(Dependency, { delayed: true })
        }
        const resolution: string[] = []
        const materialization: string[] = []

        const container = new Container()
        container.register([Dependency, Service])
        const service = container.resolve(Service)

        container.on("afterResolution", () => resolution.push("read"))
        container.on("afterMaterialize", () => materialization.push("built"))

        service.dependency()
        service.dependency()

        // Both asks are reads; only the first is a construction.
        expect(resolution).toEqual(["read", "read"])
        expect(materialization).toEqual(["built"])
    })
})

describe("the circular pair it exists for", () => {
    it("lets two services reach each other, one of them lazily", () => {
        // The legitimate cycle-break: `Alpha` defers its ask, so constructing it does not re-enter `Beta`.
        // A plain `inject` on both sides is the cycle the container refuses, and rightly.
        class Alpha {
            readonly beta = inject<Beta>("beta", { delayed: true })
            readonly name = "alpha"
        }
        class Beta {
            readonly alpha = inject<Alpha>("alpha")
            readonly name = "beta"
        }

        const container = new Container()
        container.register([
            { provide: "alpha", useClass: Alpha },
            { provide: "beta", useClass: Beta },
        ])

        // Constructing the deferred side succeeds where a mutual `inject` would throw.
        const alpha = container.resolve<Alpha>("alpha")
        expect(alpha.name).toBe("alpha")

        // And the pair closes on the first call, after both halves exist.
        const beta = alpha.beta()
        expect(beta.name).toBe("beta")
        expect(beta.alpha).toBe(alpha)
    })

    it("still refuses a cycle the thunk cannot break", () => {
        // The deferral moves the ask, it does not license a loop: calling the thunk from inside the
        // constructor is the same cycle spelled later in the same frame.
        class Ping {
            readonly pong = inject<Pong>("pong", { delayed: true })
            constructor() {
                this.pong()
            }
        }
        class Pong {
            readonly ping = inject<Ping>("ping")
        }

        const container = new Container()
        container.register([
            { provide: "ping", useClass: Ping },
            { provide: "pong", useClass: Pong },
        ])

        expect(() => container.resolve("ping")).toThrow(/Circular dependency found/)
    })
})

describe("the sites it works at", () => {
    it("works in a field initializer, a constructor body and a useFactory body", () => {
        class FromField {
            readonly get = inject<string>(TOKEN, { delayed: true })
        }
        class FromConstructor {
            readonly get: () => string
            constructor() {
                this.get = inject<string>(TOKEN, { delayed: true })
            }
        }
        const BUILT = Symbol("BUILT")

        const container = new Container()
        container.register([
            { provide: TOKEN, useValue: "value" },
            FromField,
            FromConstructor,
            { provide: BUILT, useFactory: () => ({ get: inject<string>(TOKEN, { delayed: true }) }) },
        ])

        expect(container.resolve(FromField).get()).toBe("value")
        expect(container.resolve(FromConstructor).get()).toBe("value")
        expect(container.resolve<{ get: () => string }>(BUILT).get()).toBe("value")
    })

    it("works under runInInjectionContext, anchored at the container it was passed", () => {
        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent" })
        const child = parent.fork()
        child.register({ provide: TOKEN, useValue: "child" })

        const fromParent = runInInjectionContext(parent, () => inject<string>(TOKEN, { delayed: true }))
        const fromChild = runInInjectionContext(child, () => inject<string>(TOKEN, { delayed: true }))

        // Both thunks are called after the frame has closed, and each still knows its anchor.
        expect(fromParent()).toBe("parent")
        expect(fromChild()).toBe("child")
    })
})

describe("outside a construction frame", () => {
    it("throws rather than handing back a thunk that could never read", () => {
        expect(() => inject(TOKEN, { delayed: true })).toThrow(/was called outside a construction frame/)
    })

    it("names the READER and the token, and carries the shared code and caller", () => {
        const thrown = ((): { code?: string; caller?: string; message: string } => {
            try {
                inject(TOKEN, { delayed: true })
                return { message: "" }
            } catch (error) {
                return error as { code?: string; caller?: string; message: string }
            }
        })()

        expect(thrown.message.startsWith("inject(TOKEN) was called outside a construction frame.")).toBe(true)
        expect(thrown.code).toBe("REMODULO/INJECTION_CONTEXT")
        expect(thrown.caller).toBe("inject")
    })

    it("is the CAPTURE that needs the frame, never the call", () => {
        class Service {
            readonly get = inject<string>(TOKEN, { delayed: true })
        }

        const container = new Container()
        container.register([{ provide: TOKEN, useValue: "value" }, Service])
        const service = container.resolve(Service)

        // No ambient frame here at all, and the thunk still reads — the container was captured, not looked up.
        expect(service.get()).toBe("value")
    })
})

describe("the thunk itself", () => {
    it("is a fresh function per call, and never memoises", () => {
        const spy = vi.fn(() => ({}))
        class Service {
            readonly first = inject(TOKEN, { delayed: true })
            readonly second = inject(TOKEN, { delayed: true })
        }

        const container = new Container()
        container.register([{ provide: TOKEN, useFactory: spy, scope: Scope.Transient }, Service])
        const service = container.resolve(Service)

        expect(service.first).not.toBe(service.second)

        service.first()
        service.first()
        service.second()

        // Three asks, three factory runs: neither the thunk nor the pair of them remembers anything.
        expect(spy).toHaveBeenCalledTimes(3)
    })
})

// The same flag on the other two readers
// ========================================
//
// `delayed` is a property of the read family, not of `inject`: the collection reader and the tolerant
// reader take it too, and each defers exactly its own read.

describe("injectAll with delayed", () => {
    const PLUGINS = Symbol("PLUGINS")

    it("defers the collection read and reads it fresh on every call", () => {
        class Transient {}
        class Service {
            readonly plugins = injectAll<Transient>(PLUGINS, { delayed: true })
        }
        let built = 0

        const container = new Container()
        container.register([
            {
                provide: PLUGINS,
                useFactory: () => {
                    built += 1
                    return new Transient()
                },
                scope: Scope.Transient,
                multi: true,
            },
            Service,
        ])

        const service = container.resolve(Service)
        expect(built).toBe(0)

        const first = service.plugins()
        const second = service.plugins()

        // A fresh ARRAY as well as fresh members: the thunk holds neither.
        expect(first).not.toBe(second)
        expect(first[0]).not.toBe(second[0])
        expect(built).toBe(2)
    })

    it("announces one pair per member on every call", () => {
        const announced: unknown[] = []
        class Service {
            readonly plugins = injectAll<string>(PLUGINS, { delayed: true })
        }

        const container = new Container()
        container.register([
            { provide: PLUGINS, useValue: "a", multi: true },
            { provide: PLUGINS, useValue: "b", multi: true },
            Service,
        ])
        const service = container.resolve(Service)

        container.on("afterResolution", ({ instance }) => announced.push(instance))
        service.plugins()
        service.plugins()

        expect(announced).toEqual(["a", "b", "a", "b"])
    })

    it("reads an empty collection as an empty array, every time", () => {
        const EMPTY = Symbol("EMPTY")
        class Service {
            readonly plugins = injectAll(EMPTY, { delayed: true })
        }

        const container = new Container()
        container.register(Service)
        const service = container.resolve(Service)

        expect(service.plugins()).toEqual([])
        expect(service.plugins()).not.toBe(service.plugins())
    })

    it("honours the collection mode", () => {
        class Service {
            readonly chained = injectAll<string>(PLUGINS, { delayed: true })
            readonly own = injectAll<string>(PLUGINS, { mode: "self", delayed: true })
        }

        const root = new Container()
        root.register({ provide: PLUGINS, useValue: "root", multi: true })
        const leaf = root.fork()
        leaf.register([{ provide: PLUGINS, useValue: "leaf", multi: true }, Service])

        const service = leaf.resolve(Service)

        expect(service.chained()).toEqual(["leaf", "root"])
        expect(service.own()).toEqual(["leaf"])
    })

    it("throws outside a frame, naming injectAll", () => {
        const thrown = ((): { caller?: string; message: string } => {
            try {
                injectAll(PLUGINS, { delayed: true })
                return { message: "" }
            } catch (error) {
                return error as { caller?: string; message: string }
            }
        })()

        expect(thrown.message.startsWith("injectAll(PLUGINS) was called outside a construction frame.")).toBe(true)
        expect(thrown.caller).toBe("injectAll")
    })
})

describe("injectOptional with delayed", () => {
    const MAYBE = Symbol("MAYBE")

    it("defers the read and answers undefined for a token nobody registered", () => {
        class Service {
            readonly maybe = injectOptional<string>(MAYBE, { delayed: true })
        }

        const container = new Container()
        container.register(Service)
        const service = container.resolve(Service)

        expect(service.maybe()).toBeUndefined()
    })

    it("reads a token registered AFTER the holder was constructed", () => {
        // The deferral is the whole point here: an eager `injectOptional` would have missed it.
        class Service {
            readonly maybe = injectOptional<string>(MAYBE, { delayed: true })
        }

        const container = new Container()
        container.register(Service)
        const service = container.resolve(Service)
        expect(service.maybe()).toBeUndefined()

        container.register({ provide: MAYBE, useValue: "late" })
        expect(service.maybe()).toBe("late")
    })

    it("honours the mode, and throws outside a frame naming injectOptional", () => {
        class Service {
            readonly own = injectOptional<string>(MAYBE, { mode: "self", delayed: true })
        }

        const parent = new Container()
        parent.register({ provide: MAYBE, useValue: "parent" })
        const child = parent.fork()
        child.register(Service)

        expect(child.resolve(Service).own()).toBeUndefined()

        const thrown = ((): { caller?: string } => {
            try {
                injectOptional(MAYBE, { delayed: true })
                return {}
            } catch (error) {
                return error as { caller?: string }
            }
        })()
        expect(thrown.caller).toBe("injectOptional")
    })
})

// `delayed` is the LITERAL `true`
// ========================================
//
// An overload is chosen at compile time, so a flag whose value is only known at runtime cannot choose one.
// Typing it `boolean` would mean picking an arm anyway and lying about the return type in half the calls;
// typing it `true` refuses the call instead. Checked by `typecheck:tests`. Never called.

declare const condition: boolean

function delayedIsALiteral(): void {
    const TOKEN = Symbol("TOKEN")

    // The literal picks the thunk arm, and omitting it picks the value arm.
    const thunk: () => string = inject<string>(TOKEN, { delayed: true })
    const value: string = inject<string>(TOKEN)
    const withMode: string = inject<string>(TOKEN, { mode: "self" })
    void [thunk, value, withMode]

    // @ts-expect-error a computed flag cannot choose an overload, so it is refused outright.
    inject<string>(TOKEN, { delayed: condition })

    // @ts-expect-error and `false` is not a spelling of "eager" — omit the key instead.
    inject<string>(TOKEN, { delayed: false })

    // @ts-expect-error the thunk arm returns a function, never the value.
    const notAValue: string = inject<string>(TOKEN, { delayed: true })
    void notAValue

    // @ts-expect-error and the eager arm returns the value, never a function.
    const notAThunk: () => string = inject<string>(TOKEN)
    void notAThunk

    // The same on the other two readers.
    const plugins: () => string[] = injectAll<string>(TOKEN, { delayed: true })
    const maybe: () => string | undefined = injectOptional<string>(TOKEN, { delayed: true })
    void [plugins, maybe]

    // @ts-expect-error computed flags are refused there too.
    injectAll<string>(TOKEN, { delayed: condition })

    // @ts-expect-error including on the tolerant reader.
    injectOptional<string>(TOKEN, { delayed: condition })

    // @ts-expect-error the positional mode spelling is gone; mode lives in the params object.
    inject<string>(TOKEN, "self")
}
void delayedIsALiteral
