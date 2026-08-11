import type { ProviderInput } from "./provider.types.js"

// Feature
// ========================================

const FEATURE = Symbol("@remodulo/react:feature")

export type Feature = {
    readonly [FEATURE]: true
    readonly name?: string
    readonly providers: readonly ProviderInput[]
}

export function createFeature({ name, providers }: { name?: string; providers: readonly ProviderInput[] }): Feature {
    return Object.freeze<Feature>({
        [FEATURE]: true,
        ...(name !== undefined && { name }),
        providers: Object.freeze([...providers]),
    })
}

export function isFeature(input: ProviderInput): input is Feature {
    return typeof input === "object" && input !== null && FEATURE in input
}
