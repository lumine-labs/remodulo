import type { InjectionToken, ResolveAllMode, ResolveMode } from "./container.types.js"
import type { ProviderRegistrationMode } from "./providers.types.js"
import { describeToken } from "./utils/describeToken.js"

// Error codes
// ========================================

export const REGISTRATION_ERROR_CODE = "REMODULO/REGISTRATION"
export const RESOLUTION_ERROR_CODE = "REMODULO/RESOLUTION"
export const CYCLE_ERROR_CODE = "REMODULO/CYCLE"

// Error classes
// ========================================

/** Every registration-time refusal. `token` is undefined when the failing provider names none. */
export class RegistrationError extends Error {
    readonly code = REGISTRATION_ERROR_CODE
    readonly token: InjectionToken | undefined

    constructor(message: string, token?: InjectionToken) {
        super(message)
        this.name = "RegistrationError"
        this.token = token
    }
}

/** Every read-time refusal. `mode` is the width of the read that failed, undefined where it takes none. */
export class ResolutionError extends Error {
    readonly code: typeof RESOLUTION_ERROR_CODE | typeof CYCLE_ERROR_CODE = RESOLUTION_ERROR_CODE
    readonly token: InjectionToken
    readonly mode: ResolveMode | ResolveAllMode | undefined

    constructor(message: string, token: InjectionToken, mode?: ResolveMode | ResolveAllMode) {
        super(message)
        this.name = "ResolutionError"
        this.token = token
        this.mode = mode
    }
}

/** The cycle as data: the chain from the repeat that closes it, ending at that same token. */
export class CycleError extends ResolutionError {
    override readonly code = CYCLE_ERROR_CODE
    readonly chain: readonly InjectionToken[]

    constructor(message: string, chain: readonly InjectionToken[]) {
        super(message, chain[chain.length - 1])
        this.name = "CycleError"
        this.chain = Object.freeze([...chain])
    }
}

// Registration Errors
// ========================================

export function invalidProvider(provider: unknown): string {
    return `${providerLabel(provider)} has no recognised form — expected a class, or an object with one of useClass, useValue, useFactory or useExisting.`
}

export function mixedImplementationKeys(provider: unknown, keys: readonly string[]): string {
    return `${providerLabel(provider)} mixes ${keys.length} implementation keys (${keys.join(", ")}) — a provider declares exactly one of useClass, useValue, useFactory or useExisting. Note that an explicit \`undefined\` still counts as declared.`
}

export function missingProvide(useKey: string): string {
    return `Provider with ${useKey} requires \`provide\` — only useClass may register under its own token, because a class is one. Give this provider an explicit token.`
}

export function alreadyRegistered(token: InjectionToken): string {
    return `Token ${describeToken(token)} is already registered on this container. One token, one registration — mark every provider for it \`multi: true\` to make it a collection, or give each provider its own token.`
}

export function modeConflict(
    token: InjectionToken,
    existing: ProviderRegistrationMode,
    incoming: ProviderRegistrationMode,
    inherited: boolean
): string {
    const where = inherited ? "on an ancestor container" : "on this container"
    const fix =
        incoming === "multi"
            ? "Drop `multi: true` here, or add it to the other registration."
            : "Add `multi: true` here, or drop it from the other registration."

    return `Token ${describeToken(token)} is already ${describeMode(existing)} ${where}, and this provider registers it as ${describeMode(incoming)}. A token is one or the other for the whole container chain — that is what lets \`resolve\` and \`resolveAll\` agree about what it means. ${fix}`
}

export function multiRegistered(token: InjectionToken): string {
    return `Token ${describeToken(token)} is a multi-provider collection — several providers contribute to it, so there is no single value to read. Use \`resolveAll\`.`
}

export function singleRegistration(token: InjectionToken): string {
    return `Token ${describeToken(token)} is a single registration, not a multi-provider collection — \`resolveAll\` would hide that behind a one-element array. Use \`resolve\`, or mark every provider for it \`multi: true\`.`
}

export function multiNeedsProvide(): string {
    return "Provider with `multi: true` requires `provide` — the class shorthand registers under the class itself, and a collection whose only member is that class is just the class. Name the collection's token explicitly."
}

export function aliasTargetsMulti(alias: InjectionToken, target: InjectionToken): string {
    return `Provider for ${describeToken(alias)} cannot alias ${describeToken(target)}: ${describeToken(target)} is a multi-provider collection, and \`useExisting\` is a single-value read of its target — it redirects to exactly the read \`resolve\` performs, and \`resolve\` refuses a collection. Alias a single registration, or contribute to the collection with \`{ provide: ${describeToken(target)}, ..., multi: true }\`.`
}

// Construction Errors
// ========================================

export function circularDependency(chain: readonly InjectionToken[]): string {
    return `Circular dependency found: ${chain.map(describeToken).join(" -> ")}`
}

// Resolution Errors
// ========================================

export function notRegistered(token: InjectionToken, mode: ResolveMode): string {
    return mode === "self"
        ? `Token ${describeToken(token)} is not registered in this container (mode "self" reads its own bindings only). Use "nearest" to search its ancestors too.`
        : `Token ${describeToken(token)} is not registered in this container or any ancestor.`
}

// Helpers
// ========================================

export function providerToken(provider: unknown): InjectionToken | undefined {
    const candidate = provider as { provide?: InjectionToken } | null | undefined
    return candidate !== null && typeof candidate === "object" ? candidate.provide : undefined
}

function providerLabel(provider: unknown): string {
    const provide = providerToken(provider)
    if (provide !== undefined) return `Provider for ${describeToken(provide)}`
    if (provider === null || typeof provider !== "object") return `Provider ${String(provider)}`
    return "Provider"
}

function describeMode(mode: ProviderRegistrationMode): string {
    return mode === "multi" ? "a multi-provider collection" : "a single registration"
}
