// This package exports what this package OWNS. `@remodulo/container` is a peer dependency, so everything
// the kernel implements — the container, the injection readers, the tokenizer, the errors, the resolver —
// is imported from there directly rather than through a second door here.

// Modules
// ========================================

export { App, Module } from "./core/module.js"
export { ModuleStatus } from "./core/module-lifecycle.types.js"
export { AppProvider } from "./react/AppProvider.js"
export { ModuleProvider } from "./react/ModuleProvider.js"
export { createModuleComponent } from "./react/createModuleComponent.js"
export { withModule } from "./react/withModule.js"

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
export { PropsRef } from "./primitives/props-ref.js"

// Refs
// ========================================

export { Ref, RefMap } from "./primitives/ref.js"

// Types
// ========================================

export type * from "./types.js"
