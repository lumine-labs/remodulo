import { describeToken } from "@remodulo/container"
import type { InjectionToken } from "@remodulo/container/types"
import type { ModuleStatus } from "./module-lifecycle.types.js"

// Errors
// ========================================

export function wrongStatus(signal: string, status: ModuleStatus, expected: readonly ModuleStatus[]): Error {
    const accepted = expected.map((state) => `"${state}"`).join(" or ")
    return new Error(`Cannot ${signal}() a module whose status is "${status}" — ${signal}() accepts ${accepted}.`)
}

export function mountOntoDeadParent(status: ModuleStatus): string {
    return `Cannot mount a module onto a ${status} parent — that branch is spent, so the child could never go live under it. Mount it under a live parent, or rebuild the branch first.`
}

export function unarmedResolution(token: InjectionToken, status: ModuleStatus): Error {
    return new Error(
        `Cannot resolve ${describeToken(token)} from a module whose status is "${status}" — a module answers reads only once init() has armed it, and never after it failed or was destroyed.`
    )
}

export function unhealthyTree(token: InjectionToken, ancestorId: string, ancestorStatus: ModuleStatus): Error {
    return new Error(
        `Cannot resolve ${describeToken(token)} from an unhealthy module tree — ${ancestorStatus} branch: ${ancestorId}. Every module under a ${ancestorStatus} ancestor refuses reads, whichever module owns the binding.`
    )
}
