// Container
// ========================================

// The kernel's whole type surface, re-exported: a consumer that only wants types never reaches for
// `@remodulo/container/types`. The provider forms are the one carve-out — this package derives its own
// (`Lazy<P>`, see the Providers block below).

export type {
    AbstractConstructor,
    AfterMaterializeEvent,
    AfterResolutionEvent,
    AliasEntrySnapshot,
    BeforeMaterializeEvent,
    BeforeResolutionEvent,
    BindingEntrySnapshot,
    ClassKey,
    Constructor,
    ContainerEvent,
    ContainerEventListener,
    ContainerEventPayload,
    EntryMetadata,
    EntrySnapshot,
    Frame,
    InjectionToken,
    RegistrationMode,
    RequestCache,
    ResolveAllMode,
    ResolveMode,
    Scope,
} from "@remodulo/container/types"

// Errors
// ========================================

export type {
    CycleError,
    InjectionContextError,
    RegistrationError,
    ResolutionError,
} from "@remodulo/container/types"

// Providers
// ========================================

export type {
    ClassProvider,
    ExistingProvider,
    FactoryProvider,
    Provider,
    SelfClassProvider,
    TokenClassProvider,
    ValueProvider,
} from "./core/provider.types.js"

// Module
// ========================================

export type { ModuleParams } from "./core/module.types.js"

// Features
// ========================================

export type { Feature } from "./core/feature.js"
export type { ProviderInput } from "./core/provider.types.js"

// Lifecycle
// ========================================

export type {
    ModuleHook,
    ModuleHooks,
    ProviderLifecycle,
} from "./core/module-lifecycle.types.js"

export type { ModuleStatus } from "./core/module-lifecycle.types.js"

// System providers
// ========================================

export type { PropsAdapter } from "./primitives/props-ref.js"

// React surface
// ========================================

export type { ModuleContextValue } from "./react/ModuleContext.js"
export type { ModuleProviderProps } from "./react/ModuleProvider.js"
export type { AppProviderProps } from "./react/AppProvider.js"
export type {
    ModuleConfig,
    PropsBridgeOptions,
} from "./react/createModuleComponent.js"
export type { UsePropsRefOptions, UsePropsRefResult } from "./react/usePropsRef.js"

// Tokens
// ========================================

export type { TokenOptions, Tokenizer } from "@remodulo/container/types"
