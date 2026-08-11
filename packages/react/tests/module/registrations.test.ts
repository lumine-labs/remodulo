import { describe, expect, it } from "vitest"

import { Container, Resolver, Scope } from "@remodulo/container"
import { App, Module } from "../../src/core/module.js"
import { ModuleTraversal } from "../../src/core/module-traversal.js"
import { plain } from "../setup/helpers.js"

// What a module declared, read off the container.
// ========================================
//
// `Module.providers` and the `ProviderSnapshot` shape behind it are DELETED. They were a second, declared
// view of a question `container.registrations()` already answers — and answers better, because the entries
// carry the scope the registration path defaulted and the metadata it wrote, where the declared copy could
// only repeat what the provider literal said. There is no declared/effective distinction left to test: the
// effective view is the view.
//
// What survives from the old snapshot suite is what was never about the copy — the ordering the module
// imposes on its own registrations, and the isolation between one module's container and another's. The
// normalization tests are gone with the code they described; the provider-shape rejections they leaned on
// are covered against the real messages in `tests/container/providers.test.ts`, and `lazy` reaching entry
// metadata in `tests/lifecycle/lazy.test.ts`.

// Three since the lifecycle stopped being a registration and became `module.lifecycle`.
const SYSTEM_TOKENS = [Module, Resolver, ModuleTraversal]

const ALIAS_TARGET = Symbol.for("tests.snapshot.alias-target")
const ALIAS = Symbol.for("tests.snapshot.alias")
const VALUE = Symbol.for("tests.snapshot.value")

/** The registrations minus the three every module makes for itself. */
function userRegistrations(module: Module) {
    return module.container.registrations().slice(SYSTEM_TOKENS.length)
}

describe("system providers", () => {
    it("opens with the three system providers, in order", () => {
        const registrations = new App().container.registrations()

        expect(registrations.slice(0, SYSTEM_TOKENS.length).map((entry) => entry.token)).toEqual(SYSTEM_TOKENS)
    })

    it("keeps them ahead of the user's, whatever the user declared", () => {
        const Plain = plain("ordered")
        const module = new App({ providers: [Plain, { provide: VALUE, useValue: 1 }] })

        expect(module.container.registrations().map((entry) => entry.token)).toEqual([...SYSTEM_TOKENS, Plain, VALUE])
    })
})

describe("user providers", () => {
    it("records registration order, one entry per provider", () => {
        const Plain = plain("first")
        const module = new App({ providers: [Plain, { provide: VALUE, useValue: 1 }] })

        expect(userRegistrations(module).map((entry) => entry.token)).toEqual([Plain, VALUE])
    })

    it("carries the scope the registration defaulted, not the one the literal omitted", () => {
        const Impl = plain("impl")
        const module = new App({
            providers: [
                { provide: ALIAS_TARGET, useClass: Impl as never, scope: Scope.Transient },
                { provide: VALUE, useClass: Impl as never },
            ],
        })

        // The silent provider is a singleton here and said nothing about it in the literal — the whole
        // reason the declared copy was the weaker view.
        expect(userRegistrations(module).map((entry) => (entry.kind === "alias" ? "alias" : entry.scope))).toEqual([
            Scope.Transient,
            Scope.Singleton,
        ])
    })

    it("discriminates an alias from a binding, and names its target", () => {
        const Impl = plain("impl")
        const module = new App({
            providers: [
                { provide: ALIAS_TARGET, useClass: Impl as never },
                { provide: ALIAS, useExisting: ALIAS_TARGET },
            ],
        })

        const [, alias] = userRegistrations(module)

        expect(alias?.kind).toBe("alias")
        expect(alias?.kind === "alias" ? alias.target : undefined).toBe(ALIAS_TARGET)
    })

    it("keeps one entry per contribution to a collection, each marked multi", () => {
        const First = plain("first")
        const Second = plain("second")
        const module = new App({
            providers: [
                { provide: VALUE, useClass: First as never, multi: true },
                { provide: VALUE, useClass: Second as never, multi: true },
            ],
        })

        // The token repeats — that repetition IS the collection, and the eager pass groups on it.
        expect(userRegistrations(module).map((entry) => [entry.token, entry.multi])).toEqual([
            [VALUE, true],
            [VALUE, true],
        ])
    })

    it("is per module — a child's own view holds nothing of its parent's", () => {
        const parent = new App({ providers: [{ provide: VALUE, useValue: "parent" }] })
        parent.init()
        const child = new Module(parent, { providers: [{ provide: ALIAS_TARGET, useValue: "child" }] })
        child.init()

        expect(userRegistrations(parent).map((entry) => entry.token)).toEqual([VALUE])
        expect(userRegistrations(child).map((entry) => entry.token)).toEqual([ALIAS_TARGET])

        // Reads still travel up the fork chain; the declared view deliberately does not.
        expect(child.container.resolve(VALUE)).toBe("parent")
    })

    it("does not depend on a container being passed in — a Module owns its own", () => {
        const module = new App({ providers: [{ provide: VALUE, useValue: 1 }] })
        module.init()

        expect(module.container).toBeInstanceOf(Container)
        expect(module.container.resolve(VALUE)).toBe(1)
    })
})
