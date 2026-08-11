// This package's own type surface. The kernel's types — tokens, snapshots, events, errors, the mode
// enums — are `@remodulo/container/types`, imported from the peer directly. What lives here is what this
// package owns, starting with the provider forms it derives (`Lazy<P>`).

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
