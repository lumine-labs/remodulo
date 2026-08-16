import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

// The published surface.
// ========================================
//
// What this package emits, and nothing it merely re-exported. `ViewModel` moved to
// `@remodulo/view-model`, which carries its own declarations gate for the two-layer seal — so the pins
// here are the ones only this package can break: the wrapper factory's signature, where the encapsulation
// IS the type.
//
// This compiles the real build config into a throwaway directory, the same way the kernel's declarations
// gate does, so the pin costs nothing that `pnpm run build` does not already do.

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

let outDir: string
const declaration = (path: string): string => readFileSync(join(outDir, path), "utf8")

beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), "remodulo-mobx-dts-"))

    execFileSync(
        process.execPath,
        [
            join(packageRoot, "node_modules", "typescript", "bin", "tsc"),
            "-p",
            "tsconfig.build.json",
            "--outDir",
            outDir,
        ],
        { cwd: packageRoot, stdio: "pipe" }
    )
}, 180_000)

afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true })
})

describe("emitted declarations", () => {
    it("no longer emits `ViewModel` or the type barrel it re-exported", () => {
        // The relocation to `@remodulo/view-model` is only real if this package stops shipping the class.
        // A stray re-export would put a second `ViewModel` identity on consumers' disk.
        expect(existsSync(join(outDir, "ViewModel.d.ts"))).toBe(false)
        expect(existsSync(join(outDir, "types.d.ts"))).toBe(false)

        const index = declaration("index.d.ts")
        expect(index).not.toContain("ViewModel")
        expect(index).not.toContain("Disposer")
    })

    it("publishes `createMobxModuleComponent` DERIVED from the base factory, with `adapter` omitted", () => {
        // Two pins in one line. The encapsulation IS the type: a consumer who can still pass `adapter` has
        // the same hand-wiring problem the wrapper exists to remove. And the signature is read off
        // `createModuleComponent` with instantiation expressions rather than restated — so the emitted form
        // spells `Parameters`/`ReturnType`, and a base-factory change reaches consumers instead of being
        // silently absorbed by a hand-copied duplicate that still compiles.
        const factory = declaration("createMobxModuleComponent.d.ts")

        expect(factory).toContain(
            "type FactoryArgs<P extends object, T extends object> = " +
                "Parameters<typeof createModuleComponent<P, T>>;"
        )
        expect(factory).toContain(
            "export declare function createMobxModuleComponent<P extends object = {}, T extends object = P>" +
                "(config?: FactoryArgs<P, T>[0], " +
                'props?: Omit<NonNullable<FactoryArgs<P, T>[1]>, "adapter">): ' +
                "ReturnType<typeof createModuleComponent<P, T>>;"
        )
        // The derivation shrinks the type-import surface to a single name — the base factory itself.
        // `ModuleConfig`, `PropsBridgeOptions`, `ComponentType` and `ReactNode` are no longer named here.
        expect(factory).toContain('import { createModuleComponent } from "@remodulo/react";')
        for (const restated of ["ModuleConfig", "PropsBridgeOptions", "ComponentType", "ReactNode"]) {
            expect(factory).not.toContain(restated)
        }

        expect(declaration("index.d.ts")).toContain(
            'export { createMobxModuleComponent } from "./createMobxModuleComponent.js";'
        )
    })
})
