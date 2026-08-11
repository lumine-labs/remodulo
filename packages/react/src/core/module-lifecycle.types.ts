import type { Resolver } from "@remodulo/container"
import { Enum } from "@luminelabs/toolkit"

// Status alphabets
// ========================================

export const ModuleStatus = Enum({
    Created: "created",
    Initializing: "initializing",
    Initialized: "initialized",
    Mounted: "mounted",
    Unmounted: "unmounted",
    Destroying: "destroying",
    Destroyed: "destroyed",
    Failed: "failed",
})
export type ModuleStatus = Enum<typeof ModuleStatus>

export const ParticipantStatus = Enum({
    Registered: "registered",
    Initialized: "initialized",
    Mounted: "mounted",
    Unmounted: "unmounted",
    Destroyed: "destroyed",
    Failed: "failed",
})

export type ParticipantStatus = Enum<typeof ParticipantStatus>

export type Participant = {
    readonly instance: ProviderLifecycle
    status: ParticipantStatus
}

// Lifecycle hooks for providers
// ========================================

export type ProviderLifecycle = {
    onModuleInit?(): unknown
    onModuleMount?(): unknown
    onModuleUnmount?(): unknown
    onModuleDestroy?(): unknown
}

// Lifecycle hooks for module
// ========================================

export type ModuleHook = (resolver: Resolver) => unknown

export type ModuleHooks = {
    onModuleInit?: ModuleHook
    onModuleMount?: ModuleHook
    onModuleUnmount?: ModuleHook
    onModuleDestroy?: ModuleHook
}
