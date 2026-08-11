import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

// The published surface.
// ========================================
//
// `stripInternal` in tsconfig.build.json is what keeps `@internal` members out of the emitted `.d.ts`, and
// a flag nobody checks is a flag that gets dropped in a config tidy-up. Nothing on the public classes
// carries the tag any more — `onPredicateResolution` was the last one, and the whole `onResolution` door it
// belonged to has since been replaced by `on`. What still carries it is `frame.ts`'s
// `activeFrame`/`runInFrame`, so those two are what the flag is pinned by now. This compiles the real build
// config into a throwaway directory and reads
// the declarations it produced, so the pin costs nothing that `pnpm run build` does not already do.

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

let outDir: string
const declaration = (path: string): string => readFileSync(join(outDir, path), "utf8")

beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), "remodulo-container-dts-"))

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
    it("publishes one observation door, and it names no token", () => {
        // The whole signature, because every part of it is load-bearing: the event is a type parameter, so
        // the payload narrows to the event a consumer named; there is no token beside it, because
        // registration is container-global and filtering is the hook's own job; and the return is the
        // disposer, which is the only handle on a hook there is.
        expect(declaration("container.d.ts")).toContain(
            "on<E extends ContainerEvent>(event: E, listener: ContainerEventListener<E>): () => void;"
        )
    })

    it("has no onResolution and no notObservable left anywhere", () => {
        // The per-entry listener plumbing and the attach-time refusal that went with it are gone from the
        // SOURCE, not hidden behind `stripInternal` — an observation door that does not exist cannot drift
        // back into the published surface through a config change.
        const container = readFileSync(join(packageRoot, "src", "container.ts"), "utf8")
        const errors = readFileSync(join(packageRoot, "src", "container.errors.ts"), "utf8")

        expect(container).not.toContain("onResolution")
        expect(container).not.toContain("notObservable")
        expect(errors).not.toContain("notObservable")

        for (const file of ["container.d.ts", "container.errors.d.ts", "index.d.ts", "types.d.ts"]) {
            expect(declaration(file)).not.toContain("onResolution")
            expect(declaration(file)).not.toContain("notObservable")
        }
    })

    it("publishes the token union with its class-key arm, and keeps building on `Constructor`", () => {
        // Both halves of the split, because each is only meaningful against the other: a class is a legal
        // KEY whether or not it can be built, and an ILLEGAL implementation unless it can.
        const containerTypes = declaration("container.types.d.ts")

        expect(containerTypes).toContain(
            "export type InjectionToken<T = unknown> = string | symbol | Constructor<T> | AbstractConstructor<T> | ClassKey<T>;"
        )
        // `NoInfer` is part of the published contract, not an implementation detail: dropping it is what
        // turns a generic class token from `Box<unknown>` into `Box<any>` at every consumer call site.
        expect(containerTypes).toContain("export type ClassKey<T = unknown> = Function & {")
        expect(containerTypes).toContain("prototype: NoInfer<T>;")
        expect(declaration("types.d.ts")).toContain("ClassKey")

        // The three doors that construct, all still spelled with `Constructor`.
        expect(declaration("providers.types.d.ts")).toContain("useClass: Constructor<T>;")
        expect(declaration("providers.types.d.ts")).toContain("export type Provider<T = any> = Constructor<T> |")
        expect(declaration("container.d.ts")).toContain("construct<T>(cls: Constructor<T>): T;")
    })

    it("publishes a resolution pair of one shape, wide-snapshotted, and a narrow materialization pair", () => {
        // The split a consumer compiles against. The resolution pair agrees on `mode` and `snapshot` and
        // differs only in token-vs-instance; its snapshot is the WIDE union because an alias read reports
        // the alias, and it is NON-OPTIONAL on both halves, because an announcement only ever happens where
        // an entry landed. The materialization pair stays narrow, because an alias never materializes.
        const containerTypes = declaration("container.types.d.ts")

        for (const published of [
            "readonly token: InjectionToken;\n    readonly mode: ResolveMode | ResolveAllMode;",
            "readonly instance: unknown;\n    readonly mode: ResolveMode | ResolveAllMode;\n    readonly snapshot: EntrySnapshot;",
        ]) {
            expect(containerTypes).toContain(published)
        }
        expect(containerTypes).not.toContain("EntrySnapshot | undefined")

        for (const wide of ["BeforeResolutionEvent", "AfterResolutionEvent"]) {
            const declared = containerTypes.slice(containerTypes.indexOf(`export type ${wide}`))
            expect(declared.slice(0, declared.indexOf("};"))).toContain("readonly snapshot: EntrySnapshot;")
        }

        for (const narrow of ["BeforeMaterializeEvent", "AfterMaterializeEvent"]) {
            const declared = containerTypes.slice(containerTypes.indexOf(`export type ${narrow}`))
            expect(declared.slice(0, declared.indexOf("};"))).toContain("readonly snapshot: BindingEntrySnapshot;")
        }
    })

    it("publishes the event names as a value and the four payloads as types", () => {
        // Both halves are needed by a consumer: the names as a value, because a hook is attached by naming
        // one, and the payloads as types, because a named handler has to be able to spell its parameter.
        expect(declaration("container.types.d.ts")).toContain("export declare const ContainerEvent")
        expect(declaration("index.d.ts")).toContain("ContainerEvent")

        const types = declaration("types.d.ts")
        for (const published of [
            "ContainerEvent",
            "ContainerEventListener",
            "ContainerEventPayload",
            "BeforeResolutionEvent",
            "AfterResolutionEvent",
            "BeforeMaterializeEvent",
            "AfterMaterializeEvent",
        ]) {
            expect(types).toContain(published)
        }
    })

    it("publishes the Resolver with the reads and `on`, and with no write door", () => {
        const resolver = declaration("resolver.d.ts")

        expect(declaration("index.d.ts")).toContain('export { Resolver } from "./resolver.js"')

        // The canonical accessor is the ONLY published way to reach one, and the container names it
        // nowhere: `createResolver()` is gone and the constructor is private, so a consumer has exactly one
        // door. The emitted `private constructor()` is what enforces that off the declarations — it takes
        // no parameters there, because a private constructor's signature is not a consumer's business.
        expect(resolver).toContain("static for(container: Container): Resolver;")
        expect(resolver).toContain("private constructor();")
        expect(declaration("container.d.ts")).not.toContain("createResolver")
        expect(declaration("container.d.ts")).not.toContain("Resolver")

        // The read surface is the container's, spelled the container's way — same names, same optional
        // mode parameters. A rename or a dropped mode here is a divergence no runtime test would catch,
        // because a resolver that delegates still delegates.
        for (const published of [
            "resolve<T>(token: InjectionToken<T>, mode?: ResolveMode): T;",
            "resolveOptional<T>(token: InjectionToken<T>, mode?: ResolveMode): T | undefined;",
            "resolveOr<T, F>(token: InjectionToken<T>, fallback: () => F, mode?: ResolveMode): T | F;",
            "resolveOr<T, F>(token: InjectionToken<T>, fallback: F, mode?: ResolveMode): T | F;",
            "resolveAll<T>(token: InjectionToken<T>, mode?: ResolveAllMode): T[];",
            "isRegistered(token: InjectionToken, mode?: RegistrationMode): boolean;",
            "registrations(): readonly EntrySnapshot[];",
            "entry(token: InjectionToken): EntrySnapshot | undefined;",
            "entries(token: InjectionToken): readonly EntrySnapshot[];",
            "on<E extends ContainerEvent>(event: E, listener: ContainerEventListener<E>): () => void;",
        ]) {
            expect(resolver).toContain(published)
        }

        // The container's three write doors, spelled as the container publishes them — the prose above
        // names all three, so the absent form has to be the declaration rather than the word.
        const container = declaration("container.d.ts")
        for (const absent of [
            "register(provider: Provider | Provider[]): void;",
            "fork(): Container;",
            "construct<T>(cls: Constructor<T>): T;",
        ]) {
            expect(container).toContain(absent)
            expect(resolver).not.toContain(absent)
        }
    })

    it("has no onPredicateResolution left to strip", () => {
        // It used to be `@internal` and stripped from the emitted `.d.ts`. It is now gone from the SOURCE,
        // which is the stronger claim and the one worth pinning — an internal door that does not exist
        // cannot drift back into the published surface through a config change.
        expect(readFileSync(join(packageRoot, "src", "container.ts"), "utf8")).not.toContain("onPredicateResolution")
        expect(declaration("container.d.ts")).not.toContain("onPredicateResolution")
    })

    it("strips the frame plumbing while keeping the injection functions", () => {
        // The frame's runtime is its own module now, so the two `@internal` functions are pinned where they
        // are declared and the injection surface is pinned where it is declared.
        const frame = declaration("frame.d.ts")
        const injector = declaration("injector.d.ts")

        expect(frame).not.toContain("activeFrame")
        expect(frame).not.toContain("runInFrame")
        for (const exported of [
            "inject",
            "injectOptional",
            "injectAll",
            "injectContainer",
            "injectResolver",
            "runInInjectionContext",
        ]) {
            expect(injector).toContain(`declare function ${exported}`)
        }
    })

    it("publishes injectResolver as a no-argument reader returning the Resolver", () => {
        // Same shape as `injectContainer` and for the same reason — the frame's anchor is not something a
        // caller selects — and the return type is the difference between the two doors: the read-and-observe
        // surface rather than the container, so nothing that takes one can register through it.
        expect(declaration("injector.d.ts")).toContain("declare function injectResolver(): Resolver;")
        expect(declaration("index.d.ts")).toContain("injectResolver")
    })

    it("publishes injectContainer as a no-argument reader returning the Container itself", () => {
        // The signature is the whole surface here, and both halves of it matter: no parameters, because
        // the frame's anchor is not something a caller selects, and `Container` rather than
        // `Container | null`, because absence is the throw pinned in
        // `tests/injection/inject-container.test.ts` and never a return value.
        expect(declaration("injector.d.ts")).toContain("declare function injectContainer(): Container;")
        expect(declaration("index.d.ts")).toContain("injectContainer")
    })

    it("emits the two entry points the package exports", () => {
        expect(declaration("index.d.ts")).toContain('export { Container } from "./container.js"')
        expect(declaration("types.d.ts")).toContain("InjectionToken")
    })

    it("no longer publishes the feature surface", () => {
        const index = declaration("index.d.ts")
        const types = declaration("types.d.ts")

        for (const gone of ["createFeature", "flattenProviders"]) expect(index).not.toContain(gone)
        for (const gone of ["Feature", "ProviderInput"]) expect(types).not.toContain(gone)
    })

    it("publishes the metadata plane: EntrySnapshot, its two arms, and the accessors that hand it out", () => {
        const container = declaration("container.d.ts")
        const containerTypes = declaration("container.types.d.ts")
        const types = declaration("types.d.ts")

        // The union AND both arms are published, because the arms are not an implementation detail of it:
        // the materialization payloads are declared over `BindingEntrySnapshot`, so a consumer writing a
        // named hook instead of an inline arrow has to be able to spell the parameter's type.
        expect(containerTypes).toContain("export type EntrySnapshot")
        expect(containerTypes).toContain("export type BindingEntrySnapshot")
        expect(containerTypes).toContain("export type AliasEntrySnapshot")
        for (const published of ["EntrySnapshot", "BindingEntrySnapshot", "AliasEntrySnapshot"]) {
            expect(types).toContain(published)
        }

        expect(container).toContain("get parent(): Container | null")
        expect(container).toContain("entry(token: InjectionToken): EntrySnapshot | undefined")
        expect(container).toContain("entries(token: InjectionToken): readonly EntrySnapshot[]")
        expect(container).toContain("registrations(): readonly EntrySnapshot[]")
    })

    it("publishes no `RegistrationKind`, now that the arms carry the union inline", () => {
        // Owner ruling: it was a public alias with nothing left referring to it. `EntrySnapshot` inlined the
        // `kind` union into its arms when it replaced `Registration`, so the alias named nothing the arms
        // did not already say — and a public type with no referent is surface to maintain for free.
        for (const file of ["container.types.d.ts", "types.d.ts", "index.d.ts"]) {
            expect(declaration(file)).not.toContain("RegistrationKind")
        }
    })

    it("keeps the container's internal types off both entry points", () => {
        // `Entry`, `EntrySource`, `Resolution` and `Found` moved out of `container.ts` into
        // `container.types.ts`, so that file carries behaviour and this one carries shape. They are
        // `export`ed there for that one importer, and `container.types.d.ts` therefore names them — which is
        // consumer-unreachable, because `package.json#exports` publishes `.` and `./types` and NOTHING else.
        // So the claim worth pinning is per entry point, not per file.
        //
        // Word-boundary matches, because `EntrySnapshot`, `BindingEntrySnapshot` and `RegistrationMode` all
        // legitimately contain these as substrings. `Registration` rides along: it was the old snapshot type
        // `EntrySnapshot` replaced, and two shapes for one thing is what the collapse removed.
        const internals = ["Entry", "EntrySource", "EntryListener", "Resolution", "Found", "Landing", "Registration"]

        for (const file of ["types.d.ts", "index.d.ts"]) {
            for (const internal of internals) {
                expect(declaration(file)).not.toMatch(new RegExp(`\\b${internal}\\b`))
            }
        }

        // The counterweight: they really did move, rather than being deleted or left behind in `container.ts`.
        const containerTypes = declaration("container.types.d.ts")
        for (const internal of ["Entry", "EntrySource", "Resolution", "Found", "Landing"]) {
            expect(containerTypes).toMatch(new RegExp(`export type ${internal}\\b`))
        }
        expect(declaration("container.d.ts")).not.toMatch(/\bEntry\b/)
    })

    it("publishes `EntryMetadata` and the snapshot field that carries it, on both arms", () => {
        // The extension point is public surface on both planes: a consumer writes the bag on a provider and
        // reads it back off a snapshot, so the type has to be spellable from `./types` and the field has to
        // be visible on the arm it will be read from — including the alias arm, which carries no scope but
        // does carry metadata.
        const providerTypes = declaration("providers.types.d.ts")
        const containerTypes = declaration("container.types.d.ts")

        expect(providerTypes).toContain("export type EntryMetadata = Readonly<Record<string, unknown>>;")
        expect(declaration("types.d.ts")).toContain("EntryMetadata")

        // The grammar side: every one of the five object forms takes the key.
        expect(providerTypes.match(/metadata\?: EntryMetadata;/g)).toHaveLength(5)

        // The snapshot side: one occurrence per arm, and the arms are what `EntrySnapshot` is built from.
        for (const arm of ["BindingEntrySnapshot", "AliasEntrySnapshot"]) {
            const declared = containerTypes.slice(containerTypes.indexOf(`export type ${arm}`))
            expect(declared.slice(0, declared.indexOf("};"))).toContain("readonly metadata?: EntryMetadata;")
        }
    })

    it("keeps the metadata bag off the kernel's own published signatures", () => {
        // `EntryMetadata` reaches `container.d.ts` through nothing: `register` takes `Provider`, the reads
        // return `EntrySnapshot`, and the copy/freeze lives in a module-local helper and a `#private` method.
        // The container names the type nowhere a consumer can see, which is the shape of "stores, never reads".
        expect(declaration("container.d.ts")).not.toContain("EntryMetadata")
    })

    it("publishes the four error classes with their structured fields", () => {
        // EntrySnapshot-style placement: declared next to the concept they belong to — the container's
        // three in `container.errors.d.ts`, the injector's one in `injector.errors.d.ts` — and reachable
        // from both entry points. The FIELDS are the reason the classes are published at all, so they are
        // pinned with their declared types: a consumer branching on `code` or reading `chain` writes
        // against these, and widening `token` to `unknown` or `chain` to `unknown[]` would be a silent
        // downgrade that no message assertion would catch.
        const containerErrors = declaration("container.errors.d.ts")
        const injectorErrors = declaration("injector.errors.d.ts")

        expect(containerErrors).toContain("export declare class RegistrationError extends Error")
        expect(containerErrors).toContain("readonly token: InjectionToken | undefined;")

        expect(containerErrors).toContain("export declare class ResolutionError extends Error")
        expect(containerErrors).toContain("readonly token: InjectionToken;")
        expect(containerErrors).toContain("readonly mode: ResolveMode | ResolveAllMode | undefined;")

        // The subclass relation is the published one, not just a runtime fact.
        expect(containerErrors).toContain("export declare class CycleError extends ResolutionError")
        expect(containerErrors).toContain("readonly chain: readonly InjectionToken[];")

        expect(injectorErrors).toContain("export declare class InjectionContextError extends Error")
        expect(injectorErrors).toContain("readonly caller: string;")
    })

    it("types every code as a literal string, not as `string`", () => {
        // A `code` widened to `string` is a discriminant that no longer discriminates: the union it is
        // meant to narrow stops narrowing and the compiler stops catching a typo'd comparison. The four
        // constants and the three concrete classes carry the literal; `ResolutionError.code` is the union
        // of the two literal-typed constants, because a caught `ResolutionError` may be a `CycleError`.
        const containerErrors = declaration("container.errors.d.ts")
        const injectorErrors = declaration("injector.errors.d.ts")

        expect(containerErrors).toContain('export declare const REGISTRATION_ERROR_CODE = "REMODULO/REGISTRATION";')
        expect(containerErrors).toContain('export declare const RESOLUTION_ERROR_CODE = "REMODULO/RESOLUTION";')
        expect(containerErrors).toContain('export declare const CYCLE_ERROR_CODE = "REMODULO/CYCLE";')
        expect(injectorErrors).toContain(
            'export declare const INJECTION_CONTEXT_ERROR_CODE = "REMODULO/INJECTION_CONTEXT";'
        )

        expect(containerErrors).toContain('readonly code = "REMODULO/REGISTRATION";')
        expect(containerErrors).toContain('readonly code = "REMODULO/CYCLE";')
        expect(injectorErrors).toContain('readonly code = "REMODULO/INJECTION_CONTEXT";')
        expect(containerErrors).toContain("readonly code: typeof RESOLUTION_ERROR_CODE | typeof CYCLE_ERROR_CODE;")
    })

    it("reaches the classes and the codes from both entry points", () => {
        const index = declaration("index.d.ts")
        const types = declaration("types.d.ts")

        // Values on `.`: a `catch` branch needs the constructor and the code to compare against.
        for (const published of [
            "RegistrationError",
            "ResolutionError",
            "CycleError",
            "REGISTRATION_ERROR_CODE",
            "RESOLUTION_ERROR_CODE",
            "CYCLE_ERROR_CODE",
        ]) {
            expect(index).toContain(published)
        }
        expect(index).toContain("InjectionContextError")
        expect(index).toContain("INJECTION_CONTEXT_ERROR_CODE")

        // Types on `./types`: the instance types, for a consumer annotating a caught value.
        expect(types).toContain(
            'export type { CycleError, RegistrationError, ResolutionError } from "./container.errors.js"'
        )
        expect(types).toContain('export type { InjectionContextError } from "./injector.errors.js"')
    })

    it("publishes a tokenizer factory whose namespace is required, and no global `Token`", () => {
        // The namespace carries the whole collision story, so it is not optional and there is no default
        // for it to fall back to — a consumer mints one tokenizer per library. The options bag went with
        // the duplicate guard, so minting takes a name and nothing else.
        expect(declaration("tokenizer.d.ts")).toContain(
            "export declare function makeTokenizer(namespace: string): Tokenizer;"
        )
        expect(declaration("tokenizer.d.ts")).toContain(
            "export type Tokenizer = <T = unknown>(name: string) => InjectionToken<T>;"
        )
        expect(declaration("index.d.ts")).toContain('export { makeTokenizer } from "./tokenizer.js"')

        // The global tokenizer and its options type are gone from both entry points.
        for (const file of ["tokenizer.d.ts", "index.d.ts", "types.d.ts"]) {
            expect(declaration(file)).not.toContain("TokenOptions")
            expect(declaration(file)).not.toContain("allowDuplicate")
            expect(declaration(file)).not.toContain("DEFAULT_TOKEN_NAMESPACE")
        }
        expect(declaration("index.d.ts")).not.toMatch(/\bToken\b/)
        expect(declaration("types.d.ts")).not.toMatch(/\bToken\b/)
    })

    it("publishes describeToken as a value, with the signature the errors use it through", () => {
        // It renders every token an error message names; the layer above needs the same rendering rather
        // than a copy of it, so it is a published function and its one-argument shape is the surface.
        expect(declaration("utils/describeToken.d.ts")).toContain(
            "export declare function describeToken(token: InjectionToken): string;"
        )
        expect(declaration("index.d.ts")).toContain('export { describeToken } from "./utils/describeToken.js"')
    })

    it("publishes a provider grammar with no `lazy`", () => {
        // Owner ruling: lazy/eager is lifecycle policy, not container semantics. The field belongs to the
        // module layer, and the emitted grammar is what a consumer is offered.
        expect(declaration("providers.types.d.ts")).not.toContain("lazy")
        expect(declaration("container.types.d.ts")).not.toContain("lazy")
    })
})
