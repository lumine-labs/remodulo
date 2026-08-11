import { describeToken } from "@remodulo/container"
import type { InjectionToken } from "@remodulo/container/types"

// Errors
// ========================================

export function lazyMismatch(token: InjectionToken, declared: boolean, incoming: boolean): string {
    return `Provider for ${describeToken(token)} declares \`lazy: ${incoming}\` while the collection already registered for that token is \`lazy: ${declared}\`. A collection is constructed whole — one \`resolveAll\` in the owner's eager pass — so a partly-lazy one has no coherent meaning. Make every useClass, useFactory, useValue and useExisting member agree.`
}
