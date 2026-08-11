import { isObservableProp } from "mobx"
import { describe, expect, it, vi } from "vitest"

import { makeInheritedAutoObservable } from "../src/makeInheritedAutoObservable"
import { ViewModel } from "../src/ViewModel"

// Sealed hooks
// ========================================
//
// The four `onModule*` hooks are the module lifecycle's entry points and the base owns all four. A
// subclass that redefined one would silently drop the teardown the base runs after it, so the base
// refuses the redefinition instead of trying to wrap it: the constructor rejects a prototype override
// and then pins each hook as a non-writable, non-configurable own property of the instance.

const HOOKS = ["onModuleInit", "onModuleMount", "onModuleUnmount", "onModuleDestroy"] as const

const SHORTHANDS = {
    onModuleInit: "onInit",
    onModuleMount: "onMount",
    onModuleUnmount: "onUnmount",
    onModuleDestroy: "onDestroy",
} as const

describe("ViewModel: sealed hooks", () => {
    it("refuses a subclass that redefines any of the four, naming the shorthand to use instead", () => {
        for (const hook of HOOKS) {
            const Sub = class extends ViewModel {}
            Object.defineProperty(Sub.prototype, hook, { value(): void {}, configurable: true, writable: true })

            expect(() => new Sub()).toThrowError(
                new Error(`ViewModel seals ${hook}() — override ${SHORTHANDS[hook]}() instead.`)
            )
        }
    })

    it("refuses an override declared anywhere below the base, not just one level down", () => {
        class Mid extends ViewModel {}
        class Leaf extends Mid {
            override onModuleMount(): void {}
        }

        // The constructor walks the whole chain up to `ViewModel.prototype`, so a grandchild is caught too.
        expect(() => new Leaf()).toThrowError(
            new Error("ViewModel seals onModuleMount() — override onMount() instead.")
        )
    })

    it("closes the field-initializer route as well, which the prototype scan cannot see", () => {
        class VM extends ViewModel {
            // A class field is installed AFTER the base constructor has already sealed the property, and
            // field initialization defines rather than assigns — so the seal is what refuses it.
            override onModuleInit = (): void => {}
        }

        expect(() => new VM()).toThrowError(TypeError)
    })

    it("holds against assignment and redefinition after construction", () => {
        class VM extends ViewModel {}
        const vm = new VM()

        expect(() => {
            vm.onModuleInit = (): void => {}
        }).toThrowError(TypeError)
        expect(() => Object.defineProperty(vm, "onModuleInit", { value: () => {} })).toThrowError(TypeError)
    })

    it("pins each hook as a non-writable, non-enumerable, non-configurable own property", () => {
        class VM extends ViewModel {}
        const vm = new VM()

        for (const hook of HOOKS) {
            expect(Object.getOwnPropertyDescriptor(vm, hook)).toEqual({
                value: ViewModel.prototype[hook],
                writable: false,
                enumerable: false,
                configurable: false,
            })
        }
    })

    it("keeps the sealed hooks out of Object.keys while Reflect.ownKeys still sees them", () => {
        class VM extends ViewModel {
            count = 1
        }

        // Non-enumerable, so the instance still looks like plain state from the outside. `Reflect.ownKeys`
        // is the walk `makeInheritedAutoObservable` uses, and it DOES see them — which is why that walk
        // needs a skip of its own; see the annotation suite.
        expect(Object.keys(new VM())).toEqual(["count"])
        expect(Reflect.ownKeys(new VM())).toEqual([...HOOKS, "count"])
    })
})

// Lifecycle delegation
// ========================================

describe("ViewModel: lifecycle delegation", () => {
    it("routes all four hooks to their shorthand, and runs teardown after onDestroy", () => {
        const log: string[] = []

        class VM extends ViewModel {
            register(): void {
                this.track(() => log.push("disposer"))
            }
            protected override onInit(): void {
                log.push("onInit")
            }
            protected override onMount(): void {
                log.push("onMount")
            }
            protected override onUnmount(): void {
                log.push("onUnmount")
            }
            protected override onDestroy(): void {
                log.push("onDestroy")
            }
        }

        const vm = new VM()
        vm.register()
        vm.onModuleInit()
        vm.onModuleMount()
        vm.onModuleUnmount()
        vm.onModuleDestroy()

        expect(log).toEqual(["onInit", "onMount", "onUnmount", "onDestroy", "disposer"])
    })

    it("treats every shorthand as optional — all four hooks are no-ops on a bare view model", () => {
        class VM extends ViewModel {}
        const vm = new VM()

        expect(() => {
            vm.onModuleInit()
            vm.onModuleMount()
            vm.onModuleUnmount()
            vm.onModuleDestroy()
        }).not.toThrow()
    })
})

// Disposal
// ========================================

describe("ViewModel: disposal", () => {
    it("runs tracked disposers in reverse registration order", () => {
        const order: string[] = []

        class VM extends ViewModel {
            register(): void {
                this.track(() => order.push("first"))
                this.track(() => order.push("second"))
                this.track(() => order.push("third"))
            }
        }

        const vm = new VM()
        vm.register()
        vm.onModuleDestroy()

        expect(order).toEqual(["third", "second", "first"])
    })

    it("returns the disposer from track so it can wrap the call that produced it", () => {
        const disposer = (): void => {}

        class VM extends ViewModel {
            expose(): () => void {
                return this.track(disposer)
            }
        }

        expect(new VM().expose()).toBe(disposer)
    })

    it("runs onDestroy before the tracked disposers, with no super call", () => {
        const order: string[] = []

        class VM extends ViewModel {
            register(): void {
                this.track(() => order.push("disposer"))
            }
            protected override onDestroy(): void {
                order.push("onDestroy")
            }
        }

        const vm = new VM()
        vm.register()
        vm.onModuleDestroy()

        expect(order).toEqual(["onDestroy", "disposer"])
    })

    it("tears down even when onDestroy throws", () => {
        const dispose = vi.fn()
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

        class VM extends ViewModel {
            register(): void {
                this.track(dispose)
            }
            protected override onDestroy(): void {
                throw new Error("override blew up")
            }
        }

        const vm = new VM()
        vm.register()

        // The base runs teardown in a `finally`, so a throwing shorthand still cannot strand a disposer.
        expect(() => vm.onModuleDestroy()).toThrowError("override blew up")
        expect(dispose).toHaveBeenCalledTimes(1)

        consoleError.mockRestore()
    })

    it("isolates a throwing disposer so the rest still run", () => {
        const order: string[] = []
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

        class VM extends ViewModel {
            register(): void {
                this.track(() => order.push("survivor"))
                this.track(() => {
                    throw new Error("disposer blew up")
                })
            }
        }

        const vm = new VM()
        vm.register()
        vm.onModuleDestroy()

        expect(order).toEqual(["survivor"])
        expect(consoleError).toHaveBeenCalled()
        consoleError.mockRestore()
    })

    it("is safe to destroy twice", () => {
        const dispose = vi.fn()

        class VM extends ViewModel {
            register(): void {
                this.track(dispose)
            }
        }

        const vm = new VM()
        vm.register()
        vm.onModuleDestroy()
        vm.onModuleDestroy()

        expect(dispose).toHaveBeenCalledTimes(1)
    })
})

// Abort signal
// ========================================

describe("ViewModel: signal", () => {
    it("hands out one signal per instance and aborts it on destroy", () => {
        class VM extends ViewModel {
            expose(): AbortSignal {
                return this.signal()
            }
        }

        const vm = new VM()
        const signal = vm.expose()

        expect(signal).toBe(vm.expose())
        expect(signal.aborted).toBe(false)

        vm.onModuleDestroy()

        expect(signal.aborted).toBe(true)
    })

    it("aborts after onDestroy runs, so a final request can still use the signal", () => {
        let abortedDuringOverride: boolean | null = null

        class VM extends ViewModel {
            protected override onDestroy(): void {
                abortedDuringOverride = this.signal().aborted
            }
        }

        const vm = new VM()
        vm.onModuleDestroy()

        expect(abortedDuringOverride).toBe(false)
    })
})

// Interaction with makeInheritedAutoObservable
// ========================================

describe("ViewModel: observability", () => {
    class CounterVM extends ViewModel {
        count = 1

        constructor() {
            super()
            makeInheritedAutoObservable(this, {}, { autoBind: true })
        }

        inc(): void {
            this.count++
        }

        register(disposer: () => void): void {
            this.track(disposer)
        }
    }

    it("annotates subclass state while leaving the base's bookkeeping invisible", () => {
        const vm = new CounterVM()

        expect(isObservableProp(vm, "count")).toBe(true)
        // `#` private fields are unreachable by `Reflect.ownKeys`, so the annotation walk never sees the
        // disposer list or the abort controller.
        expect(Object.keys(vm)).toEqual(["count"])
    })

    it("leaves the four sealed hooks unannotated, and still callable", () => {
        const vm = new CounterVM()

        for (const hook of HOOKS) {
            expect(isObservableProp(vm, hook)).toBe(false)
            // Still the base's own implementation — nothing rebound it on the way through.
            expect(vm[hook]).toBe(ViewModel.prototype[hook])
        }

        expect(() => vm.onModuleDestroy()).not.toThrow()
    })

    it("keeps disposal working after the base's methods are annotated as actions", () => {
        const dispose = vi.fn()
        const vm = new CounterVM()

        vm.register(dispose)
        vm.inc()
        vm.onModuleDestroy()

        expect(vm.count).toBe(2)
        expect(dispose).toHaveBeenCalledTimes(1)
    })
})
