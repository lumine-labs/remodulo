import { describe, expect, it } from "vitest"

import { Container } from "@remodulo/container"
import { App, Module } from "../../src/core/module.js"
import type { ModuleParams } from "../../src/core/module.types.js"
import { ModuleProvider } from "../../src/react/ModuleProvider.js"

// One container = one module.
// ========================================
//
// A Module owns exactly one container and mints it itself (fresh for an App, a fork for a child). There is
// no way to hand one in: `container` is not a module parameter, and that is a compile-time guarantee.

describe("one container = one module — type surface", () => {
    it("rejects `container` as a module parameter", () => {
        const external = new Container()

        // Nothing here runs; `tsc -p tsconfig.test.json --noEmit` is the assertion. Each directive is itself
        // checked — if `container` ever becomes assignable again, TypeScript reports the directive as unused
        // and the typecheck fails.

        // @ts-expect-error `container` is not a module parameter — a module always owns its container.
        const asParams: ModuleParams = { container: external }
        void asParams

        // @ts-expect-error `id` alongside it does not rescue the excess `container` key.
        const withKnownKey: ModuleParams = { id: "x", container: external }
        void withKnownKey

        // @ts-expect-error `<ModuleProvider container={...}>` must not typecheck.
        const element = <ModuleProvider container={external} />
        void element

        // @ts-expect-error the same through the JSX spread path.
        const spreadElement = <ModuleProvider {...{ container: external }} />
        void spreadElement

        expect(external).toBeInstanceOf(Container)
    })

    it("mints a distinct container per module at runtime", () => {
        const app = new App()
        app.init()
        const child = new Module(app, {})

        expect(app.container).toBeInstanceOf(Container)
        expect(child.container).toBeInstanceOf(Container)
        expect(child.container).not.toBe(app.container)
    })
})
