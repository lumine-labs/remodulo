// Container
// ========================================

// The kernel is a peer dependency, so its whole surface is re-exported here: a consumer of this package
// never needs a second import path for a kernel tool. One family is deliberately NOT re-exported, because
// this package owns its own: the provider forms on `./types`, which carry `lazy`.

export {
    Container,
    ContainerEvent,
    RegistrationMode,
    ResolveAllMode,
    ResolveMode,
    Scope,
} from "@remodulo/container"

// Injection
// ========================================

export {
    inject,
    injectAll,
    injectContainer,
    injectOptional,
    injectResolver,
    runInInjectionContext,
} from "@remodulo/container"

// Errors
// ========================================

export {
    CYCLE_ERROR_CODE,
    CycleError,
    INJECTION_CONTEXT_ERROR_CODE,
    InjectionContextError,
    REGISTRATION_ERROR_CODE,
    RESOLUTION_ERROR_CODE,
    RegistrationError,
    ResolutionError,
} from "@remodulo/container"

// Modules
// ========================================

export { App, Module } from "./core/module.js"
export { ModuleStatus } from "./core/module-lifecycle.types.js"
export { AppProvider } from "./react/AppProvider.js"
export { ModuleProvider } from "./react/ModuleProvider.js"
export { createModuleComponent } from "./react/createModuleComponent.js"

// Features
// ========================================

export { createFeature } from "./core/feature.js"

// Hooks
// ========================================

export { useModule, useModuleContext, useModuleRebuild, useResolver } from "./react/useModuleContext.js"
export { useResolve, useResolveOptional } from "./react/useResolve.js"
export { useResolveAll } from "./react/useResolveAll.js"
export { usePropsRef } from "./react/usePropsRef.js"

// System providers
// ========================================

export { ModuleTraversal } from "./core/module-traversal.js"
export { Resolver } from "@remodulo/container"
export { PropsRef } from "./primitives/props-ref.js"

// Refs
// ========================================

export { Ref, RefMap } from "./primitives/ref.js"

// Tokens
// ========================================

export { Token, describeToken, makeTokenizer } from "@remodulo/container"

// Types
// ========================================

export type * from "./types.js"
