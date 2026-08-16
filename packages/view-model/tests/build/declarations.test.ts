import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

// The published surface.
// ========================================
//
// `ViewModel`'s seal has two layers, and this file pins the one a consumer's compiler enforces. The four
// `onModule*` hooks are declared `private`, so the emitted `.d.ts` carries them as `private onModuleX;` —
// present, unusable, and impossible for a subclass to redeclare. They used to be `@internal` and stripped
// entirely, which left an override INVISIBLE to the compiler: a subclass could redeclare one, the base's
// runtime seal would throw at construction, and nothing said so until the app ran. That history is also
// why this package's `tsconfig.build.json` carries NO `stripInternal` — the seal rides on `private`, and
// the emit below is the whole compile-time contract.
//
// This compiles the real build config into a throwaway directory, the same way the kernel's declarations
// gate does, so the pin costs nothing that `pnpm run build` does not already do.

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

let outDir: string
const declaration = (path: string): string => readFileSync(join(outDir, path), "utf8")

beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), "remodulo-view-model-dts-"))

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
    it("publishes the four sealed hooks as `private`, so an override is a compile error", () => {
        const viewModel = declaration("ViewModel.d.ts")

        for (const hook of ["onModuleInit", "onModuleMount", "onModuleUnmount", "onModuleDestroy"]) {
            expect(viewModel).toContain(`private ${hook};`)
        }
    })

    it("publishes the four shorthands as `protected`, with an async-capable onDestroy", () => {
        // The other half of the pair: what a subclass overrides INSTEAD. `onDestroy` is the only one the
        // module awaits, so it is the only one that may return a promise.
        const viewModel = declaration("ViewModel.d.ts")

        expect(viewModel).toContain("protected onInit?(): void;")
        expect(viewModel).toContain("protected onMount?(): void;")
        expect(viewModel).toContain("protected onUnmount?(): void;")
        expect(viewModel).toContain("protected onDestroy?(): void | Promise<void>;")
    })

    it("keeps the disposer plumbing protected and the state private", () => {
        const viewModel = declaration("ViewModel.d.ts")

        expect(viewModel).toContain("protected signal(): AbortSignal;")
        expect(viewModel).toContain("protected track<T extends Disposer>(disposer: T): T;")
        // `#private` is the whole of the instance state on the published surface.
        expect(viewModel).toContain("#private;")
    })

    it("publishes the class and the disposer type, and nothing that reaches for a dependency", () => {
        // Zero dependencies is a feature of this package, and a stray `import` in the emitted declarations
        // is how that quietly stops being true.
        expect(declaration("index.d.ts")).toContain('export { ViewModel } from "./ViewModel.js";')
        expect(declaration("index.d.ts")).toContain('export type { Disposer } from "./ViewModel.js";')
        expect(declaration("ViewModel.d.ts")).not.toContain("import")
    })
})
