/**
 * Type-regression consumer.
 *
 * This file is compiled against the PUBLISHED declarations — `node_modules/@remodulo/react/dist` and
 * `node_modules/@remodulo/container/dist`, both installed from packed tarballs, never from `src` and
 * never through a path alias. `npm run typecheck` in the repo only proves `src/` is self-consistent
 * under our own tsconfig; this proves the emitted `.d.ts` still means something in somebody else's
 * project.
 *
 * Two packages, because 0.10.0 is two packages: the React runtime declares `@remodulo/container` as a
 * dependency, so a consumer that installs one installs both, and the boundary between them — what each
 * entry point does and does NOT export — is itself part of the contract this file pins.
 *
 * Nothing here runs. `tsc --noEmit` is the entire test, and two kinds of assertion carry the weight:
 *
 *   1. `Expect<Equals<A, B>>` — pins an INFERRED type exactly. The dangerous regression is not a
 *      compile error, it is a silent widening to `any`: `createModuleComponent<UserProps>()` handing back
 *      `PropsRef<any>` compiles perfectly and destroys every consumer downstream. `Equals` is the
 *      strict variant, so `any` is never equal to a concrete type.
 *   2. `@ts-expect-error` — errors that MUST stay errors. When a type widens to `any` the expected
 *      error disappears and the directive itself becomes the failure.
 *
 * Keep this file identical between the react18 and react19 consumers. The two profiles differ only in
 * `package.json` (@types/react major) and `tsconfig.json` (module resolution) — that is the variable
 * under test; the source is the control.
 */

// No `import "reflect-metadata"`, and no decorator flags in either tsconfig. 0.10.0 dropped the
// decorator surface for ambient `inject()`, so the polyfill and the compiler options that used to be
// the price of entry are both gone — and their absence here is what proves the claim. The runner
// additionally scans the installed `dist` of both packages for the string.

import { useState } from "react"
import type { ComponentProps, ComponentType, ReactElement, ReactNode } from "react"

import {
    App,
    AppProvider,
    Module,
    ModuleProvider,
    ModuleStatus,
    ModuleTraversal,
    PropsRef,
    Ref,
    RefMap,
    createFeature,
    createModuleComponent,
    useModule,
    useModuleContext,
    useModuleRebuild,
    usePropsRef,
    useResolve,
    useResolveAll,
    useResolveOptional,
    useResolver,
    withModule,
} from "@remodulo/react"

// The `./types` subpath has to carry the whole type surface on its own — a consumer that only wants
// types must never have to reach into `.` or into `dist/`. Since 0.10.0 that includes the kernel types
// the React package re-exports: a consumer reading a registration snapshot off a resolver it got from
// `useResolver()` never imported `@remodulo/container` by hand.
import type {
    AppProviderProps,
    ClassProvider,
    ExistingProvider,
    FactoryProvider,
    Feature,
    ModuleConfig,
    ModuleContextValue,
    ModuleHook,
    ModuleHooks,
    ModuleParams,
    ModuleProviderProps,
    ModuleStatus as ModuleStatusFromTypesEntry,
    PropsAdapter,
    PropsBridgeOptions,
    Provider,
    ProviderInput,
    ProviderLifecycle,
    SelfClassProvider,
    TokenClassProvider,
    UsePropsRefOptions,
    UsePropsRefResult,
    ValueProvider,
} from "@remodulo/react/types"

// The kernel, reached directly — which is now the ONLY way to reach it. `@remodulo/container` is a peer
// dependency and re-exports nothing through `@remodulo/react`, so a consumer imports kernel tools from
// the kernel and react tools from react. `Provider` is the one name the two packages both spell: react
// derives its own with a `lazy` key, so the kernel's form is aliased here to be compared with it.
import {
    CYCLE_ERROR_CODE,
    Container,
    ContainerEvent,
    CycleError,
    INJECTION_CONTEXT_ERROR_CODE,
    InjectionContextError,
    REGISTRATION_ERROR_CODE,
    RESOLUTION_ERROR_CODE,
    RegistrationError,
    RegistrationMode,
    ResolutionError,
    ResolveAllMode,
    ResolveMode,
    Resolver,
    Scope,
    describeToken,
    inject,
    injectAll,
    injectContainer,
    injectOptional,
    injectResolver,
    makeTokenizer,
    runInInjectionContext,
} from "@remodulo/container"

import type {
    AbstractConstructor,
    AfterMaterializeEvent,
    AfterResolutionEvent,
    AliasEntrySnapshot,
    BeforeMaterializeEvent,
    BeforeResolutionEvent,
    BindingEntrySnapshot,
    ClassKey,
    Constructor,
    ContainerEventListener,
    ContainerEventPayload,
    EntryMetadata,
    EntrySnapshot,
    Frame,
    InjectionToken,
    Provider as KernelProvider,
    RequestCache,
    Tokenizer,
} from "@remodulo/container/types"

// Assertion helpers — zero dependency on purpose.
// ========================================

// The strict equality trick: two deferred conditionals are assignable to each other only when `A` and
// `B` are the *identical* type, so `any` never sneaks through as "close enough".
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type IsAny<T> = 0 extends 1 & T ? true : false
type Not<T extends boolean> = T extends true ? false : true
type Expect<T extends true> = T
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false

// The two module namespaces, as types. `HasKey` over one of these is how an export's ABSENCE is pinned:
// a missing name cannot be imported, and an import that fails is a compile error rather than an
// assertion, so the negative space needs a shape to ask questions of.
type ReactEntry = typeof import("@remodulo/react")
type ReactTypesEntry = typeof import("@remodulo/react/types")
type ContainerEntry = typeof import("@remodulo/container")

// The gate is only worth something if the strict flags are really in effect — a tsconfig regression
// that quietly relaxes them would otherwise leave everything below still green.
// ========================================

declare const someStrings: string[]
const indexedString = someStrings[0]
type _NoUncheckedIndexedAccessIsOn = Expect<Equals<typeof indexedString, string | undefined>>

declare const maybeLimit: number | undefined
// @ts-expect-error exactOptionalPropertyTypes: an explicit `undefined` is not a legal value for `limit?: number`.
const exactOptionalGuard: UserProps = { userId: "u-0", limit: maybeLimit }
void exactOptionalGuard

// Domain — an ordinary feature slice, written the way an app would write it.
// ========================================

type UserProps = {
    userId: string
    limit?: number
}

// The view model an adapter produces: the `T !== P` shape of `usePropsRef` / `createModuleComponent`.
type UserVM = {
    id: string
    take: number
}

type AppConfig = {
    baseUrl: string
    retries: number
}

interface Logger {
    log(message: string): void
}

interface Plugin {
    name: string
}

// Tokens
// ========================================

// There is no global tokenizer any more: a consumer mints its own, and the namespace it names is what
// keeps its tokens from colliding with another library's. Both parameters are required — the namespace
// on the factory, the name on the mint — and there is no options bag on either.
const consumerTokenizer = makeTokenizer("@consumer")
type _TokenizerShape = Expect<Equals<typeof consumerTokenizer, Tokenizer>>
type _MakeTokenizerNeedsANamespace = Expect<Equals<Parameters<typeof makeTokenizer>, [string]>>
type _TokenizerTakesOnlyAName = Expect<Equals<Parameters<Tokenizer>, [string]>>

const CONFIG = consumerTokenizer<AppConfig>("config")
type _ConfigTokenIsTyped = Expect<Equals<typeof CONFIG, InjectionToken<AppConfig>>>
type _ConfigTokenIsNotAny = Expect<Not<IsAny<typeof CONFIG>>>

const PLUGIN = consumerTokenizer<Plugin>("plugin")
const LOGGER = consumerTokenizer<Logger>("logger")

const appTokenizer = makeTokenizer("@consumer.feature")
const FEATURE_LOGGER = appTokenizer<Logger>("feature.logger")
type _FeatureLoggerIsTyped = Expect<Equals<typeof FEATURE_LOGGER, InjectionToken<Logger>>>

// Minting a name twice is no longer refused — it is the same declaration, and so the same token.
const DUPLICATE_PLUGIN = consumerTokenizer<Plugin>("plugin")
type _DuplicatePluginIsTyped = Expect<Equals<typeof DUPLICATE_PLUGIN, InjectionToken<Plugin>>>

// An abstract class is a legal token too — that is what `AbstractConstructor` is in the union for.
abstract class LoggerPort implements Logger {
    abstract log(message: string): void
}
const abstractToken: InjectionToken<LoggerPort> = LoggerPort
const abstractCtor: AbstractConstructor<LoggerPort> = LoggerPort
void abstractToken

// Services — plain classes, dependencies read in field initializers.
// ========================================
//
// This is the whole of 0.10.0's injection story from a consumer's side: no base class, no decorator, no
// token on a parameter. `inject()` reads the container that is currently constructing, so the call site
// IS the declaration — and because it is an ordinary function call, the type comes from the token
// rather than from metadata a compiler flag has to emit.

class ApiClient {
    async get<T>(path: string): Promise<T> {
        const response = await fetch(path)
        return (await response.json()) as T
    }
}

class ConsoleLogger implements Logger {
    constructor(private readonly prefix: string) {}

    log(message: string): void {
        console.log(`${this.prefix}${message}`)
    }
}

// A `PropsRef` subclass is a distinct class and therefore a distinct injection token, which is how a
// service reaches ITS boundary's props with the right type. The base class binding is `PropsRef<any>`
// (see the injection-functions probe below), so the subclass is not sugar — it is the typed path.
class UserPropsRef extends PropsRef<UserProps> {}

// A service that both participates in the module lifecycle and reads component props through the
// bridge the boundary registers for it.
class UserStore implements ProviderLifecycle {
    private off: (() => void) | null = null
    private snapshot: UserProps | null = null

    private readonly props = inject(UserPropsRef)
    private readonly api = inject(ApiClient)
    private readonly config = inject(CONFIG)

    // The optional read is a different function, not a flag on the same one: what `undefined` means is
    // decided at the call site and shows up in the type.
    private readonly logger = injectOptional(LOGGER)

    onModuleInit(): void {
        const config = this.config
        type _InjectedTokenType = Expect<Equals<typeof config, AppConfig>>

        const logger = this.logger
        type _InjectedOptionalType = Expect<Equals<typeof logger, Logger | undefined>>

        // The subscription can outlive a rebuilt-away service, so the `off` is kept and released below.
        this.off = this.props.onUpdate(
            (next, prev) => {
                type _SubscriberNext = Expect<Equals<typeof next, UserProps>>
                type _SubscriberPrev = Expect<Equals<typeof prev, UserProps>>
                this.snapshot = next
                void prev
            },
            { immediate: true }
        )
    }

    onModuleMount(): void {}

    onModuleUnmount(): void {}

    onModuleDestroy(): void {
        this.off?.()
        this.off = null
    }

    get userId(): string {
        const current = this.props.current
        type _PropsRefCurrent = Expect<Equals<typeof current, UserProps>>
        return this.snapshot?.userId ?? current.userId
    }

    async load(): Promise<Plugin[]> {
        const current = this.props.current
        const api = this.api
        type _InjectedClassType = Expect<Equals<typeof api, ApiClient>>

        return api.get<Plugin[]>(
            `${this.config.baseUrl}/users/${current.userId}?limit=${current.limit ?? this.config.retries}`
        )
    }
}

// The system providers a consumer is allowed to inject. `Module` is the substrate: injecting it reaches
// the module instance and its container directly.
class Diagnostics {
    private readonly module = inject(Module)
    private readonly traversal = inject(ModuleTraversal)
    private readonly resolver = inject(Resolver)
    private readonly logger = injectOptional(LOGGER)

    describe(): string {
        const id = this.module.id
        type _ModuleId = Expect<Equals<typeof id, string>>

        // The parent is a Module, not a bare Container — the tree is modules all the way up.
        const parent = this.module.parent
        type _ModuleParent = Expect<Equals<typeof parent, Module | null>>

        const children = this.module.children
        type _ModuleChildren = Expect<Equals<typeof children, ReadonlySet<Module>>>

        // Read-only on the way out: the tree is edited through `addChild`/`removeChild`, which is where
        // the lifecycle's attach/detach bookkeeping lives. A raw `Set` field would hand both away.
        // @ts-expect-error a ReadonlySet has no `add`.
        children.add(this.module)
        // @ts-expect-error and no `delete` either.
        children.delete(this.module)

        // …and the pair itself is off the published type. Both are `@internal`, which `stripInternal`
        // turns into absence in the emitted `.d.ts` — so the only way to edit the tree from out here is
        // to not edit the tree. These two directives are what a dropped `@internal` tag fails against:
        // lose the tag, the member returns, the expected error never happens, and the directive becomes
        // the error. This file is the only gate that catches that, because it is the only one compiled
        // against the stripped declarations rather than against `src`.
        // @ts-expect-error `addChild` is internal and stripped from the published declarations.
        this.module.addChild(this.module)
        // @ts-expect-error `removeChild` likewise.
        this.module.removeChild(this.module)
        // @ts-expect-error and `lifecycle`, which became a Module field when it stopped being a
        // registration. It is the module's own machinery, not a consumer dependency — the same
        // soft-block as the pair above, and it has no token to resolve it by either.
        void this.module.lifecycle
        // @ts-expect-error and `container`, the WRITE door. It is the strongest of the four: a consumer
        // holding it could `register()` after init, behind the lifecycle's back, and the participant scan
        // has already run. `resolver` below is the read half, and it is the whole published door.
        void this.module.container

        // Two access paths, one object: the field for code already holding a module, the injected token
        // for services. The `toBe` half is a runtime fact the tests own; what is pinned here is that both
        // paths are typed `ModuleTraversal` and neither has widened.
        const ownTraversal = this.module.traversal
        type _ModuleTraversalField = Expect<Equals<typeof ownTraversal, ModuleTraversal>>
        // `resolver` is a PUBLIC field now: the canonical resolver for this module's container, the same
        // object `inject(Resolver)` hands a service and the same one `Resolver.for(container)` returns.
        // Three doors, one instance — the field exists so code already holding a module does not have to
        // go through the container to read it.
        const ownResolver = this.module.resolver
        type _ModuleResolverField = Expect<Equals<typeof ownResolver, Resolver>>
        type _ModuleResolverIsNotAny = Expect<Not<IsAny<typeof ownResolver>>>

        type _ModuleTraversalFieldIsNotAny = Expect<Not<IsAny<typeof ownTraversal>>>
        type _InjectedMatchesField = Expect<Equals<typeof ownTraversal, typeof this.traversal>>

        // The declared provider snapshot is GONE — deleted, not hidden. It was a second view of what
        // `container.registrations()` already answers, and answers better: the entries down in the
        // container section carry the scope the registration defaulted and the metadata it wrote, where
        // the declared copy could only repeat the provider literal. `ProviderSnapshot` went with it.
        // @ts-expect-error `providers` no longer exists on Module — ask the container instead.
        void this.module.providers

        // NEW published surface. `status` is the SINGLE state read on a module, and it is the exact
        // eight-literal alphabet — a consumer can switch on it exhaustively, and widening it to `string`
        // would be a silent break. `initializing` is in the type even though no consumer read can observe
        // it: the phase is synchronous, and a union that hid one member would not be exhaustive.
        const status = this.module.status
        type _ModuleStatus = Expect<
            Equals<
                typeof status,
                | "created"
                | "initializing"
                | "initialized"
                | "mounted"
                | "unmounted"
                | "destroying"
                | "destroyed"
                | "failed"
            >
        >
        type _ModuleStatusIsNotAny = Expect<Not<IsAny<typeof status>>>

        // `ModuleStatus` is exported by name from BOTH entry points — value and type. Without the value a
        // consumer has no way to spell the comparison except as a bare string literal, which is exactly
        // the coupling the alphabet exists to avoid.
        const isMounted: boolean = this.module.status === ModuleStatus.Mounted
        type _ModuleStatusTypeIsTheAlphabet = Expect<Equals<ModuleStatus, typeof status>>
        type _ModuleStatusIsExported = Expect<Equals<HasKey<ReactEntry, "ModuleStatus">, true>>
        type _ModuleStatusOnTypesEntry = Expect<Equals<ModuleStatusFromTypesEntry, ModuleStatus>>

        // The four derived booleans that used to hang off `status` — `initialized`, `mounted`, `destroyed`
        // and the `@internal` `claimed` — are DELETED, not hidden. A second view of one value is a second
        // thing that has to be kept true, so `status` is now the only read and these names are gone from
        // the published type entirely.
        type _NoInitialized = Expect<Equals<HasKey<Module, "initialized">, false>>
        type _NoMounted = Expect<Equals<HasKey<Module, "mounted">, false>>
        type _NoDestroyed = Expect<Equals<HasKey<Module, "destroyed">, false>>
        type _NoClaimed = Expect<Equals<HasKey<Module, "claimed">, false>>

        // @ts-expect-error `initialized` is gone — `status` is neither `created` nor `failed`.
        void this.module.initialized
        // @ts-expect-error `mounted` is gone — `status === ModuleStatus.Mounted`.
        void this.module.mounted
        // @ts-expect-error `destroyed` is gone — `status === ModuleStatus.Destroyed`.
        void this.module.destroyed
        // @ts-expect-error `claimed` is gone — `status` is `destroying` or `destroyed`.
        void this.module.claimed

        const store = this.resolver.resolve(UserStore)
        type _ResolverResolve = Expect<Equals<typeof store, UserStore>>

        // `Resolver` mirrors `Container`'s read surface exactly, mode parameters included — a narrower
        // signature here is a silent divergence, so both families are pinned through it.
        const maybeLogger = this.resolver.resolveOptional(LOGGER, "self")
        type _ResolverResolveOptional = Expect<Equals<typeof maybeLogger, Logger | undefined>>
        type _ResolverResolveMode = Expect<Equals<Parameters<Resolver["resolveOptional"]>[1], ResolveMode | undefined>>

        // The two-overload fallback read is on the mirror as well, thunk arm first.
        const loggerOrLazy = this.resolver.resolveOr(LOGGER, () => null)
        type _ResolverResolveOrLazy = Expect<Equals<typeof loggerOrLazy, Logger | null>>

        // `isRegistered` is the one read that does NOT take `ResolveMode`: it asks a registration question,
        // not a resolution one, so it takes `RegistrationMode`. The two unions are structurally identical
        // today, so this pin cannot tell them apart — it holds the SHAPE, and the name is what documents the
        // axis. What it does catch is the union growing on one side: `"chained"` is refused below.
        type _ResolverIsRegisteredMode = Expect<
            Equals<Parameters<Resolver["isRegistered"]>[1], RegistrationMode | undefined>
        >

        const allPlugins = this.resolver.resolveAll(PLUGIN)
        type _ResolverResolveAll = Expect<Equals<typeof allPlugins, Plugin[]>>
        type _ResolverResolveAllMode = Expect<
            Equals<Parameters<Resolver["resolveAll"]>[1], ResolveAllMode | undefined>
        >

        const nearestPlugins = this.resolver.resolveAll(PLUGIN, "nearest")
        type _ResolverResolveAllNearest = Expect<Equals<typeof nearestPlugins, Plugin[]>>
        void nearestPlugins

        return [
            id,
            String(children.size),
            status,
            String(isMounted),
            store.userId,
            maybeLogger ? "y" : "n",
            String(allPlugins.length),
            this.logger ? "y" : "n",
            String(loggerOrLazy),
            this.walk(),
        ].join("/")
    }

    // ModuleTraversal is the module tree, exposed as modules — never as containers. A caller that wants
    // to READ off a node reaches it through `module.resolver`, which is now the only access path: the
    // container behind it is `@internal` and stripped.
    walk(): string {
        const parent = this.traversal.parent()
        type _TraversalParent = Expect<Equals<typeof parent, Module | null>>

        const ancestors = this.traversal.ancestors()
        type _TraversalAncestors = Expect<Equals<typeof ancestors, Module[]>>

        const root = this.traversal.findRoot()
        type _TraversalFindRoot = Expect<Equals<typeof root, Module>>
        type _TraversalFindRootIsNotNullable = Expect<Not<Equals<typeof root, Module | null>>>

        const children = this.traversal.children()
        type _TraversalChildren = Expect<Equals<typeof children, Module[]>>

        const descendants = this.traversal.descendants()
        type _TraversalDescendants = Expect<Equals<typeof descendants, Module[]>>

        const byId = this.traversal.findAncestorById("app-root")
        type _TraversalFindAncestorById = Expect<Equals<typeof byId, Module | null>>

        const descendantById = this.traversal.findDescendantById("user")
        type _TraversalFindDescendantById = Expect<Equals<typeof descendantById, Module | null>>

        const owner = this.traversal.findAncestorByProvider(CONFIG)
        type _TraversalFindAncestorByProvider = Expect<Equals<typeof owner, Module | null>>

        const holders = this.traversal.findDescendantsByProvider(PLUGIN)
        type _TraversalFindDescendantsByProvider = Expect<Equals<typeof holders, Module[]>>

        // `module.resolver` is the read path the traversal no longer hands out directly, so it has to
        // still be a `Resolver` here — a widening on either side shows up as this assertion failing.
        const rootResolver = root.resolver
        type _TraversalRootResolver = Expect<Equals<typeof rootResolver, Resolver>>
        // @ts-expect-error and the write path is not reachable off a traversed node either.
        void root.container

        return [
            parent ? "p" : "-",
            String(ancestors.length),
            String(rootResolver.isRegistered(CONFIG)),
            String(children.length),
            String(descendants.length),
            byId ? "y" : "n",
            descendantById ? "y" : "n",
            owner ? "y" : "n",
            String(holders.length),
        ].join("/")
    }
}

// A collection read, in the same field-initializer position. The mode is the same one every other
// collection read takes — one semantics parameterized uniformly, not a second option channel.
class PluginRegistry {
    readonly plugins = injectAll(PLUGIN)
    readonly chainedPlugins = injectAll(PLUGIN, { mode: "chained" })
    readonly ownPlugins = injectAll(PLUGIN, { mode: ResolveAllMode.Self })
    readonly api = inject(ApiClient)

    names(): string[] {
        const plugins = this.plugins
        type _InjectAllType = Expect<Equals<typeof plugins, Plugin[]>>
        type _InjectAllIsNotAny = Expect<Not<IsAny<typeof plugins>>>
        return [...plugins, ...this.chainedPlugins, ...this.ownPlugins].map((plugin) => plugin.name)
    }
}

// The injection functions, pinned as functions.
// ========================================
//
// `runInInjectionContext` is the one that makes them testable from outside a construction: it opens a
// frame by hand, so the same four readers work in a plain function body.

export function probeInjection(container: Container): string {
    const probed = runInInjectionContext(container, () => {
        const api = inject(ApiClient)
        type _InjectByClass = Expect<Equals<typeof api, ApiClient>>
        type _InjectByClassIsNotAny = Expect<Not<IsAny<typeof api>>>

        const config = inject(CONFIG)
        type _InjectByToken = Expect<Equals<typeof config, AppConfig>>

        const ownConfig = inject(CONFIG, { mode: "self" })
        type _InjectParams = Expect<
            Equals<Parameters<typeof inject>[1], { mode?: ResolveMode; delayed?: never } | undefined>
        >

        const maybeLogger = injectOptional(LOGGER, { mode: ResolveMode.Nearest })
        type _InjectOptional = Expect<Equals<typeof maybeLogger, Logger | undefined>>
        type _InjectOptionalParams = Expect<
            Equals<Parameters<typeof injectOptional>[1], { mode?: ResolveMode; delayed?: never } | undefined>
        >

        const plugins = injectAll(PLUGIN)
        type _InjectAll = Expect<Equals<typeof plugins, Plugin[]>>

        // Unlike the parameter decorator it replaced, the function carries the WHOLE mode set: own-only
        // injection is expressible now, because there is no planner between the call and the container.
        const ownPlugins = injectAll(PLUGIN, { mode: "self" })
        type _InjectAllSelf = Expect<Equals<typeof ownPlugins, Plugin[]>>
        type _InjectAllParams = Expect<
            Equals<Parameters<typeof injectAll>[1], { mode?: ResolveAllMode; delayed?: never } | undefined>
        >

        const own = injectContainer()
        type _InjectContainer = Expect<Equals<typeof own, Container>>
        type _InjectContainerTakesNothing = Expect<Equals<Parameters<typeof injectContainer>, []>>

        // The read-and-observe half of the same anchor: same no-argument shape, and a `Resolver` rather
        // than a `Container`, so a service handed one cannot register through it.
        const ownResolver = injectResolver()
        type _InjectResolver = Expect<Equals<typeof ownResolver, Resolver>>
        type _InjectResolverTakesNothing = Expect<Equals<Parameters<typeof injectResolver>, []>>
        type _InjectResolverIsNotTheContainer = Expect<Not<Equals<typeof ownResolver, Container>>>

        // The base class is a token like any other, and it carries no props type: `inject(PropsRef)`
        // reads `PropsRef<unknown>`, so `.current` is unknown and nothing about the boundary's props is
        // knowable from it. A service that wants them TYPED reaches for a subclass token (`UserPropsRef`
        // above) or a `Token<PropsRef<T>>` — this pin is the reason those exist.
        const untypedProps = inject(PropsRef)
        type _BasePropsRefIsUntyped = Expect<Equals<typeof untypedProps, PropsRef<unknown>>>
        type _BasePropsRefCurrentIsUnknown = Expect<Equals<typeof untypedProps.current, unknown>>
        type _BasePropsRefIsNotAny = Expect<Not<IsAny<typeof untypedProps.current>>>

        return [api, config, ownConfig, maybeLogger, plugins, ownPlugins, own, ownResolver, untypedProps].length
    })

    // `describeToken` is published so a consumer's own diagnostics render a token the way the kernel's
    // errors do, rather than keeping a copy that drifts. It takes the token union and returns a string —
    // never `undefined`, whatever it is handed.
    const described = describeToken(CONFIG)
    type _DescribeToken = Expect<Equals<typeof described, string>>
    type _DescribeTokenTakesOneToken = Expect<Equals<Parameters<typeof describeToken>, [InjectionToken]>>

    // `ClassKey` is the arm that lets a class be a KEY without being constructible — the shape behind
    // `Resolver` being registrable under itself despite its private constructor. `NoInfer` on `prototype`
    // is what keeps it a fallback, so a generic class token still reads through the constructor arms.
    type _ClassKeyAcceptsAPrivateConstructor = Expect<
        Equals<typeof Resolver extends ClassKey<Resolver> ? true : false, true>
    >
    type _ClassKeyIsAValidToken = Expect<Equals<ClassKey<Logger> extends InjectionToken<Logger> ? true : false, true>>

    // The return type is the callback's, not `unknown`.
    type _RunInInjectionContextReturns = Expect<Equals<typeof probed, number>>

    return String(probed)
}

// @ts-expect-error a single read has two modes; `chained` is a collection width.
void inject(PLUGIN, { mode: "chained" })

// @ts-expect-error the same for the optional single read.
void injectOptional(PLUGIN, ResolveAllMode.Chained)

// @ts-expect-error `runInInjectionContext` anchors at a container — the container is not optional.
void runInInjectionContext(() => 1)

// The decorator surface is gone.
// ========================================
//
// 0.10.0 removed it outright rather than deprecating it: ambient `inject()` needs no metadata, so the
// decorators had nothing left to carry. A missing export cannot be imported at all, so the absence is
// asked of the module namespace instead — and these six are what a 0.9 call site would reach for first.

type _NoInjectable = Expect<Not<HasKey<ReactEntry, "Injectable">>>
type _NoInject = Expect<Not<HasKey<ReactEntry, "Inject">>>
type _NoInjectAllDecorator = Expect<Not<HasKey<ReactEntry, "InjectAll">>>
type _NoOptional = Expect<Not<HasKey<ReactEntry, "Optional">>>
type _NoDecorate = Expect<Not<HasKey<ReactEntry, "decorate">>>
type _NoLazyToken = Expect<Not<HasKey<ReactEntry, "LazyToken">>>

// The kernel is not hiding them either — nothing re-exports a decorator from anywhere.
type _KernelHasNoInjectable = Expect<Not<HasKey<ContainerEntry, "Injectable">>>
type _KernelHasNoDecorate = Expect<Not<HasKey<ContainerEntry, "decorate">>>
type _KernelHasNoLazyToken = Expect<Not<HasKey<ContainerEntry, "LazyToken">>>

// A construction cycle is broken by moving the read out of the initializer instead of by a deferred
// token: `inject()` inside a method body runs after both objects exist. There is no `LazyToken` because
// there is no decorator whose argument had to be deferred.

// Element holders — Ref / RefMap, and the subclass-as-token pattern.
// ========================================
//
// Each subclass is its own class and therefore its own injection token, which is how "one element per
// token" is spelled with no token ceremony.

class InputRef extends Ref<HTMLInputElement> {}
class FieldRefs extends RefMap<HTMLInputElement> {}
class RowRefs extends RefMap<HTMLTableRowElement, number> {}

declare const inputRef: InputRef
declare const fieldRefs: FieldRefs
declare const rowRefs: RowRefs

// The holder is typed by the type parameter, and starts null.
const heldInput = inputRef.current
type _RefCurrent = Expect<Equals<typeof heldInput, HTMLInputElement | null>>
type _RefCurrentIsNotAny = Expect<Not<IsAny<typeof heldInput>>>

// `set` is what goes on the `ref` prop: a callback taking the element or null and returning nothing. The
// void return is load-bearing on React 19, which reads any other return value as a cleanup function.
type _RefSet = Expect<Equals<typeof inputRef.set, (value: HTMLInputElement | null) => void>>

const attachInput = <input ref={inputRef.set} />
void attachInput

// No negative pin for the wrong element type on purpose: `<div ref={inputRef.set} />` is an error under
// @types/react 19 but NOT under 18, whose `RefCallback` is declared through the bivariance hack and so
// accepts any element-shaped callback. The mismatch is caught for React 19 consumers and silently is not
// for React 18 ones — a typings fact, not something the holder can fix, and this file has to compile
// identically under both. `_RefSet` above is the assertion that actually holds everywhere.

// RefMap keys default to string, and `set(key)` hands back the same per-key callback shape.
const attachField = fieldRefs.set("email")
type _RefMapSet = Expect<Equals<typeof attachField, (element: HTMLInputElement | null) => void>>

const heldField = fieldRefs.get("email")
type _RefMapGet = Expect<Equals<typeof heldField, HTMLInputElement | null>>

const allFields = fieldRefs.all()
type _RefMapAll = Expect<Equals<typeof allFields, ReadonlyMap<string, HTMLInputElement>>>

// @ts-expect-error `all()` is a read-only view — the map is not the place to attach elements.
allFields.set("email", null as unknown as HTMLInputElement)

// The second type parameter moves the key off `string`.
type _RefMapKeyed = Expect<Equals<ReturnType<typeof rowRefs.all>, ReadonlyMap<number, HTMLTableRowElement>>>

// @ts-expect-error a number-keyed RefMap does not take a string key.
void rowRefs.set("1")

const attachRow = <tr ref={rowRefs.set(1)} />
void attachRow

// Both are ordinary class providers: bare constructor, or `useClass` with a scope.
const refProviders: Provider[] = [InputRef, FieldRefs, { useClass: RowRefs, scope: Scope.Transient }]
const refClassProvider: ClassProvider<InputRef> = { provide: InputRef, useClass: InputRef }
void refClassProvider

// And the point of all of it: a service reaches the element through DI instead of through props. The
// subclass is the token, so the field initializer says which element without a symbol in sight.
class FocusManager {
    private readonly input = inject(InputRef)
    private readonly fields = inject(FieldRefs)

    onModuleMount(): void {
        // Populated by now: refs attach in the commit, modules mount in a passive effect.
        this.input.current?.focus()
    }

    focusField(key: string): void {
        this.fields.get(key)?.focus()
    }
}

// Providers — all five shapes the registry accepts.
// ========================================

// 1. constructor shorthand
const constructorProvider: Provider = ApiClient
const apiConstructor: Constructor<ApiClient> = ApiClient
type _ConstructorInstance = Expect<Equals<InstanceType<typeof apiConstructor>, ApiClient>>

// 2. class provider
const classProvider: ClassProvider<UserStore> = {
    provide: UserStore,
    useClass: UserStore,
    scope: "singleton",
}

// A lazy class provider: registered now, constructed on first resolve instead of in the eager pass.
const lazyClassProvider: ClassProvider<PluginRegistry> = {
    provide: PluginRegistry,
    useClass: PluginRegistry,
    lazy: true,
}

// The same shape with `provide` left out: the class registers under itself, which is what the bare
// constructor does — except the options are available here. `ClassProvider` names both spellings, so no
// second type joined the surface to pay for the sugar.
const shorthandClassProvider: ClassProvider<FocusManager> = { useClass: FocusManager }
const namedShorthandProvider: SelfClassProvider<FocusManager> = { useClass: FocusManager }
const namedTokenClassProvider: TokenClassProvider<UserStore> = { provide: UserStore, useClass: UserStore }
const lazyShorthandProvider: ClassProvider<PluginRegistry> = { useClass: PluginRegistry, lazy: true }
const transientShorthandProvider: ClassProvider<ApiClient> = { useClass: ApiClient, scope: Scope.Transient }
void [namedShorthandProvider, namedTokenClassProvider, lazyShorthandProvider, transientShorthandProvider]

// And it is a `Provider` in its own right, options and all.
const shorthandInUnion: Provider = { useClass: PluginRegistry, scope: "singleton", lazy: true }
void shorthandInUnion

// 3. value provider
const valueProvider: ValueProvider<AppConfig> = {
    provide: CONFIG,
    useValue: { baseUrl: "https://api.example.com", retries: 2 },
}

// 4. factory provider. A factory takes NO arguments and reads what it needs in its body: the body runs
// inside the construction that asked for it, so the ambient readers work there exactly as they do in a
// field initializer — including the optional one, here reaching the module instance itself.
const factoryProvider: FactoryProvider<Logger> = {
    provide: LOGGER,
    useFactory: () => {
        const config = inject(CONFIG)
        const module = injectOptional(Module)
        return new ConsoleLogger(`[${module?.id ?? "detached"}] ${config.baseUrl} `)
    },
    scope: Scope.Singleton,
}

// The same thing said in one expression, which is what most factories look like.
const ambientFactoryProvider: FactoryProvider<Logger> = {
    provide: FEATURE_LOGGER,
    useFactory: () => new ConsoleLogger(`[${inject(CONFIG).baseUrl}] `),
}

// 5. existing provider (alias onto an already-registered token)
const existingProvider: ExistingProvider<Logger> = { provide: FEATURE_LOGGER, useExisting: LOGGER }

// The scope model is exactly three strings, and `Scope.*` is nothing but those strings. Unlike 0.9,
// `Scope` reaches a types-only consumer through `./types` as well — every kernel type a provider literal
// needs is on the subpath now.
type _ScopeUnion = Expect<Equals<Scope, "singleton" | "transient" | "request">>
type _ScopeValues = Expect<
    Equals<
        typeof Scope,
        {
            readonly Singleton: "singleton"
            readonly Transient: "transient"
            readonly Request: "request"
        }
    >
>
type _ScopeOnKernelTypesSubpath = Expect<Equals<import("@remodulo/container/types").Scope, Scope>>
type _NoScopeOnReactTypes = Expect<Not<HasKey<ReactTypesEntry, "Scope">>>

const transientProvider: ClassProvider<ApiClient> = { provide: ApiClient, useClass: ApiClient, scope: Scope.Transient }
const requestProvider: ClassProvider<ApiClient> = { provide: ApiClient, useClass: ApiClient, scope: Scope.Request }
const requestLiteralProvider: ClassProvider<ApiClient> = { provide: ApiClient, useClass: ApiClient, scope: "request" }
const requestShorthandProvider: ClassProvider<ApiClient> = { useClass: ApiClient, scope: "request" }
const requestFactoryProvider: FactoryProvider<Logger> = {
    provide: LOGGER,
    useFactory: () => new ConsoleLogger(""),
    scope: Scope.Request,
}
const requestMultiProvider: Provider = { provide: PLUGIN, useClass: PluginRegistry, multi: true, scope: "request" }
const requestLazyProvider: Provider = { provide: ApiClient, useClass: ApiClient, scope: Scope.Request, lazy: true }
void requestLiteralProvider
void requestShorthandProvider
void requestFactoryProvider
void requestMultiProvider
void requestLazyProvider

// The read modes are declared the same way and reach consumers the same way: an `Enum` whose members ARE
// the strings, so a member and a bare literal are interchangeable at every call site.
type _ResolveModeUnion = Expect<Equals<ResolveMode, "self" | "nearest">>
type _ResolveAllModeUnion = Expect<Equals<ResolveAllMode, "self" | "nearest" | "chained">>
type _RegistrationModeUnion = Expect<Equals<RegistrationMode, "self" | "nearest">>
type _ResolveModeValues = Expect<
    Equals<
        typeof ResolveMode,
        {
            readonly Self: "self"
            readonly Nearest: "nearest"
        }
    >
>
type _RegistrationModeValues = Expect<
    Equals<
        typeof RegistrationMode,
        {
            readonly Self: "self"
            readonly Nearest: "nearest"
        }
    >
>
type _ResolveAllModeValues = Expect<
    Equals<
        typeof ResolveAllMode,
        {
            readonly Self: "self"
            readonly Nearest: "nearest"
            readonly Chained: "chained"
        }
    >
>

// A single read has two modes, not three. One value cannot be accumulated, so `"chained"` would have no
// meaning to give it — and the type refuses it rather than silently treating it as the default.
// @ts-expect-error `chained` is a collection width; a single read has nothing to accumulate.
const chainedSingleMode: ResolveMode = "chained"
void chainedSingleMode

// @ts-expect-error the boolean the modes replaced is gone from every read surface.
const legacyRecursiveFlag: ResolveMode = true
void legacyRecursiveFlag

// Negative space: the provider unions must stay discriminated in the emitted declarations.

// @ts-expect-error the declarative `inject` array is gone from every form, class providers included.
const classProviderWithInject: ClassProvider<UserStore> = { provide: UserStore, useClass: UserStore, inject: [CONFIG] }
void classProviderWithInject

// A value provider carries `lazy` too: it builds nothing, but the owner's eager pass MATERIALIZES it, and
// that materialization is what adopts it as a lifecycle participant.
const lazyValueProvider: ValueProvider<AppConfig> = { provide: CONFIG, useValue: valueProvider.useValue, lazy: true }
void lazyValueProvider

// @ts-expect-error `resolutionScoped` is not part of the scope model.
const resolutionScopedFactory: FactoryProvider<Logger> = { provide: LOGGER, useFactory: () => new ConsoleLogger(""), scope: "resolutionScoped" }
void resolutionScopedFactory

// @ts-expect-error `containerScoped` is not part of the scope model.
const containerScopedClass: ClassProvider<UserStore> = { provide: UserStore, useClass: UserStore, scope: "containerScoped" }
void containerScopedClass

// @ts-expect-error the scope model is exactly `singleton | transient | request`.
const removedScope: Scope = "containerScoped"
void removedScope

// @ts-expect-error the tsyringe-era enum member is gone with the lifecycle model that had it.
void Scope.ContainerScoped

// @ts-expect-error `useValue` must match the token's type.
const mistypedValueProvider: ValueProvider<AppConfig> = { provide: CONFIG, useValue: { baseUrl: "x" } }
void mistypedValueProvider

// The class-only restriction, pinned. `provide` is optional for `useClass` because a class is its own
// token; every other form has no token to derive, so dropping `provide` there must stay an error.

// @ts-expect-error a value has no derivable token — `provide` stays required.
const provideLessValue: Provider = { useValue: { baseUrl: "x", retries: 0 } }
void provideLessValue

// @ts-expect-error a factory has no derivable token either.
const provideLessFactory: Provider = { useFactory: () => new ConsoleLogger("") }
void provideLessFactory

// @ts-expect-error an alias needs both ends named; the target is not the token.
const provideLessExisting: Provider = { useExisting: LOGGER }
void provideLessExisting

// The same under its own type name, where `provide` is plainly a required field.
// @ts-expect-error ValueProvider requires `provide`.
const provideLessValueProvider: ValueProvider<AppConfig> = { useValue: { baseUrl: "x", retries: 0 } }
void provideLessValueProvider

// Exactly one implementation key. Each form declares all four and forbids the three it is not, so a mixed
// provider is rejected AT the offending key rather than bouncing off the union as a whole. Verbatim, for
// the first of these:
//
//   Type '{ provide: symbol; useClass: typeof ConsoleLogger; useValue: ConsoleLogger; }' is not
//   assignable to type 'Provider'.
//     Types of property 'useValue' are incompatible.
//       Type 'ConsoleLogger' is not assignable to type 'undefined'.
//
// That second line is the whole point of the matrix: the diagnostic names the key you got wrong.

// @ts-expect-error a class provider cannot also carry a value.
const classAndValue: Provider = { provide: LOGGER, useClass: ConsoleLogger, useValue: new ConsoleLogger("") }
void classAndValue

// @ts-expect-error a factory provider cannot also be an alias.
const factoryAndExisting: Provider = { provide: FEATURE_LOGGER, useFactory: () => 1, useExisting: LOGGER }
void factoryAndExisting

// @ts-expect-error dropping `provide` is not a licence to add a stray implementation key.
const shorthandAndValue: Provider = { useClass: ApiClient, useValue: 1 }
void shorthandAndValue

// Multi-providers — `multi: true`.
// ========================================
//
// A token is either a single registration or a collection, never both, and which of the two it is is a
// property of the whole container chain, settled at registration. That makes the guards holding the
// contract up — `resolve` on a collection, `resolveAll` on a single registration, an alias TARGETING a
// collection — runtime errors by nature; none of them can be pinned from here. What the types owe is
// exactly this much: `multi: true` on the four forms that name a token, and nowhere else.

class FeaturePlugin implements Plugin {
    readonly name = "feature"
}

const multiClass: ClassProvider<Plugin> = { provide: PLUGIN, useClass: FeaturePlugin, multi: true }
const multiValue: ValueProvider<Plugin> = { provide: PLUGIN, useValue: new FeaturePlugin(), multi: true }
const multiFactory: FactoryProvider<Plugin> = { provide: PLUGIN, useFactory: () => new FeaturePlugin(), multi: true }
const multiExisting: ExistingProvider<Plugin> = { provide: PLUGIN, useExisting: FeaturePlugin, multi: true }

const notMulti: ClassProvider<Plugin> = { provide: PLUGIN, useClass: FeaturePlugin, multi: false }
const notMultiShorthand: ClassProvider<Plugin> = { useClass: FeaturePlugin, multi: false }

const multiInUnion: Provider[] = [multiClass, multiValue, multiFactory, multiExisting, notMulti, notMultiShorthand]
void multiInUnion

// The shorthand is the one class spelling that cannot join a collection. It registers the class under
// ITSELF, and a collection whose only member is that class is just the class — so `multi: true` requires
// an explicit `provide`, and the two class spellings differ by more than a keystroke.

// @ts-expect-error the provide-less `useClass` shorthand cannot carry `multi`.
const multiShorthand: Provider = { useClass: FeaturePlugin, multi: true }
void multiShorthand

// @ts-expect-error the same under the form's own name, where both class spellings are in view.
const multiShorthandClassProvider: ClassProvider<Plugin> = { useClass: FeaturePlugin, multi: true }
void multiShorthandClassProvider

// @ts-expect-error a value provider still needs its token, `multi` or not.
const provideLessMultiValue: Provider = { useValue: new FeaturePlugin(), multi: true }
void provideLessMultiValue

// Reaching a collection from a factory — the body, and nothing else.
// ========================================
//
// 0.10.0 removed the declarative `inject` array from the React layer as well as from the kernel: it was a
// second and weaker injection mechanism — two object arms discriminated by `multi`, a per-arm `mode`
// grammar, and a runtime router — saying what three ordinary function calls already say. `FactoryDependency`
// and both its arms left the published type surface with it. A factory body calls `injectAll()`, and every
// mode the collection reads have is spelled at the call site, where the read's own enum types it.

const collectingFactory: FactoryProvider<Plugin[]> = {
    provide: consumerTokenizer<Plugin[]>("plugin.snapshot"),
    useFactory: () => injectAll(PLUGIN, { mode: "nearest" }),
}
void collectingFactory

// The three widths, and the one that only a body read can ask for: `chained` was expressible on the array's
// collection arm too, but the single arm never had it, and `injectAll` is now the only place it is spelled.
const chainedCollectingFactory: FactoryProvider<Plugin[]> = {
    provide: consumerTokenizer<Plugin[]>("plugin.chained"),
    useFactory: () => injectAll(PLUGIN, { mode: ResolveAllMode.Chained }),
}
void chainedCollectingFactory

const declarativeFactory: FactoryProvider<Plugin> = {
    provide: PLUGIN,
    useFactory: () => new FeaturePlugin(),
    // @ts-expect-error the array is gone: a factory declares no dependencies, it reads them.
    inject: [PLUGIN],
}
void declarativeFactory

// The same refusal against the union, which is the type every params surface actually takes.
const declarativeInUnion: Provider[] = [
    // @ts-expect-error `inject` is an unknown property on every arm of the union now.
    { provide: PLUGIN, useFactory: () => new FeaturePlugin(), inject: [PLUGIN] },
]
void declarativeInUnion

// @ts-expect-error `useFactory` tightened to `() => T` in the same move: the variadic signature existed
// only so the array had somewhere to spread into, and a declared parameter is now an error rather than a
// function silently called with nothing.
const parameterisedFactory: FactoryProvider<Plugin> = { provide: PLUGIN, useFactory: (plugin: Plugin) => plugin }
void parameterisedFactory

// The limit of these pins, stated rather than assumed: excess-property checking only fires on a FRESH
// object literal, so a provider assembled into a variable first and annotated afterwards keeps the key and
// nothing catches it. The kernel's own pins have the same gap; it is a property of the checker, not of the
// grammar.
const predeclaredFactory = { provide: PLUGIN, useFactory: () => new FeaturePlugin(), inject: [PLUGIN] }
const predeclaredEscapes: Provider = predeclaredFactory
void predeclaredEscapes

// Features — provider bundles.
// ========================================
//
// `createFeature` bundles provider inputs behind one value, and `ProviderInput` is `Provider | Feature`, so
// features nest. The bundle is flattened where a module is CONSTRUCTED, which is the only place the widening
// reaches: every params surface takes `readonly ProviderInput[]`, and `Container.register` still takes
// providers alone.

const LOGGING_FEATURE = createFeature({ providers: [factoryProvider, existingProvider] })
type _CreateFeatureReturnsFeature = Expect<Equals<typeof LOGGING_FEATURE, Feature>>
type _CreateFeatureIsNotAny = Expect<Not<IsAny<typeof LOGGING_FEATURE>>>

const NAMED_FEATURE = createFeature({ name: "billing", providers: [ApiClient, classProvider] })
const featureName = NAMED_FEATURE.name
type _FeatureName = Expect<Equals<typeof featureName, string | undefined>>

// A feature carries a collection member like any other provider, and features nest.
const PLUGIN_FEATURE = createFeature({ providers: [multiClass, multiValue] })
const ROOT_FEATURE = createFeature({ name: "root", providers: [LOGGING_FEATURE, PLUGIN_FEATURE, valueProvider] })

const featureProviders = ROOT_FEATURE.providers
type _FeatureProviders = Expect<Equals<typeof featureProviders, readonly ProviderInput[]>>

// Both arms of the input union, named.
const providerInputs: readonly ProviderInput[] = [ApiClient, valueProvider, ROOT_FEATURE]
const providerAsInput: ProviderInput = classProvider
void [providerInputs, providerAsInput]

// The params surfaces that widened.
const featureModuleParams: ModuleParams = { id: "featured", providers: [ROOT_FEATURE, ApiClient] }
const featureProviderProps: ModuleProviderProps = { providers: [ROOT_FEATURE], children: null }
void [featureModuleParams, featureProviderProps]

// @ts-expect-error `createFeature` takes a params object — a bare array of providers is not one.
const bareArrayFeature = createFeature([ApiClient])
void bareArrayFeature

// @ts-expect-error `name` is a string when present.
const numericNameFeature = createFeature({ name: 123, providers: [ApiClient] })
void numericNameFeature

const moduleProviders: Provider[] = [
    constructorProvider,
    classProvider,
    lazyClassProvider,
    valueProvider,
    factoryProvider,
    ambientFactoryProvider,
    existingProvider,
    shorthandClassProvider,
    Diagnostics,
    UserStore,
    FocusManager,
    ...refProviders,
]

// Props bridge
// ========================================

const userVMOf = (props: UserProps): UserVM => ({ id: props.userId, take: props.limit ?? 20 })

const userAdapter: PropsAdapter<UserVM> = {
    create: (initial) => {
        type _AdapterCreateInitial = Expect<Equals<typeof initial, UserVM>>
        return initial
    },
    update: ({ current, next }) => {
        // Both sides are T now: `use` did the P -> T step before the ref ever saw the props.
        type _AdapterUpdateCurrent = Expect<Equals<typeof current, UserVM>>
        type _AdapterUpdateNext = Expect<Equals<typeof next, UserVM>>
        current.id = next.id
        current.take = next.take
        return current
    },
}

const USER_VM = consumerTokenizer<PropsRef<UserVM>>("user-vm")

// createModuleComponent
// ========================================

// (a) params object, no options — `T` defaults to `P`.
const UserModule = createModuleComponent<UserProps>({
    id: "user",
    providers: moduleProviders,
    onModuleInit: (resolver) => {
        type _ModuleInitResolver = Expect<Equals<typeof resolver, Resolver>>
        void resolver
    },
})
type _UserModuleProps = Expect<Equals<typeof UserModule, ComponentType<UserProps & { children?: ReactNode }>>>
type _UserModuleIsNotAny = Expect<Not<IsAny<typeof UserModule>>>

// (b) params derived from props — the callback parameter must be `P`, not `any`.
const UserFactoryModule = createModuleComponent<UserProps>((props) => {
    type _CreateModuleComponentConfigProps = Expect<Equals<typeof props, UserProps>>
    type _CreateModuleComponentConfigPropsAreNotAny = Expect<Not<IsAny<typeof props>>>
    return {
        id: `user-${props.userId}`,
        providers: moduleProviders,
        deps: [props.userId, props.limit],
    }
})
type _UserFactoryModuleProps = Expect<Equals<typeof UserFactoryModule, ComponentType<UserProps & { children?: ReactNode }>>>

// (c) `{ propsAdapter, propsToken }` — the component's props stay `P` while the bridged value becomes `T`.
const UserVMModule = createModuleComponent<UserProps, UserVM>(
    { providers: moduleProviders },
    { use: userVMOf, adapter: userAdapter, token: USER_VM }
)
type _UserVMModuleProps = Expect<Equals<typeof UserVMModule, ComponentType<UserProps & { children?: ReactNode }>>>

// (d) no arguments at all — a module that only owns a scope.
const BareModule = createModuleComponent()

// (e) a feature in `providers` — the bundle flattens at construction, so the component type is unchanged.
const FeaturedModule = createModuleComponent<UserProps>({ providers: [ROOT_FEATURE, ...moduleProviders] })
type _FeaturedModuleProps = Expect<Equals<typeof FeaturedModule, ComponentType<UserProps & { children?: ReactNode }>>>

// (f) a `PropsRef` subclass as the token — the same idiom `Ref` subclasses use for elements, and the one
// every service above depends on: `UserPropsRef` is what makes `inject(UserPropsRef)` typed.
const SubclassTokenModule = createModuleComponent<UserProps>(undefined, { token: UserPropsRef })
type _SubclassTokenModuleProps = Expect<
    Equals<typeof SubclassTokenModule, ComponentType<UserProps & { children?: ReactNode }>>
>

// The same with an adapter, so `T !== P` and the subclass names the ADAPTED type.
class UserVMRef extends PropsRef<UserVM> {}
const SubclassVMModule = createModuleComponent<UserProps, UserVM>(undefined, {
    use: userVMOf,
    adapter: userAdapter,
    token: UserVMRef,
})
type _SubclassVMModuleProps = Expect<
    Equals<typeof SubclassVMModule, ComponentType<UserProps & { children?: ReactNode }>>
>

// @ts-expect-error the adapter works WITHIN T now: its input is the bridged type, not the raw props.
const mismatchedAdapterModule = createModuleComponent<UserProps, UserVM>(undefined, { adapter: { create: (initial: UserProps) => initial, update: ({ current }) => current } })
void mismatchedAdapterModule

// @ts-expect-error a subclass of the WRONG bridged type is not this boundary's token.
const mismatchedSubclassTokenModule = createModuleComponent<UserProps>(undefined, { token: UserVMRef })
void mismatchedSubclassTokenModule

// THE OLD OPTION NAMES ARE DEAD. The bridge is still the second argument, but `propsAdapter`/`propsToken`
// are now `adapter`/`token`, and it has grown `use`.

// @ts-expect-error `propsToken` is now `token`.
const oldTokenModule = createModuleComponent<UserProps>(undefined, { propsToken: UserPropsRef })
void oldTokenModule

// @ts-expect-error `propsAdapter` is now `adapter`.
const oldAdapterModule = createModuleComponent<UserProps, UserVM>(undefined, { propsAdapter: userAdapter })
void oldAdapterModule

// The bridge is its OWN argument, never a key in the module config — that separation is what makes `use`
// static, and so safe under the rules of hooks.
// @ts-expect-error `props` is not a key of the module config.
const nestedBridgeModule = createModuleComponent<UserProps>({ props: { token: UserPropsRef } })
void nestedBridgeModule

// The structural guard, independent of how the object reaches the parameter.
type _BridgeHasUse = Expect<HasKey<PropsBridgeOptions<UserProps, UserVM>, "use">>
type _BridgeHasAdapter = Expect<HasKey<PropsBridgeOptions<UserProps, UserVM>, "adapter">>
type _BridgeHasToken = Expect<HasKey<PropsBridgeOptions<UserProps, UserVM>, "token">>
type _BridgeHasNoPropsAdapter = Expect<Not<HasKey<PropsBridgeOptions<UserProps, UserVM>, "propsAdapter">>>
type _BridgeHasNoPropsToken = Expect<Not<HasKey<PropsBridgeOptions<UserProps, UserVM>, "propsToken">>>

// The config is the ModuleProvider's own input plus the bridge, so `deps` and the module hooks are
// reachable from the same object the function form returns.
type _ModuleConfigHasNoProps = Expect<Not<HasKey<ModuleConfig, "props">>>
type _ModuleConfigHasDeps = Expect<HasKey<ModuleConfig, "deps">>
type _ModuleConfigHasProviders = Expect<HasKey<ModuleConfig, "providers">>
type _ModuleConfigHasNoChildren = Expect<Not<HasKey<ModuleConfig, "children">>>

// `use` is the P -> T step; the adapter is T -> T. That split is the whole shape of the new bridge.
type _UseTakesRawProps = Expect<
    Equals<Parameters<NonNullable<PropsBridgeOptions<UserProps, UserVM>["use"]>>[0], UserProps>
>
type _UseReturnsBridged = Expect<
    Equals<ReturnType<NonNullable<PropsBridgeOptions<UserProps, UserVM>["use"]>>, UserVM>
>

// And the hook keeps its own short names — the two shapes were never one alias.
type _UsePropsRefOptionsHasAdapter = Expect<HasKey<UsePropsRefOptions<UserProps, UserVM>, "adapter">>
type _UsePropsRefOptionsHasToken = Expect<HasKey<UsePropsRefOptions<UserProps, UserVM>, "token">>
type _OptionsShapesAreNotTheSameType = Expect<
    Not<Equals<PropsBridgeOptions<UserProps, UserVM>, UsePropsRefOptions<UserProps, UserVM>>>
>

// The module component's props are exactly `P & { children?: ReactNode }`.

// @ts-expect-error `userId` is required; a widening of the props to `any` would drop this error.
const moduleMissingRequiredProp = <UserModule limit={1} />
void moduleMissingRequiredProp

// @ts-expect-error `nope` is not a prop of the module.
const moduleUnknownProp = <UserModule userId="u-1" nope />
void moduleUnknownProp

// @ts-expect-error `userId` is a string.
const moduleMistypedProp = <UserModule userId={1} />
void moduleMistypedProp

// Typed parameter values, so the parameter unions stay pinned as well.
const createConfig: ModuleConfig = { id: "user", providers: [ApiClient] }
const createPropsOptions: PropsBridgeOptions<UserProps, UserVM> = {
    use: userVMOf,
    adapter: userAdapter,
    token: USER_VM,
}
const moduleParams: ModuleParams = { id: "scoped", providers: [ApiClient] }
const providerProps: ModuleProviderProps = { providers: [ApiClient], deps: [1, "a"], children: null }

// A module hook is handed the module's RESOLVER, not its container: the read door, with no `register` on
// it. A hook runs after the participant scan, so a registration made from inside one could never be
// collected — the argument type is what makes that unwritable rather than merely discouraged.
const moduleHook: ModuleHook = (resolver) => {
    type _ModuleHookResolver = Expect<Equals<typeof resolver, Resolver>>
    type _ModuleHookArgIsNotAny = Expect<Not<IsAny<typeof resolver>>>
    type _ModuleHookArgHasNoRegister = Expect<Not<HasKey<typeof resolver, "register">>>
    // @ts-expect-error the write door is not on a resolver.
    void resolver.register
    void resolver
}

const moduleHooks: ModuleHooks = {
    onModuleInit: moduleHook,
    onModuleDestroy: moduleHook,
}

// Params negative space — the modes are dead, so the keys that pinned them must stay rejected.
// ========================================
//
// `ModuleParams` is exactly id/providers/on* now. The old mode flags (`root`, `factory`) and the
// never-a-param `container` must all be absent, and these directives are the regression guard: if any
// key becomes assignable again, TypeScript reports its directive as unused and the file stops compiling.

type _ModuleParamsHasNoRoot = Expect<Not<HasKey<ModuleParams, "root">>>
type _ModuleParamsHasNoFactory = Expect<Not<HasKey<ModuleParams, "factory">>>
type _ModuleParamsHasNoContainer = Expect<Not<HasKey<ModuleParams, "container">>>

// @ts-expect-error `root` is not a module parameter — the composition root is created imperatively via new App().
const rootModuleParams: ModuleParams = { root: true, providers: [ApiClient] }
void rootModuleParams

// @ts-expect-error `factory` is not a module parameter — factory mode is gone.
const factoryModuleParams: ModuleParams = { factory: () => new Container(), providers: [ApiClient] }
void factoryModuleParams

// @ts-expect-error `container` is not a module parameter — one container = one module.
const containerModuleParams: ModuleParams = { container: new Container() }
void containerModuleParams

// Not merely an excess-property error on a fresh literal: it must fail alongside a known key too.
// @ts-expect-error `container` is not a module parameter, and a known key beside it does not help.
const containerWithKnownKey: ModuleParams = { id: "x", container: new Container() }
void containerWithKnownKey

// The context value is the module instance plus its rebuild — no loose `container` / `id` fields.
type _ModuleContextValueShape = Expect<Equals<ModuleContextValue, { module: Module; rebuild: () => void }>>

// Nameability of inferred types — TS2742
// ========================================
//
// Wrapping one of our hooks in an EXPORTED hook of its own is the ordinary consumer pattern, and it
// forces TypeScript to write our inferred type into the consumer's declaration output. If that type
// lives in a `dist` file the `exports` map does not publish, TypeScript cannot name it portably and
// reports TS2742 — which is what `usePropsRef`, `useModuleContext` and `makeTokenizer` all did until
// `UsePropsRefResult`, `ModuleContextValue` and `Tokenizer` were exported from `./types`.
//
// These wrappers are therefore UNANNOTATED on purpose: each one only compiles because the inferred type
// is nameable through the published surface. Un-exporting any of those types fails right here, e.g.
//
//   src/repro.tsx: error TS2742: The inferred type of 'useUserBridge' cannot be named without a
//   reference to '../node_modules/@remodulo/react/dist/react/hooks/usePropsRef.js'.
//
// (`@ts-expect-error` cannot pin these: it does suppress TS2742, but the "unused directive" check
// ignores declaration diagnostics and then flags the directive as unused.)

export function useUserBridge(props: UserProps) {
    return usePropsRef(props)
}

export function useCurrentModule() {
    return useModuleContext()
}

export function useOwnResolver() {
    return useResolver()
}

export function useOwnModule() {
    return useModule()
}

export const consumerToken = makeTokenizer("@consumer")

export type ModuleContextShape = {
    module: Module
    rebuild: () => void
}

export function useAppModuleContext(): ModuleContextShape {
    return useModuleContext()
}

export const scopedTokenizer: Tokenizer = makeTokenizer("@consumer.scoped")

// Components
// ========================================

function UserPanel(props: UserProps): ReactElement {
    // The manual bridge — the same inference `createModuleComponent` performs internally.
    const { ref, provider } = usePropsRef(props)

    type _PropsRefIsTyped = Expect<Equals<typeof ref, PropsRef<UserProps>>>
    type _PropsRefIsNotAny = Expect<Not<IsAny<typeof ref>>>
    type _PropsRefIsNotPropsRefAny = Expect<Not<Equals<typeof ref, PropsRef<any>>>>
    type _PropsRefProvider = Expect<Equals<typeof provider, ValueProvider<PropsRef<UserProps>>>>

    const current = ref.current
    type _PropsRefCurrent = Expect<Equals<typeof current, UserProps>>

    // @ts-expect-error `nope` is not on UserProps — this is the line that dies first if `PropsRef` widens.
    void current.nope

    const off = ref.onUpdate((next) => void next)
    type _PropsRefOff = Expect<Equals<typeof off, () => void>>

    // Adapter form. The HOOK keeps its two-type shape (source -> target); only the component boundary
    // splits that into `use` plus a same-type adapter, so this call needs a P -> T adapter of its own.
    const hookAdapter: PropsAdapter<UserProps, UserVM> = {
        create: (initial) => ({ id: initial.userId, take: initial.limit ?? 20 }),
        update: ({ current, next }) => {
            current.id = next.userId
            current.take = next.limit ?? 20
            return current
        },
    }
    const bridged = usePropsRef(props, { adapter: hookAdapter, token: USER_VM })
    type _AdaptedRef = Expect<Equals<typeof bridged.ref, PropsRef<UserVM>>>
    type _AdaptedProvider = Expect<Equals<typeof bridged.provider, ValueProvider<PropsRef<UserVM>>>>

    const vm = bridged.ref.current
    type _AdaptedCurrent = Expect<Equals<typeof vm, UserVM>>

    // The same result reached through a consumer-owned wrapper hook (see the TS2742 block above).
    type UserBridge = ReturnType<typeof useUserBridge>
    type _CustomHookResult = Expect<
        Equals<UserBridge, { ref: PropsRef<UserProps>; provider: ValueProvider<PropsRef<UserProps>> }>
    >
    type _CustomHookIsTheDeclaredResult = Expect<Equals<UserBridge, UsePropsRefResult<UserProps>>>

    return <div data-user={current.userId} data-take={vm.take} data-token={String(provider.provide)} onBlur={off} />
}

function UserView(): ReactElement {
    // Class token.
    const store = useResolve(UserStore)
    type _ResolveByClass = Expect<Equals<typeof store, UserStore>>
    type _ResolveByClassIsNotAny = Expect<Not<IsAny<typeof store>>>

    // Symbol token minted by `Token()`.
    const config = useResolve(CONFIG)
    type _ResolveBySymbol = Expect<Equals<typeof config, AppConfig>>
    type _ResolveBySymbolIsNotAny = Expect<Not<IsAny<typeof config>>>

    // The mode must not change the resolved type.
    const ownConfig = useResolveOptional(CONFIG, "self")
    type _ResolveOptionalBySymbol = Expect<Equals<typeof ownConfig, AppConfig | undefined>>
    type _UseResolveMode = Expect<Equals<Parameters<typeof useResolve>[1], ResolveMode | undefined>>
    type _UseResolveOptionalMode = Expect<Equals<Parameters<typeof useResolveOptional>[1], ResolveMode | undefined>>

    const maybeStore = useResolveOptional(UserStore)
    type _ResolveOptionalByClass = Expect<Equals<typeof maybeStore, UserStore | undefined>>

    const plugins = useResolveAll(PLUGIN)
    type _ResolveAllBySymbol = Expect<Equals<typeof plugins, Plugin[]>>
    type _ResolveAllIsNotAny = Expect<Not<IsAny<typeof plugins>>>

    const firstPlugin = plugins[0]
    type _ResolveAllIndexed = Expect<Equals<typeof firstPlugin, Plugin | undefined>>

    const registries = useResolveAll(PluginRegistry)
    type _ResolveAllByClass = Expect<Equals<typeof registries, PluginRegistry[]>>

    // The modes reach the hook surface too — same names, same default, same semantics as every other
    // multi read. None of them changes the resolved type.
    const ownPlugins = useResolveAll(PLUGIN, "self")
    type _ResolveAllOwnOnly = Expect<Equals<typeof ownPlugins, Plugin[]>>

    const nearestPlugins = useResolveAll(PLUGIN, ResolveAllMode.Nearest)
    type _ResolveAllNearest = Expect<Equals<typeof nearestPlugins, Plugin[]>>
    type _UseResolveAllMode = Expect<Equals<Parameters<typeof useResolveAll>[1], ResolveAllMode | undefined>>
    void nearestPlugins

    // @ts-expect-error a mode is a string, not an options object.
    void useResolveAll(PLUGIN, { chained: false })

    // The nearest module's canonical resolver, straight off context — the read door a component gets, and
    // the same object `inject(Resolver)` hands a service inside the same module.
    const resolver = useResolver()
    type _UseResolver = Expect<Equals<typeof resolver, Resolver>>
    type _UseResolverIsNotAny = Expect<Not<IsAny<typeof resolver>>>
    type _UseResolverTakesNothing = Expect<Equals<Parameters<typeof useResolver>, []>>

    // The module instance, straight off context — the same value `inject(Module)` reaches from inside.
    const ownModule = useModule()
    type _UseModule = Expect<Equals<typeof ownModule, Module>>
    type _UseModuleTakesNothing = Expect<Equals<Parameters<typeof useModule>, []>>

    const rebuild = useModuleRebuild()
    type _UseModuleRebuild = Expect<Equals<typeof rebuild, () => void>>

    const moduleContext = useModuleContext()
    type _UseModuleContext = Expect<Equals<typeof moduleContext, ModuleContextValue>>
    type _ModuleContextShape = Expect<Equals<ModuleContextValue, { module: Module; rebuild: () => void }>>
    type _ContextModuleIsModule = Expect<Equals<typeof moduleContext.module, Module>>

    // @ts-expect-error resolution is typed by the token — `nope` does not exist on UserStore.
    void store.nope

    return (
        <button type="button" onClick={rebuild}>
            {store.userId}
            {config.baseUrl}
            {ownConfig?.retries ?? 0}
            {maybeStore ? "y" : "n"}
            {firstPlugin?.name ?? ""}
            {registries.length}
            {ownModule.id}
            {String(resolver.isRegistered(UserStore))}
        </button>
    )
}

// `deps` — the module is rebuilt when any dependency identity changes.
function RebuildingModule({ children }: { children?: ReactNode }): ReactElement {
    const [version, setVersion] = useState(0)
    const [tenant, setTenant] = useState<string | null>(null)

    return (
        <ModuleProvider
            providers={[ApiClient, valueProvider]}
            deps={[version, tenant]}
            onModuleDestroy={moduleHook}
        >
            <button
                type="button"
                onClick={() => {
                    setVersion((current) => current + 1)
                    setTenant("acme")
                }}
            />
            {children}
        </ModuleProvider>
    )
}

// The boundary hook is internal; a consumer reaches its enclosing module straight off context.
function ManualModule({ children }: { children?: ReactNode }): ReactElement {
    const { module, rebuild } = useModuleContext()
    type _ContextModule = Expect<Equals<typeof module, Module>>
    type _ContextRebuild = Expect<Equals<typeof rebuild, () => void>>
    void rebuild

    return <div data-module={module.id}>{children}</div>
}

// Root boundary — created imperatively, outside the tree, then handed to <AppProvider>.
// ========================================

const composedApp = new App({ id: "app-root", providers: moduleProviders, onModuleInit: moduleHook })
type _CreateAppReturnsApp = Expect<Equals<typeof composedApp, App>>
type _CreateAppIsNotAny = Expect<Not<IsAny<typeof composedApp>>>

// An App IS a Module — that subtype relationship is what the whole tree gates on.
const appAsModule: Module = composedApp
void appAsModule

// ...but a bare Module is NOT an App. The App subclass carries a private brand, so it is nominal: the
// substrate cannot masquerade as the composition root, and <AppProvider> cannot be handed a scoped module.
declare const someBareModule: Module
// @ts-expect-error a bare Module is not assignable to App — App is nominal.
const moduleAsApp: App = someBareModule
void moduleAsApp

export function AppTree(): ReactElement {
    return (
        // The composition root: <AppProvider> inits (if needed), mounts and unmounts the owner-created App.
        <AppProvider app={composedApp}>
            {/* scoped (the only) mode: a fresh child container under the enclosing module. */}
            <ModuleProvider providers={[classProvider, existingProvider]} deps={["tenant-a"]}>
                <UserModule userId="u-1" limit={25}>
                    <UserPanel userId="u-1" limit={25} />
                    <UserView />
                </UserModule>

                <UserVMModule userId="u-2">
                    <UserView />
                </UserVMModule>

                <UserFactoryModule userId="u-3" />

                <FeaturedModule userId="u-4" />

                <SubclassTokenModule userId="u-5" />

                <SubclassVMModule userId="u-6" />

                <BareModule>
                    <RebuildingModule>
                        <ManualModule />
                    </RebuildingModule>
                </BareModule>
            </ModuleProvider>
        </AppProvider>
    )
}

// Module & App classes — construction and lifecycle signatures.
// ========================================

// The Module constructor takes `(parent, params)`; the parent is a Module or null, never optional.
const childModule = new Module(composedApp, { providers: [ApiClient] })
type _NewModuleIsModule = Expect<Equals<typeof childModule, Module>>
const childParent = childModule.parent
type _ModuleParentAccessor = Expect<Equals<typeof childParent, Module | null>>

const detachedModule = new Module(null, { id: "detached" })
void detachedModule

// @ts-expect-error the Module constructor requires the parent argument (Module | null).
const parentlessModule = new Module()
void parentlessModule

// @ts-expect-error a Container is not a Module — the parent slot takes a module or null.
const wrongParentModule = new Module(new Container())
void wrongParentModule

// `new App(...)` takes params only — the root has no parent slot; the subclass pins it to null.
const explicitApp = new App({ id: "app-2" })
type _NewAppIsApp = Expect<Equals<typeof explicitApp, App>>
void explicitApp

// @ts-expect-error App's constructor takes only params — there is no parent argument on the root.
const appWithParent = new App(composedApp, { id: "nope" })
void appWithParent

// Lifecycle phase signatures: init/mount/unmount are sync void, destroy is async.
const initResult: void = composedApp.init()
void initResult
const mountResult: void = composedApp.mount()
void mountResult
const unmountResult: void = composedApp.unmount()
void unmountResult
const destroyResult = composedApp.destroy()
type _DestroyReturnsPromise = Expect<Equals<typeof destroyResult, Promise<void>>>
void destroyResult

// `App extends Module`, so the deletion of the derived booleans reaches the root class too — an App is
// asked the same single question as any other module.
type _AppHasNoInitialized = Expect<Equals<HasKey<App, "initialized">, false>>
type _AppHasNoMounted = Expect<Equals<HasKey<App, "mounted">, false>>
type _AppHasNoDestroyed = Expect<Equals<HasKey<App, "destroyed">, false>>
type _AppHasNoClaimed = Expect<Equals<HasKey<App, "claimed">, false>>

// @ts-expect-error `initialized` is gone from App as well.
void composedApp.initialized
// @ts-expect-error and `mounted`.
void composedApp.mounted

const appStatus = composedApp.status
type _StatusIsTheAlphabet = Expect<
    Equals<
        typeof appStatus,
        | "created"
        | "initializing"
        | "initialized"
        | "mounted"
        | "unmounted"
        | "destroying"
        | "destroyed"
        | "failed"
    >
>
void appStatus

// ModuleProvider / AppProvider props — negative space.
// ========================================
//
// ModuleProvider is scoped-only: `container`, `root` and `factory` are all rejected. The trap this
// guards against: TypeScript's excess-property check against a union accepts any key present in ANY
// member, so a removed key has to be absent from the props type entirely.

const externalContainer: Container = new Container()

// @ts-expect-error `container` is not a module prop — one container = one module.
const containerElement = <ModuleProvider container={externalContainer} />
void containerElement

// @ts-expect-error still not a prop next to a valid one.
const containerWithProvidersElement = <ModuleProvider container={externalContainer} providers={[ApiClient]} />
void containerWithProvidersElement

// @ts-expect-error the JSX spread path must reject it too.
const spreadContainerElement = <ModuleProvider {...{ container: externalContainer }} />
void spreadContainerElement

// @ts-expect-error `root` is gone — the composition root is created via new App() + <AppProvider>, not a prop.
const rootPropElement = <ModuleProvider root providers={[ApiClient]} />
void rootPropElement

// @ts-expect-error `factory` is gone with factory mode.
const factoryPropElement = <ModuleProvider factory={() => new Container()} providers={[ApiClient]} />
void factoryPropElement

// AppProvider's props are exactly `{ app, children? }`, and `app` takes either an instance or a factory
// that builds one. The factory overload exists so the App can be constructed inside the provider's own
// hook state instead of at module scope.
type _AppProviderPropsShape = Expect<Equals<AppProviderProps, { app: App | (() => App); children?: ReactNode }>>

// Both accepted forms.
const instanceAppProvider = <AppProvider app={composedApp} />
void instanceAppProvider

const factoryAppProvider = <AppProvider app={() => new App({ providers: [ApiClient] })} />
void factoryAppProvider

// @ts-expect-error AppProvider's `app` must be an App — an arbitrary object is not one.
const badAppProvider = <AppProvider app={{}} />
void badAppProvider

// @ts-expect-error a bare Module is not an App — AppProvider only accepts the nominal composition root.
const bareModuleAppProvider = <AppProvider app={someBareModule} />
void bareModuleAppProvider

// @ts-expect-error a factory has to RETURN an App — one that returns a bare Module is not the overload.
const badFactoryAppProvider = <AppProvider app={() => someBareModule} />
void badFactoryAppProvider

// @ts-expect-error AppProvider requires an `app`.
const emptyAppProvider = <AppProvider />
void emptyAppProvider

// Container — the kernel, reached through the React entry.
// ========================================
//
// `Container` is `@remodulo/container`'s class, re-exported: the same class object, not a wrapper. A
// consumer that never imports the kernel by name still gets its whole read surface off `useResolver()`.
//
// `useContainer` is GONE from the published surface, and this is the pin that says so. It was the last
// public door onto the write half — `module.container` is `@internal`, the module hooks take a resolver,
// so a hook that leaked the container back through a component would have reopened the whole hole. The
// class itself stays exported: a consumer constructing or forking one owns it, which is a different thing
// from reaching into a module's.

type _NoUseContainer = Expect<Not<HasKey<ReactEntry, "useContainer">>>
type _UseResolverIsExported = Expect<Equals<HasKey<ReactEntry, "useResolver">, true>>

type _ContainerIsTheKernelClass = Expect<Equals<Container, import("@remodulo/container").Container>>

export function inspect(container: Container): string {
    const child = container.fork()
    type _Fork = Expect<Equals<typeof child, Container>>

    const parent = child.parent
    type _ContainerParent = Expect<Equals<typeof parent, Container | null>>

    // Constructed, never forked off a package-level singleton — and the parent is a constructor argument.
    const constructed = new Container(container)
    void constructed

    child.register([ApiClient, valueProvider])
    child.register({ provide: LOGGER, useFactory: () => new ConsoleLogger("") })

    const api = child.resolve(ApiClient)
    type _Resolve = Expect<Equals<typeof api, ApiClient>>

    // `construct` builds a class in the container's context without registering it or anything it reaches.
    const detached = child.construct(ApiClient)
    type _Construct = Expect<Equals<typeof detached, ApiClient>>

    const maybeConfig = child.resolveOptional(CONFIG, "self")
    type _ResolveOptional = Expect<Equals<typeof maybeConfig, AppConfig | undefined>>
    type _ContainerResolveMode = Expect<Equals<Parameters<Container["resolve"]>[1], ResolveMode | undefined>>

    const plugins = child.resolveAll(PLUGIN)
    type _ResolveAll = Expect<Equals<typeof plugins, Plugin[]>>

    // The same modes the other multi reads have — `self` is this container's own bindings alone, `nearest`
    // is the first contributing level, `chained` accumulates. Neither changes what a collection is made of.
    const ownPlugins = child.resolveAll(PLUGIN, "self")
    type _ResolveAllOwn = Expect<Equals<typeof ownPlugins, Plugin[]>>
    type _ContainerResolveAllMode = Expect<Equals<Parameters<Container["resolveAll"]>[1], ResolveAllMode | undefined>>

    const nearestPlugins = child.resolveAll(PLUGIN, ResolveAllMode.Nearest)
    type _ResolveAllNearest = Expect<Equals<typeof nearestPlugins, Plugin[]>>
    void nearestPlugins

    const registered = child.isRegistered(CONFIG, "self")
    type _IsRegistered = Expect<Equals<typeof registered, boolean>>
    type _ContainerIsRegisteredMode = Expect<
        Equals<Parameters<Container["isRegistered"]>[1], RegistrationMode | undefined>
    >

    const registeredByMember = child.isRegistered(CONFIG, RegistrationMode.Nearest)
    type _IsRegisteredByMember = Expect<Equals<typeof registeredByMember, boolean>>
    void registeredByMember

    // @ts-expect-error the `recursive` boolean is gone; a single read takes a mode.
    void child.isRegistered(CONFIG, false)

    // A registration question has no `chained`: there is nothing to accumulate about "is this token
    // registered". The member spelling is refused for the same reason as the literal.

    // @ts-expect-error `chained` is a collection width; `RegistrationMode` has no such member.
    void child.isRegistered(CONFIG, "chained")

    // @ts-expect-error `ResolveAllMode.Chained` is that same string — the enum it came from does not matter.
    void child.isRegistered(CONFIG, ResolveAllMode.Chained)

    // Registrations as data. The snapshot union is discriminated by `kind`, and both arms reach a
    // consumer through `@remodulo/react/types` — reading a container you got from a hook must not send
    // anyone to the kernel package for the type of what came back.
    const registrations = child.registrations()
    type _Registrations = Expect<Equals<typeof registrations, readonly EntrySnapshot[]>>

    const entries = child.entries(PLUGIN)
    type _Entries = Expect<Equals<typeof entries, readonly EntrySnapshot[]>>

    const entry = child.entry(CONFIG)
    type _Entry = Expect<Equals<typeof entry, EntrySnapshot | undefined>>

    let described = ""
    if (entry?.kind === "alias") {
        const alias: AliasEntrySnapshot = entry
        const target = alias.target
        type _AliasTarget = Expect<Equals<typeof target, InjectionToken>>
        described = String(target)
    } else if (entry) {
        const binding: BindingEntrySnapshot = entry
        const scope = binding.scope
        type _BindingScope = Expect<Equals<typeof scope, Scope>>
        type _BindingKind = Expect<Equals<typeof binding.kind, "class" | "value" | "factory">>
        described = scope
    }

    // Observation carries the producing entry's snapshot alongside the value, and the metadata bag is
    // whatever the registration attached — the container never reads it. The hook takes no token, so the
    // value arrives as `unknown` and the caller narrows it; the snapshot is the BINDING arm, because an
    // alias constructs nothing and so never reaches this event — no `kind` check to read `scope`.
    const detach = child.on("afterMaterialize", ({ instance, snapshot }) => {
        type _AfterMaterializeInstance = Expect<Equals<typeof instance, unknown>>
        type _AfterMaterializeSnapshot = Expect<Equals<typeof snapshot, BindingEntrySnapshot>>
        type _AfterMaterializeScope = Expect<Equals<typeof snapshot.scope, Scope>>

        const metadata = snapshot.metadata
        type _EntryMetadata = Expect<Equals<typeof metadata, EntryMetadata | undefined>>
        type _EntryMetadataShape = Expect<Equals<EntryMetadata, Readonly<Record<string, unknown>>>>
        void [instance, metadata]
    })
    type _OnDisposer = Expect<Equals<typeof detach, () => void>>
    detach()

    const fallbackConfig: AppConfig = { baseUrl: "", retries: 0 }
    const configOrValue = child.resolveOr(CONFIG, fallbackConfig)
    type _ResolveOrValue = Expect<Equals<typeof configOrValue, AppConfig>>

    // A thunk fallback must infer its RETURN type, not the function itself. The lazy overload is declared
    // before the eager one for exactly this reason — a thunk satisfies `fallback: F` too, so with the
    // eager overload first this used to infer `AppConfig | (() => null)` while the runtime called the
    // thunk and returned `null`.
    const configOrLazy = child.resolveOr(CONFIG, () => null)
    type _ResolveOrLazy = Expect<Equals<typeof configOrLazy, AppConfig | null>>

    return [
        String(api),
        String(detached),
        String(maybeConfig?.retries ?? 0),
        String(plugins.length),
        String(registered),
        String(registrations.length),
        String(entries.length),
        described,
        configOrValue.baseUrl,
        String(configOrLazy),
    ].join("|")
}

// @ts-expect-error there is no global container and no `createChildContainer` on the class.
void Container.createChildContainer()

// The container API is deliberately NOT widened for features: a feature is flattened by the module that
// receives it, and `register()` never sees one.

// @ts-expect-error a Feature is not a Provider — `register` takes providers alone.
void new Container().register(ROOT_FEATURE)

// @ts-expect-error and the array form refuses it for the same reason.
void new Container().register([ApiClient, ROOT_FEATURE])

// The two provider vocabularies are NOT the same type, and that is the boundary between the packages —
// though it is a much thinner boundary than 0.9's: React's forms are now DERIVED from the kernel's, and
// `lazy` is the only key it still adds, translated into kernel metadata before the container ever sees it.
type _ReactProviderIsNotKernelProvider = Expect<Not<Equals<Provider, KernelProvider>>>

// The frame, as a type. Nothing hands one to a consumer — `inject()` reads it — but it is on the
// published surface because a consumer writing its own reader has to be able to name the thing.
declare const frame: Frame
type _FrameContainer = Expect<Equals<typeof frame.container, Container>>
type _FrameRequest = Expect<Equals<typeof frame.request, RequestCache>>
type _FrameChain = Expect<Equals<typeof frame.chain, readonly InjectionToken[]>>
type _RequestCache = Expect<Equals<RequestCache, Map<object, unknown>>>

// The package boundary — ONE OWNER PER NAME.
// ========================================
//
// This section has now been ruled both ways, and the current ruling is the original one restored. 0.11.0
// re-exported the kernel's whole surface through this package on the argument that a peer dependency
// should never need a second import path. 0.12.0 reverses it: the kernel is already installed beside this
// package, so a consumer naming it directly costs nothing, while the re-export bought a second spelling
// for every kernel name — two places for a name to drift, and two places to look for its owner.
//
// The one-import-path rule is REVERSED. React re-exports nothing whose implementation lives in the
// kernel: `@remodulo/container` is a peer dependency, already installed beside this package, so a second
// spelling for every kernel name bought nothing but drift. The test is the SOURCE — if the kernel
// implements it, react does not export it — and it is pinned in both directions, because "absent from
// react" is only half a contract if the name is not reachable at all.
type KernelOwned = [
    "Container",
    "ContainerEvent",
    "RegistrationMode",
    "ResolveAllMode",
    "ResolveMode",
    "Scope",
    "Resolver",
    "inject",
    "injectAll",
    "injectContainer",
    "injectOptional",
    "injectResolver",
    "runInInjectionContext",
    "makeTokenizer",
    "describeToken",
    "CycleError",
    "RegistrationError",
    "ResolutionError",
    "InjectionContextError",
    "CYCLE_ERROR_CODE",
    "REGISTRATION_ERROR_CODE",
    "RESOLUTION_ERROR_CODE",
    "INJECTION_CONTEXT_ERROR_CODE",
]

type AbsentFromReact<Names extends readonly string[]> = {
    [I in keyof Names]: Names[I] extends string ? Not<HasKey<ReactEntry, Names[I]>> : never
}
type PresentOnKernel<Names extends readonly string[]> = {
    [I in keyof Names]: Names[I] extends string ? Equals<HasKey<ContainerEntry, Names[I]>, true> : never
}

type _KernelNamesAreNotReExported = Expect<Equals<AbsentFromReact<KernelOwned>[number], true>>
type _KernelNamesAreOnTheKernel = Expect<Equals<PresentOnKernel<KernelOwned>[number], true>>

// The global `Token` is gone from BOTH packages — a consumer mints its own namespaced tokenizer — and
// `TokenOptions` went with the duplicate guard it configured.
type _NoTokenOnReact = Expect<Not<HasKey<ReactEntry, "Token">>>
type _NoTokenOnKernel = Expect<Not<HasKey<ContainerEntry, "Token">>>

// The provider grammar is the ONE carve-out left: react's forms carry `lazy`, the kernel's do not. Same
// names, deliberately different types, which is why `KernelProvider` is the one thing this file still
// imports from the kernel.
type _ReactProviderIsNotTheKernels = Expect<Not<Equals<Provider, KernelProvider>>>

export function describeFailure(error: unknown): string {
    if (error instanceof CycleError) {
        // The cycle as data: the chain from the repeat that closes it, ending at that same token.
        const chain = error.chain
        type _CycleChain = Expect<Equals<typeof chain, readonly InjectionToken[]>>
        type _CycleCode = Expect<Equals<typeof error.code, typeof CYCLE_ERROR_CODE>>
        return `${error.code}:${chain.length}`
    }

    if (error instanceof ResolutionError) {
        const token = error.token
        type _ResolutionToken = Expect<Equals<typeof token, InjectionToken>>

        // The width of the read that failed, undefined where the read takes none.
        const mode = error.mode
        type _ResolutionMode = Expect<Equals<typeof mode, ResolveMode | ResolveAllMode | undefined>>
        type _ResolutionCode = Expect<
            Equals<typeof error.code, typeof RESOLUTION_ERROR_CODE | typeof CYCLE_ERROR_CODE>
        >
        return `${error.code}:${String(token)}:${mode ?? "-"}`
    }

    if (error instanceof RegistrationError) {
        // Undefined when the failing provider names no token at all.
        const token = error.token
        type _RegistrationToken = Expect<Equals<typeof token, InjectionToken | undefined>>
        type _RegistrationCode = Expect<Equals<typeof error.code, typeof REGISTRATION_ERROR_CODE>>
        return `${error.code}:${String(token)}`
    }

    if (error instanceof InjectionContextError) {
        // Which reader was called outside a frame.
        const caller = error.caller
        type _InjectionContextCaller = Expect<Equals<typeof caller, string>>
        type _InjectionContextCode = Expect<Equals<typeof error.code, typeof INJECTION_CONTEXT_ERROR_CODE>>
        return `${error.code}:${caller}`
    }

    return "unknown"
}

// The codes are string literals, not `string`: branching on them narrows.
type _RegistrationCodeLiteral = Expect<Equals<typeof REGISTRATION_ERROR_CODE, "REMODULO/REGISTRATION">>
type _ResolutionCodeLiteral = Expect<Equals<typeof RESOLUTION_ERROR_CODE, "REMODULO/RESOLUTION">>
type _CycleCodeLiteral = Expect<Equals<typeof CYCLE_ERROR_CODE, "REMODULO/CYCLE">>
type _InjectionContextCodeLiteral = Expect<Equals<typeof INJECTION_CONTEXT_ERROR_CODE, "REMODULO/INJECTION_CONTEXT">>

// withModule — the module/view combinator
// ========================================
//
// The module keeps its own props; the view contributes only its children slot. A view may declare
// `children` or nothing at all, and the constraint refuses everything else — an extra prop could never be
// passed, since the composition renders `<View>{children}</View>` and nothing more.

const ComposedShell = withModule(UserModule, ({ children }: { children?: ReactNode }) => <>{children}</>)
const ComposedBare = withModule(UserModule, () => null)

// Module props stay required and the children slot follows the view.
type _ComposedTakesModuleProps = Expect<Equals<ComponentProps<typeof ComposedShell>["userId"], string>>
type _ComposedTakesTheViewsChildren = Expect<
    Equals<ComponentProps<typeof ComposedShell>["children"], ReactNode | undefined>
>
type _ComposedBareHasNoChildren = Expect<Not<HasKey<ComponentProps<typeof ComposedBare>, "children">>>

const _composedUsage = (
    <ComposedShell userId="u1" limit={10}>
        <span />
    </ComposedShell>
)
const _composedBareUsage = <ComposedBare userId="u1" />

function withModuleRefusesAViewThatNeedsMore(): void {
    // @ts-expect-error an optional extra is still an extra — the view could never be given one.
    withModule(UserModule, (_: { children?: ReactNode; className?: string }) => null)

    // @ts-expect-error and a required one could never be satisfied.
    withModule(UserModule, (_: { children?: ReactNode; label: string }) => null)
}
void withModuleRefusesAViewThatNeedsMore

// The published surface, counted.
// ========================================
//
// Every exported VALUE is touched once, so a dropped export breaks here rather than in an app, and the
// length assertion means an ADDED export lands here too — as a deliberate decision rather than an
// accident. The type surface below gets the same treatment.

const publicValueSurface = [
    App,
    Module,
    AppProvider,
    ModuleProvider,
    createFeature,
    createModuleComponent,
    useResolver,
    useModule,
    useModuleContext,
    useModuleRebuild,
    useResolve,
    useResolveOptional,
    useResolveAll,
    usePropsRef,
    ModuleTraversal,
    PropsRef,
    Ref,
    RefMap,
    ModuleStatus,
    withModule,
] as const
// 31 -> 31 across the 0.10.0 kernel rework, which is a coincidence worth stating rather than evidence
// that nothing moved: SIX decorator exports left (`Inject`, `InjectAll`, `Injectable`, `Optional`,
// `decorate`, `LazyToken`) and six arrived — the five ambient readers (`inject`, `injectOptional`,
// `injectAll`, `injectContainer`, `runInInjectionContext`) plus `useModule`, which was internal until a
// consumer had a reason to hold the module instance rather than the whole context value. The count is
// the same number for a completely different surface, so the LIST is what carries the meaning here.
//
// Still 31 after `ModuleRegistry` became `ModuleTraversal`: a rename plus a return-type change, not an
// arrival or a departure. `ModuleLifecycle` never counted here either way — it was only ever reachable
// through the `./core` entry, and it is now off that too: the module registers it under a token this
// package does not export, so there is no longer a name to resolve it by from out here. It is still the
// fourth system provider in the container; what changed is that the key is unspellable.
// 31 -> 42 when the owner ruled that a peer dependency should never need a second import path.
// Still 42 after `useContainer` left and `useResolver` arrived: a one-for-one swap of the module's write
// door for its read one, so the LIST is again what carries the meaning and not the number.
// 19 -> 20 with `withModule`, the module/view combinator — react's own, and the first ARRIVAL since the
// reversal below rather than another departure.
// 42 -> 19 when that ruling was REVERSED: a peer dependency is already a direct dependency of the app, so
// re-exporting it bought a second spelling for every kernel name and nothing else. Everything whose
// implementation lives in `@remodulo/container` left in one go — the container and the mode enums, the
// five ambient readers plus `runInInjectionContext`, `Resolver`, the tokenizer, `describeToken`,
// `ContainerEvent`, and the four errors with their four codes. What remains is what this package OWNS,
// which is the point of the list: react's modules, its hooks, its primitives and its lifecycle alphabet.
type _PublicValueSurfaceSize = Expect<Equals<typeof publicValueSurface.length, 20>>

// The `./types` subpath must carry the entire public type surface. Every exported name is referenced
// once.
type PublicTypeSurface = [
    ClassProvider<UserStore>,
    ExistingProvider<Logger>,
    FactoryProvider<Logger>,
    Feature,
    Provider,
    ProviderInput,
    SelfClassProvider<FocusManager>,
    TokenClassProvider<UserStore>,
    ValueProvider<AppConfig>,
    ModuleParams,
    ModuleHook,
    ModuleHooks,
    ProviderLifecycle,
    PropsAdapter<UserProps, UserVM>,
    ModuleContextValue,
    ModuleProviderProps,
    AppProviderProps,
    ModuleConfig,
    PropsBridgeOptions<UserProps, UserVM>,
    UsePropsRefOptions<UserProps, UserVM>,
    UsePropsRefResult<UserVM>,
    // Spelled through the subpath on purpose: it also arrives from the ROOT as a value, so naming it bare
    // would pin the import block above rather than `./types`.
    import("@remodulo/react/types").ModuleStatus,
]
// 32 -> 39 -> 36 across 0.10.0. The seven arrivals were kernel types the React package re-exports rather
// than anything React grew: the registration/observation vocabulary a consumer meets the moment it reads a
// resolver it got from `useResolver()` (`EntrySnapshot` and its two arms `BindingEntrySnapshot` /
// `AliasEntrySnapshot`, the `EntryMetadata` bag they carry, and `Frame` / `RequestCache`), plus `Scope`,
// which was on the root entry alone in 0.9. The three departures are the whole of the declarative
// `inject` array's vocabulary — `FactoryDependency` and its two arms `OptionalFactoryDependency` /
// `MultiFactoryDependency` — which the ambient readers replaced without needing a type of their own.
//
// Still 36 after `ProviderSnapshot` was deleted: that type lived on the `./core` entry alone and was
// never nameable from `.` or `./types`, so its departure cannot show up in this count. The `./core`
// subpath is not pinned by this file at all — see the Module section above, where the deletion IS
// caught, through the member that used to return it.
// 36 -> 48 alongside the value surface, and for the same ruling.
// 48 -> 22 when that ruling was reversed: every kernel type went back behind
// `@remodulo/container/types`, where this file now imports it from. What is left is react's own — the
// seven provider forms it derives with `lazy`, the module and lifecycle vocabulary, the props bridge, the
// React-surface prop types, and `ModuleStatus`.
type _PublicTypeSurfaceSize = Expect<Equals<PublicTypeSurface["length"], 22>>

// The mode enums are the kernel's, on the kernel's subpath — react's `./types` no longer carries them,
// which is the reversal stated as three absences and three presences.
type _NoResolveModeOnReactTypes = Expect<Not<HasKey<ReactTypesEntry, "ResolveMode">>>
type _NoResolveAllModeOnReactTypes = Expect<Not<HasKey<ReactTypesEntry, "ResolveAllMode">>>
type _NoRegistrationModeOnReactTypes = Expect<Not<HasKey<ReactTypesEntry, "RegistrationMode">>>
type _ResolveModeOnKernelTypes = Expect<Equals<import("@remodulo/container/types").ResolveMode, ResolveMode>>
type _ResolveAllModeOnKernelTypes = Expect<
    Equals<import("@remodulo/container/types").ResolveAllMode, ResolveAllMode>
>
type _RegistrationModeOnKernelTypes = Expect<
    Equals<import("@remodulo/container/types").RegistrationMode, RegistrationMode>
>

// Keep the module-scope constants that exist only to be typechecked from being flagged as dead by a
// future `noUnusedLocals`, and give the file a single exported value to hang everything on.
export const consumerSurface = {
    abstractCtor,
    createConfig,
    createPropsOptions,
    moduleHooks,
    moduleParams,
    providerProps,
    transientProvider,
    requestProvider,
    valueSurfaceSize: publicValueSurface.length,
    DUPLICATE_PLUGIN,
} as const
