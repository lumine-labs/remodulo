import { describe, expect, it } from "vitest"

import { Container } from "@remodulo/container"
import { Ref, RefMap } from "../../src/primitives/ref.js"

// Element holders
// ========================================
//
// `Ref` and `RefMap` are plain classes an app subclasses to mint a token. Nothing about them is React —
// these are the value semantics; tests/ref/ref-react.test.tsx pins the timing against a real tree.

type Element = { tag: string }

const el = (tag: string): Element => ({ tag })

describe("Ref", () => {
    it("starts null and holds what `set` is given", () => {
        const ref = new Ref<Element>()
        expect(ref.current).toBeNull()

        const input = el("input")
        ref.set(input)
        expect(ref.current).toBe(input)
    })

    it("clears on a null delivery, and takes a new element after that", () => {
        const ref = new Ref<Element>()
        ref.set(el("first"))

        ref.set(null)
        expect(ref.current).toBeNull()

        const second = el("second")
        ref.set(second)
        expect(ref.current).toBe(second)
    })

    // The identity is what React compares between renders. A method (prototype) would be stable too, but
    // unbound — `ref={r.set}` passes it detached, and `this` would be undefined at call time.
    it("keeps one stable, bound `set` per instance", () => {
        const ref = new Ref<Element>()

        expect(ref.set).toBe(ref.set)

        const detached = ref.set
        detached(el("input"))
        expect(ref.current?.tag).toBe("input")
    })

    it("gives each instance its own `set`", () => {
        const a = new Ref<Element>()
        const b = new Ref<Element>()

        expect(a.set).not.toBe(b.set)

        a.set(el("a"))
        expect(b.current).toBeNull()
    })

    // React 19 reads a ref callback's RETURN value: anything other than undefined is taken for a cleanup
    // function, and React then never calls the callback with null on detach. The block body is the contract.
    it("returns undefined from `set`, so React 19 never mistakes it for a cleanup", () => {
        const ref = new Ref<Element>()
        expect(ref.set(el("input"))).toBeUndefined()
        expect(ref.set(null)).toBeUndefined()
    })
})

describe("RefMap", () => {
    it("holds one element per key", () => {
        const refs = new RefMap<Element>()
        const email = el("email")
        const name = el("name")

        refs.set("email")(email)
        refs.set("name")(name)

        expect(refs.get("email")).toBe(email)
        expect(refs.get("name")).toBe(name)
    })

    it("returns null for a key that never attached", () => {
        const refs = new RefMap<Element>()
        expect(refs.get("nope")).toBeNull()
    })

    // The cache is the reason `set` is a method taking a key rather than a closure built in render: a fresh
    // function per render is a new identity, and React would detach and reattach the element every time.
    it("caches one callback per key, stable across calls", () => {
        const refs = new RefMap<Element>()

        expect(refs.set("email")).toBe(refs.set("email"))
        expect(refs.set("email")).not.toBe(refs.set("name"))
    })

    it("drops the element on a null delivery but keeps the callback, so the key can reattach", () => {
        const refs = new RefMap<Element>()
        const attach = refs.set("email")

        attach(el("first"))
        attach(null)

        expect(refs.get("email")).toBeNull()
        expect(refs.all().has("email")).toBe(false)
        // Same function object — this is what a remounting row calls.
        expect(refs.set("email")).toBe(attach)

        const second = el("second")
        attach(second)
        expect(refs.get("email")).toBe(second)
    })

    it("reports `all()` in attach order, not key order", () => {
        const refs = new RefMap<Element>()

        refs.set("c")(el("c"))
        refs.set("a")(el("a"))
        refs.set("b")(el("b"))

        expect([...refs.all().keys()]).toEqual(["c", "a", "b"])

        // Detach + reattach moves the key to the end: it is attach order, and honestly so.
        refs.set("c")(null)
        refs.set("c")(el("c"))
        expect([...refs.all().keys()]).toEqual(["a", "b", "c"])
    })

    it("returns undefined from the keyed callback too", () => {
        const refs = new RefMap<Element>()
        const attach = refs.set("email")

        expect(attach(el("email"))).toBeUndefined()
        expect(attach(null)).toBeUndefined()
    })

    it("keys on anything, not just strings", () => {
        const refs = new RefMap<Element, number>()
        refs.set(1)(el("one"))

        expect(refs.get(1)?.tag).toBe("one")
        expect(refs.get(2)).toBeNull()
    })
})

// Subclass-as-token
// ========================================
//
// One element per token, with no token ceremony: the subclass IS the token. Nothing to mark it with either:
// the kernel constructs a plain class as-is, and a subclass that needs dependencies reads them with
// `inject()` from its own construction frame.

describe("subclass as token", () => {
    class InputRef extends Ref<Element> {}
    class SubmitRef extends Ref<Element> {}
    class FieldRefs extends RefMap<Element> {}

    it("resolves distinct subclasses as distinct singletons in one container", () => {
        const container = new Container()
        container.register([InputRef, SubmitRef, FieldRefs])

        const input = container.resolve(InputRef)
        const submit = container.resolve(SubmitRef)

        expect(input).toBeInstanceOf(InputRef)
        expect(submit).toBeInstanceOf(SubmitRef)
        expect(input).not.toBe(submit)

        // Singleton per container — the service injected in module A and the one in module B are the same
        // holder, which is the entire point of reaching an element through DI.
        expect(container.resolve(InputRef)).toBe(input)
        expect(container.resolve(FieldRefs)).toBeInstanceOf(FieldRefs)
    })

    it("keeps the holders independent", () => {
        const container = new Container()
        container.register([InputRef, SubmitRef])

        container.resolve(InputRef).set(el("input"))

        expect(container.resolve(InputRef).current?.tag).toBe("input")
        expect(container.resolve(SubmitRef).current).toBeNull()
    })

    it("registers under a useClass provider too, transient included", () => {
        const container = new Container()
        container.register({ provide: InputRef, useClass: InputRef, scope: "transient" })

        expect(container.resolve(InputRef)).not.toBe(container.resolve(InputRef))
    })
})
