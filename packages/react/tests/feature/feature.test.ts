import { describe, expect, it } from "vitest"

import type { Provider, ProviderInput } from "../../src/core/provider.types.js"
import { createFeature } from "../../src/core/feature.js"
import { makeApp, plain, tracked } from "../setup/helpers.js"

// Provider bundles.
// ========================================
//
// A feature is a frozen bundle of provider inputs that flattens at module construction — depth-first,
// order-preserving, so registration order is exactly the order the nesting reads in. One contract sentence
// carries the rest: FEATURE DEDUPLICATES FEATURES, NEVER PROVIDERS. The same feature instance reached twice
// contributes once; a duplicate plain provider reached through two features hits the container's ordinary
// registration errors, unchanged.

const PLUGINS = Symbol("tests.feature.plugins")
const SINGLE = Symbol("tests.feature.single")

const member = (value: string): Provider => ({ provide: PLUGINS, useValue: value, multi: true })

const trackedMember = (service: Provider): Provider =>
    ({ provide: PLUGINS, useClass: service, multi: true }) as Provider

function capture(run: () => void): unknown {
    try {
        run()
    } catch (error) {
        return error
    }
    return null
}

describe("flattening", () => {
    it("splices a feature's providers in place, depth-first and order-preserving", () => {
        const module = makeApp({
            providers: [member("A"), createFeature({ providers: [member("B"), member("C")] }), member("D")],
        })

        expect(module.container.resolveAll(PLUGINS)).toEqual(["A", "B", "C", "D"])
    })

    it("flattens a feature nested inside a feature all the way down", () => {
        const inner = createFeature({ providers: [member("C")] })
        const outer = createFeature({ providers: [member("B"), inner, member("D")] })

        const module = makeApp({ providers: [member("A"), outer, member("E")] })

        expect(module.container.resolveAll(PLUGINS)).toEqual(["A", "B", "C", "D", "E"])
    })
})

describe("deduplication", () => {
    it("contributes a shared feature once however many parents reach it", () => {
        const shared = createFeature({ providers: [{ provide: SINGLE, useValue: "x" }, member("S")] })
        const left = createFeature({ providers: [shared, member("L")] })
        const right = createFeature({ providers: [shared, member("R")] })

        const module = makeApp({ providers: [left, right] })

        expect(module.container.resolveAll(PLUGINS)).toEqual(["S", "L", "R"])
        expect(module.container.resolve(SINGLE)).toBe("x")
    })

    it("leaves a duplicate PLAIN provider to the container, error for error", () => {
        const duplicate: Provider = { provide: SINGLE, useValue: "x" }
        const collection: Provider = { provide: SINGLE, useValue: "y", multi: true }

        const directDuplicate = capture(() => makeApp({ providers: [duplicate, duplicate] }))
        const featuredDuplicate = capture(() =>
            makeApp({
                providers: [
                    createFeature({ providers: [duplicate] }),
                    createFeature({ providers: [duplicate] }),
                ],
            })
        )

        expect(featuredDuplicate).toBeInstanceOf(Error)
        expect((featuredDuplicate as Error).message).toBe((directDuplicate as Error).message)
        expect((featuredDuplicate as Error).message).toBe(
            "Token tests.feature.single is already registered on this container. One token, one registration — mark every provider for it `multi: true` to make it a collection, or give each provider its own token."
        )

        const directConflict = capture(() => makeApp({ providers: [duplicate, collection] }))
        const featuredConflict = capture(() =>
            makeApp({
                providers: [
                    createFeature({ providers: [duplicate] }),
                    createFeature({ providers: [collection] }),
                ],
            })
        )

        expect(featuredConflict).toBeInstanceOf(Error)
        expect((featuredConflict as Error).message).toBe((directConflict as Error).message)
    })
})

describe("collections across features", () => {
    it("combines members two features contribute to the same token", () => {
        const module = makeApp({
            providers: [
                createFeature({ name: "left", providers: [member("A"), member("B")] }),
                createFeature({ name: "right", providers: [member("C")] }),
            ],
        })

        expect(module.container.resolveAll(PLUGINS)).toEqual(["A", "B", "C"])
    })

    it("gives feature-contributed members the ordinary four phases", async () => {
        const log: string[] = []
        const a = tracked(log, "A")
        const b = tracked(log, "B")

        const module = makeApp({
            providers: [
                createFeature({ providers: [trackedMember(a)] }),
                createFeature({ providers: [trackedMember(b)] }),
            ],
        })

        expect(module.container.resolveAll(PLUGINS)).toHaveLength(2)

        module.mount()
        module.unmount()
        await module.destroy()

        expect(a.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
        expect(b.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
    })
})

describe("immutability", () => {
    it("freezes the feature and its providers, and copies the array it was handed", () => {
        const first = plain("first")
        const second = plain("second")
        const source: ProviderInput[] = [first]

        const feature = createFeature({ name: "billing", providers: source })
        source.push(second)

        expect(Object.isFrozen(feature)).toBe(true)
        expect(Object.isFrozen(feature.providers)).toBe(true)
        expect(feature.providers).toEqual([first])
    })

    it("carries `name` when given and omits the key entirely when not", () => {
        expect(createFeature({ name: "billing", providers: [] }).name).toBe("billing")
        expect("name" in createFeature({ providers: [] })).toBe(false)
    })
})
