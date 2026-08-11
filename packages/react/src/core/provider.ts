import type { Container } from "@remodulo/container"
import type { EntryMetadata, InjectionToken, Provider as KernelProvider } from "@remodulo/container/types"

import { lazyMismatch } from "./provider.errors.js"
import type { Provider, ProviderInput } from "./provider.types.js"
import { type Feature, isFeature } from "./feature.js"

// Metadata channel
// ========================================

export const LAZY_METADATA_KEY = "lazy"

export function isLazyMetadata(metadata: EntryMetadata | undefined): boolean {
    return metadata?.[LAZY_METADATA_KEY] === true
}

// Registration
// ========================================

export function registerProviders(container: Container, providers: readonly Provider[]): void {
    const declaredLazy = new Map<InjectionToken, boolean>()

    for (const provider of providers) {
        container.register(toKernelProvider(provider))
        claimLazy(declaredLazy, provider)
    }
}

function toKernelProvider(provider: Provider): KernelProvider {
    if (typeof provider !== "object" || provider === null) return provider as KernelProvider

    if (!("lazy" in provider)) return provider as KernelProvider

    const { lazy, ...rest } = provider as unknown as Record<string, unknown>

    if (lazy === true) {
        const declared = rest.metadata as EntryMetadata | undefined
        rest.metadata = { ...declared, [LAZY_METADATA_KEY]: true } satisfies EntryMetadata
    }

    return rest as unknown as KernelProvider
}

/** Settle a collection's laziness against everything already registered for the token in this pass. */
function claimLazy(declaredLazy: Map<InjectionToken, boolean>, provider: Provider): void {
    if (typeof provider !== "object" || provider === null) return
    if (provider.multi !== true) return

    const token = provider.provide
    if (token === undefined) return

    const lazy = "lazy" in provider && provider.lazy === true
    const declared = declaredLazy.get(token)
    if (declared !== undefined && declared !== lazy) {
        throw new Error(lazyMismatch(token, declared, lazy))
    }
    declaredLazy.set(token, lazy)
}

// Flatten
// ========================================

export function flattenProviders(inputs: readonly ProviderInput[]): Provider[] {
    const flat: Provider[] = []
    const visited = new Set<Feature>()

    const walk = (items: readonly ProviderInput[]): void => {
        for (const item of items) {
            if (!isFeature(item)) {
                flat.push(item)
                continue
            }

            if (visited.has(item)) continue
            visited.add(item)
            walk(item.providers)
        }
    }

    walk(inputs)

    return flat
}
