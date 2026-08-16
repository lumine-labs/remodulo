import { ViewModel } from "@remodulo/view-model"
import { $mobx, autorun, isAction, isComputedProp, isObservableProp, makeObservable, runInAction } from "mobx"
import { describe, expect, it, vi } from "vitest"

import { makeInheritedAutoObservable } from "../src/makeInheritedAutoObservable"

class PlainBase {
    inherited = "base"
    fromBase(): string {
        return this.inherited
    }
}

// Subclass support
// ========================================

describe("makeInheritedAutoObservable: subclass support", () => {
    it("annotates own and inherited members, which MobX's makeAutoObservable refuses to do", () => {
        class VM extends PlainBase {
            count = 1
            constructor() {
                super()
                makeInheritedAutoObservable(this)
            }
            get doubled(): number {
                return this.count * 2
            }
            inc(): void {
                this.count++
            }
        }

        const vm = new VM()

        expect(isObservableProp(vm, "count")).toBe(true)
        expect(isObservableProp(vm, "inherited")).toBe(true)
        expect(isComputedProp(vm, "doubled")).toBe(true)

        vm.inc()
        expect(vm.count).toBe(2)
        expect(vm.doubled).toBe(4)
    })

    it("reuses the cached annotation map for later instances of the same class", () => {
        class VM extends PlainBase {
            count = 1
            constructor() {
                super()
                makeInheritedAutoObservable(this)
            }
            inc(): void {
                this.count++
            }
        }

        const first = new VM()
        const second = new VM()

        first.inc()

        expect(isObservableProp(second, "count")).toBe(true)
        expect(second.count).toBe(1)
        expect(first.count).toBe(2)
    })

    it("honours overrides per key", () => {
        class VM extends PlainBase {
            count = 1
            plain = "not observable"
            constructor() {
                super()
                makeInheritedAutoObservable(this, { plain: false })
            }
        }

        const vm = new VM()

        expect(isObservableProp(vm, "count")).toBe(true)
        expect(isObservableProp(vm, "plain")).toBe(false)
    })

    it("binds methods when autoBind is on, so detached references still act", () => {
        class VM extends PlainBase {
            count = 0
            constructor() {
                super()
                makeInheritedAutoObservable(this, {}, { autoBind: true })
            }
            inc(): void {
                this.count++
            }
        }

        const vm = new VM()
        const detached = vm.inc

        detached()

        expect(vm.count).toBe(1)
    })

    it("keeps reactions on inherited fields alive", () => {
        class VM extends PlainBase {
            constructor() {
                super()
                makeInheritedAutoObservable(this)
            }
        }

        const vm = new VM()
        const seen: string[] = []
        const dispose = autorun(() => {
            seen.push(vm.inherited)
        })

        runInAction(() => {
            vm.inherited = "changed"
        })

        expect(seen).toEqual(["base", "changed"])
        dispose()
    })

    it("refuses a target that is already observable", () => {
        class VM extends PlainBase {
            count = 1
            constructor() {
                super()
                makeInheritedAutoObservable(this)
            }
        }

        const vm = new VM()

        expect(() => makeInheritedAutoObservable(vm)).toThrowError(/already observable/)
    })
})

// Repeated instantiation
// ========================================

// Regression pin for the cached-annotation-map bug: the applicable subset used to be re-derived with
// `for...in`, which skips non-enumerable members. Prototype methods and getters are non-enumerable, so
// from instance #2 onward every method silently lost its `action` annotation and its autoBind, while the
// observable fields kept working and made the store look healthy.
describe("makeInheritedAutoObservable: repeated instantiation", () => {
    it("keeps methods actions and bound on every instance, not just the first", () => {
        class VM {
            count = 0
            constructor() {
                makeInheritedAutoObservable(this, {}, { autoBind: true })
            }
            inc(): void {
                this.count++
            }
        }

        const observed = [1, 2, 3].map((instance) => {
            const vm = new VM()
            const detached = vm.inc
            let threw: string | null = null
            try {
                detached()
            } catch (error) {
                threw = String(error)
            }
            return {
                instance,
                isAction: isAction(vm.inc),
                isBound: Object.prototype.hasOwnProperty.call(vm, "inc"),
                threw,
                count: vm.count,
            }
        })

        expect(observed).toEqual([
            { instance: 1, isAction: true, isBound: true, threw: null, count: 1 },
            { instance: 2, isAction: true, isBound: true, threw: null, count: 1 },
            { instance: 3, isAction: true, isBound: true, threw: null, count: 1 },
        ])
    })

    it("keeps getters computed on every instance", () => {
        class VM {
            count = 1
            constructor() {
                makeInheritedAutoObservable(this)
            }
            get doubled(): number {
                return this.count * 2
            }
        }

        const instances = [new VM(), new VM(), new VM()]

        expect(instances.map((vm) => isComputedProp(vm, "doubled"))).toEqual([true, true, true])
    })

    it("keeps both inheritance levels annotated on every instance", () => {
        class VM extends PlainBase {
            count = 1
            constructor() {
                super()
                makeInheritedAutoObservable(this, {}, { autoBind: true })
            }
            get doubled(): number {
                return this.count * 2
            }
            inc(): void {
                this.count++
            }
        }

        const observed = [1, 2, 3].map(() => {
            const vm = new VM()
            const detachedDerived = vm.inc
            const detachedBase = vm.fromBase

            detachedDerived()

            return {
                ownField: isObservableProp(vm, "count"),
                inheritedField: isObservableProp(vm, "inherited"),
                ownGetter: isComputedProp(vm, "doubled"),
                ownMethodIsAction: isAction(vm.inc),
                inheritedMethodIsAction: isAction(vm.fromBase),
                detachedDerivedResult: vm.count,
                detachedBaseResult: detachedBase(),
                doubled: vm.doubled,
            }
        })

        const expected = {
            ownField: true,
            inheritedField: true,
            ownGetter: true,
            ownMethodIsAction: true,
            inheritedMethodIsAction: true,
            detachedDerivedResult: 2,
            detachedBaseResult: "base",
            doubled: 4,
        }
        expect(observed).toEqual([expected, expected, expected])
    })

    it("still honours a false override on later instances", () => {
        class VM extends PlainBase {
            count = 1
            plain = "not observable"
            constructor() {
                super()
                makeInheritedAutoObservable(this, { plain: false })
            }
        }

        const instances = [new VM(), new VM(), new VM()]

        expect(instances.map((vm) => isObservableProp(vm, "count"))).toEqual([true, true, true])
        expect(instances.map((vm) => isObservableProp(vm, "plain"))).toEqual([false, false, false])
    })

    it("does not annotate a member the later instance lacks", () => {
        class VM {
            declare optional?: string
            count = 0
            constructor(withOptional: boolean) {
                if (withOptional) this.optional = "present"
                makeInheritedAutoObservable(this)
            }
        }

        const first = new VM(true)
        const second = new VM(false)

        expect(isObservableProp(first, "optional")).toBe(true)
        expect(isObservableProp(second, "optional")).toBe(false)
        expect(isObservableProp(second, "count")).toBe(true)
    })
})

// Cache scoping across inheritance levels
// ========================================

// Regression pin for the second cached-annotation-map bug, independent of the `for...in` one above. The
// map is written with `defineProperty` on the instance's OWN prototype, but used to be read back with a
// plain property access, which walks the prototype chain. So once an ancestor had been instantiated, a
// subclass found the ancestor's map, treated it as its own, and never derived its own annotations: the
// subclass's own methods lost `action` and autoBind, and its own getters lost `computed`. Same silent
// signature as the first bug -- the base members kept working, so the store looked healthy.
//
// The pattern under test is the one that makes both levels reachable: the BASE constructor calls the
// helper, and subclasses inherit that call. A subclass cannot call it again -- the second call throws on
// the `isObservable` guard.
//
// Note on fields: a subclass's OWN fields are never observable in this pattern, in either instantiation
// order. `derived = x` initializes only after `super()` returns, so it is not yet an own property when
// the helper runs inside the base constructor. That is JS class-field ordering, not this bug, and the
// assertions below pin it as-is so the two orders stay provably identical.
describe("makeInheritedAutoObservable: cache scoping across inheritance levels", () => {
    interface TwoLevel {
        baseField: string
        derivedField: string
        baseMethod: () => string
        derivedMethod: () => string
        readonly baseDoubled: string
        readonly derivedDoubled: string
    }

    const inspect = (vm: TwoLevel) => ({
        baseFieldObservable: isObservableProp(vm, "baseField"),
        derivedFieldObservable: isObservableProp(vm, "derivedField"),
        baseMethodIsAction: isAction(vm.baseMethod),
        derivedMethodIsAction: isAction(vm.derivedMethod),
        baseGetterIsComputed: isComputedProp(vm, "baseDoubled"),
        derivedGetterIsComputed: isComputedProp(vm, "derivedDoubled"),
        derivedMethodIsBound: Object.prototype.hasOwnProperty.call(vm, "derivedMethod"),
        detachedDerivedResult: (0, vm.derivedMethod)(),
        detachedBaseResult: (0, vm.baseMethod)(),
    })

    // The two orders must agree on every entry. Pre-fix, base-first lost the derived-only entries.
    const expectedForDerived = {
        baseFieldObservable: true,
        derivedFieldObservable: false,
        baseMethodIsAction: true,
        derivedMethodIsAction: true,
        baseGetterIsComputed: true,
        derivedGetterIsComputed: true,
        derivedMethodIsBound: true,
        detachedDerivedResult: "derived",
        detachedBaseResult: "base",
    }

    class BaseOne {
        baseField = "base"
        constructor() {
            makeInheritedAutoObservable(this, {}, { autoBind: true })
        }
        baseMethod(): string {
            return this.baseField
        }
        get baseDoubled(): string {
            return this.baseField + this.baseField
        }
    }

    class DerivedOne extends BaseOne {
        derivedField = "derived"
        derivedMethod(): string {
            return "derived"
        }
        get derivedDoubled(): string {
            return this.derivedMethod() + this.derivedMethod()
        }
    }

    class BaseTwo {
        baseField = "base"
        constructor() {
            makeInheritedAutoObservable(this, {}, { autoBind: true })
        }
        baseMethod(): string {
            return this.baseField
        }
        get baseDoubled(): string {
            return this.baseField + this.baseField
        }
    }

    class DerivedTwo extends BaseTwo {
        derivedField = "derived"
        derivedMethod(): string {
            return "derived"
        }
        get derivedDoubled(): string {
            return this.derivedMethod() + this.derivedMethod()
        }
    }

    it("derives the subclass's own annotations when the base was instantiated first", () => {
        const base = new BaseOne()
        const derived = new DerivedOne()

        expect(inspect(derived)).toEqual(expectedForDerived)

        expect({
            baseFieldObservable: isObservableProp(base, "baseField"),
            baseMethodIsAction: isAction(base.baseMethod),
            baseGetterIsComputed: isComputedProp(base, "baseDoubled"),
            detachedBaseResult: (0, base.baseMethod)(),
        }).toEqual({
            baseFieldObservable: true,
            baseMethodIsAction: true,
            baseGetterIsComputed: true,
            detachedBaseResult: "base",
        })
    })

    it("gives the same result when the subclass was instantiated first", () => {
        const derived = new DerivedTwo()
        const base = new BaseTwo()

        expect(inspect(derived)).toEqual(expectedForDerived)

        expect({
            baseFieldObservable: isObservableProp(base, "baseField"),
            baseMethodIsAction: isAction(base.baseMethod),
            baseGetterIsComputed: isComputedProp(base, "baseDoubled"),
            detachedBaseResult: (0, base.baseMethod)(),
        }).toEqual({
            baseFieldObservable: true,
            baseMethodIsAction: true,
            baseGetterIsComputed: true,
            detachedBaseResult: "base",
        })
    })

    it("annotates every level's own members in a three-level chain, whatever the order", () => {
        class Root {
            rootField = "root"
            constructor() {
                makeInheritedAutoObservable(this, {}, { autoBind: true })
            }
            rootMethod(): string {
                return "root"
            }
            get rootGetter(): string {
                return this.rootField
            }
        }

        class Mid extends Root {
            midMethod(): string {
                return "mid"
            }
            get midGetter(): string {
                return this.midMethod()
            }
        }

        class Leaf extends Mid {
            leafMethod(): string {
                return "leaf"
            }
            get leafGetter(): string {
                return this.leafMethod()
            }
        }

        // Mid before Root before Leaf: pre-fix, Leaf read Mid's cached map through the chain.
        const mid = new Mid()
        const root = new Root()
        const leaf = new Leaf()

        expect({
            rootField: isObservableProp(root, "rootField"),
            rootMethod: isAction(root.rootMethod),
            rootGetter: isComputedProp(root, "rootGetter"),
        }).toEqual({ rootField: true, rootMethod: true, rootGetter: true })

        expect({
            rootField: isObservableProp(mid, "rootField"),
            rootMethod: isAction(mid.rootMethod),
            rootGetter: isComputedProp(mid, "rootGetter"),
            midMethod: isAction(mid.midMethod),
            midGetter: isComputedProp(mid, "midGetter"),
            detachedMid: (0, mid.midMethod)(),
        }).toEqual({
            rootField: true,
            rootMethod: true,
            rootGetter: true,
            midMethod: true,
            midGetter: true,
            detachedMid: "mid",
        })

        expect({
            rootField: isObservableProp(leaf, "rootField"),
            rootMethod: isAction(leaf.rootMethod),
            rootGetter: isComputedProp(leaf, "rootGetter"),
            midMethod: isAction(leaf.midMethod),
            midGetter: isComputedProp(leaf, "midGetter"),
            leafMethod: isAction(leaf.leafMethod),
            leafGetter: isComputedProp(leaf, "leafGetter"),
            detachedLeaf: (0, leaf.leafMethod)(),
        }).toEqual({
            rootField: true,
            rootMethod: true,
            rootGetter: true,
            midMethod: true,
            midGetter: true,
            leafMethod: true,
            leafGetter: true,
            detachedLeaf: "leaf",
        })
    })

    it("composes with the repeated-instantiation guarantee: second instances stay fully annotated", () => {
        class Base {
            baseField = "base"
            constructor() {
                makeInheritedAutoObservable(this, {}, { autoBind: true })
            }
            baseMethod(): string {
                return this.baseField
            }
            get baseGetter(): string {
                return this.baseField
            }
        }

        class Derived extends Base {
            derivedMethod(): string {
                return "derived"
            }
            get derivedGetter(): string {
                return this.derivedMethod()
            }
        }

        new Base()
        new Derived()
        const secondBase = new Base()
        const secondDerived = new Derived()

        expect({
            baseField: isObservableProp(secondBase, "baseField"),
            baseMethod: isAction(secondBase.baseMethod),
            baseGetter: isComputedProp(secondBase, "baseGetter"),
            detached: (0, secondBase.baseMethod)(),
        }).toEqual({ baseField: true, baseMethod: true, baseGetter: true, detached: "base" })

        expect({
            baseField: isObservableProp(secondDerived, "baseField"),
            baseMethod: isAction(secondDerived.baseMethod),
            baseGetter: isComputedProp(secondDerived, "baseGetter"),
            derivedMethod: isAction(secondDerived.derivedMethod),
            derivedGetter: isComputedProp(secondDerived, "derivedGetter"),
            detached: (0, secondDerived.derivedMethod)(),
        }).toEqual({
            baseField: true,
            baseMethod: true,
            baseGetter: true,
            derivedMethod: true,
            derivedGetter: true,
            detached: "derived",
        })
    })
})

// What the key walk collects, and what it skips
// ========================================
//
// The walk is `Reflect.ownKeys` over the instance and every prototype below `Object.prototype`, and it
// drops three kinds of key: MobX's own administration symbol, `constructor`, and anything the target
// holds as a NON-CONFIGURABLE own property. The last of those is what makes `ViewModel` work at all —
// its four sealed hooks are non-configurable own properties, and MobX deletes a property before
// redefining it, so annotating one throws.
//
// These cells read the collected map directly off the prototype cache as well as asserting behaviour:
// the map IS the walk's product, so a key that should never have been collected is visible here even
// when MobX happens to tolerate it.

const ANNOTATIONS_CACHE = Symbol.for("@remodulo/mobx:annotations")

function collectedFor(proto: object): Record<PropertyKey, unknown> {
    const map = Object.getOwnPropertyDescriptor(proto, ANNOTATIONS_CACHE)?.value as
        | Record<PropertyKey, unknown>
        | undefined

    if (!map) throw new Error("no cached annotation map on this prototype")
    return map
}

describe("makeInheritedAutoObservable: the key walk", () => {
    const LABEL = Symbol("label")

    class SymBase {
        baseField = "base"
        baseMethod(): string {
            return this.baseField
        }
    }

    class Walked extends SymBase {
        plain = 1
        declaredOff = 2;
        [LABEL] = "sym"

        constructor() {
            super()
            Object.defineProperty(this, "frozen", { value: "sealed", configurable: false, enumerable: true })
            makeInheritedAutoObservable(this, { declaredOff: false })
        }

        method(): void {}

        get derived(): number {
            return this.plain * 2
        }
    }

    it("collects every level's own keys and nothing else", () => {
        new Walked()
        const collected = collectedFor(Walked.prototype)

        expect(new Set(Reflect.ownKeys(collected).filter((key) => typeof key === "string"))).toEqual(
            new Set(["baseField", "plain", "declaredOff", "method", "derived", "baseMethod"])
        )
    })

    it("skips $mobx and constructor", () => {
        new Walked()
        const keys = Reflect.ownKeys(collectedFor(Walked.prototype))

        // `constructor` is on every prototype the walk visits; annotating it would make the class itself
        // an observable field. `$mobx` is MobX's own administration key and is never ours to annotate.
        expect(keys).not.toContain("constructor")
        expect(keys).not.toContain($mobx)
    })

    it("skips a non-configurable own property of the target", () => {
        const walked = new Walked()

        expect(Reflect.ownKeys(collectedFor(Walked.prototype))).not.toContain("frozen")
        expect(isObservableProp(walked, "frozen")).toBe(false)
        // The sibling declared right beside it is still annotated, so this is a skip and not a bail-out.
        expect(isObservableProp(walked, "plain")).toBe(true)
    })

    it("would throw without that skip — MobX deletes before it redefines", () => {
        class Frozen {
            visible = 1
            constructor() {
                Object.defineProperty(this, "frozen", { value: 9, configurable: false, enumerable: true })
            }
        }

        // The raw call is what `makeInheritedAutoObservable` would make if the walk collected `frozen`.
        expect(() => makeObservable(new Frozen(), { visible: true, frozen: true } as never)).toThrowError(TypeError)
        // And the same shape through our walk is fine.
        expect(() => new Walked()).not.toThrow()
    })

    it("includes symbol-keyed fields, which Object.keys would have missed", () => {
        const walked = new Walked()

        expect(collectedFor(Walked.prototype)[LABEL]).toBe(true)
        expect(isObservableProp(walked, LABEL as unknown as string)).toBe(true)
        expect(Object.keys(walked)).not.toContain(LABEL)
    })

    it("lets a declared override win, and defaults every key it does not name to true", () => {
        const walked = new Walked()
        const collected = collectedFor(Walked.prototype)

        expect(collected.declaredOff).toBe(false)
        expect(collected.plain).toBe(true)
        expect(isObservableProp(walked, "declaredOff")).toBe(false)
        expect(isObservableProp(walked, "plain")).toBe(true)
    })

    it("defaults everything to true when no overrides are given at all", () => {
        class NoOverrides extends SymBase {
            n = 1
            constructor() {
                super()
                makeInheritedAutoObservable(this)
            }
            m(): void {}
        }

        new NoOverrides()
        const collected = collectedFor(NoOverrides.prototype)

        expect(Object.values(collected).every((value) => value === true)).toBe(true)
    })
})

// The ViewModel case, which is why the skip exists
// ========================================

describe("makeInheritedAutoObservable: sealed ViewModel hooks", () => {
    class CounterVM extends ViewModel {
        count = 1

        constructor() {
            super()
            makeInheritedAutoObservable(this, {}, { autoBind: true })
        }

        inc(): void {
            this.count++
        }
    }

    it("annotates the subclass while skipping all four sealed hooks", () => {
        const vm = new CounterVM()
        const keys = Reflect.ownKeys(collectedFor(CounterVM.prototype))

        for (const hook of ["onModuleInit", "onModuleMount", "onModuleUnmount", "onModuleDestroy"] as const) {
            expect(keys).not.toContain(hook)
            expect(isObservableProp(vm, hook)).toBe(false)
        }

        expect(isObservableProp(vm, "count")).toBe(true)
        expect(isAction(vm.inc)).toBe(true)
    })

    it("still annotates the base's own protected helpers, which are not sealed", () => {
        new CounterVM()
        const keys = Reflect.ownKeys(collectedFor(CounterVM.prototype))

        // `signal` and `track` are ordinary configurable prototype methods, so the walk takes them and
        // MobX makes them actions. Only the four lifecycle entry points are held back.
        expect(keys).toContain("signal")
        expect(keys).toContain("track")
    })
})

// Interaction with makeInheritedAutoObservable
// ========================================
//
// `ViewModel` itself lives in `@remodulo/view-model` and is tested there against no reactivity library at
// all. What stays here is the half that only exists at the seam: what the annotation walk does to a view
// model, and that the base's disposal still works once MobX has been through it.

const HOOKS = ["onModuleInit", "onModuleMount", "onModuleUnmount", "onModuleDestroy"] as const

/**
 * The module calls the four hooks by looking them up at RUNTIME — it never names their types — so a suite
 * that drives a view model by hand has to reach past the `private` modifier the same way.
 */
type Driven = { [K in (typeof HOOKS)[number]]: () => unknown }
const drive = (vm: ViewModel): Driven => vm as unknown as Driven

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

        expect(() => drive(vm).onModuleDestroy()).not.toThrow()
    })

    it("keeps disposal working after the base's methods are annotated as actions", async () => {
        const dispose = vi.fn()
        const vm = new CounterVM()

        vm.register(dispose)
        vm.inc()
        await drive(vm).onModuleDestroy()

        expect(vm.count).toBe(2)
        expect(dispose).toHaveBeenCalledTimes(1)
    })
})
