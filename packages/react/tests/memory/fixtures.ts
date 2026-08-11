import { Scope, inject } from "@remodulo/container"
import type { Provider } from "../../src/core/provider.types.js"
import type { Module } from "../../src/core/module.js"
import { PropsRef } from "../../src/primitives/props-ref.js"
import type { LeakTracker } from "./gc.js"

// Fixtures
// ========================================
//
// One provider set exercising every shape that participates in retention: an eagerly built singleton, a
// lazy singleton (built only when somebody resolves it), an alias (no binding of its own, so it never
// materializes), a transient (never enters the lifecycle instance list) and a PropsRef registered by
// value the way `usePropsRef` registers one. Payloads are large enough that a retained generation moves
// `heapUsed`.

export const EAGER = Symbol("memory:eager")
export const LAZY = Symbol("memory:lazy")
export const ALIAS = Symbol("memory:alias")
export const TRANSIENT = Symbol("memory:transient")

// Sized so a fully-retained core run (5000 tracked instances) would add ~160MB — far past the heap
// thresholds — while a healthy run allocates and frees it with no standing cost.
const PAYLOAD_BYTES = 32 * 1024

export class EagerService {
    readonly payload = new Uint8Array(PAYLOAD_BYTES)
    peer: unknown = null

    onModuleInit(): void {}
    onModuleMount(): void {}
    onModuleUnmount(): void {}
    onModuleDestroy(): void {}
}

export class LazyService {
    readonly payload = new Uint8Array(PAYLOAD_BYTES)

    constructor(readonly eager: EagerService) {}

    onModuleInit(): void {}
    onModuleDestroy(): void {}
}

export class TransientThing {
    readonly payload = new Uint8Array(1024)
}

/**
 * A fresh provider set per module generation. Tokens are module-level constants on purpose: a stable token
 * that leaked its instances would show up as a growing survivor count, which a fresh-symbol-per-iteration
 * fixture would hide.
 *
 * `propsRef`: omit for a fresh tracked one, pass an instance to share a longer-lived ref across
 * generations, pass `null` to register none — `createModuleComponent` auto-registers its own under the
 * same token and one container takes one registration per token.
 */
export function makeProviders(tracker: LeakTracker, propsRef?: PropsRef | null): Provider[] {
    const props: Provider[] =
        propsRef === null
            ? []
            : [{ provide: PropsRef, useValue: propsRef ?? tracker.track("PropsRef", new PropsRef({ props: { n: 0 } })) }]

    return [
        {
            provide: EAGER,
            useFactory: () => tracker.track("EagerService", new EagerService()),
        },
        {
            provide: LAZY,
            useFactory: () => tracker.track("LazyService", new LazyService(inject<EagerService>(EAGER))),
            lazy: true,
        },
        { provide: ALIAS, useExisting: EAGER },
        {
            provide: TRANSIENT,
            useFactory: () => new TransientThing(),
            scope: Scope.Transient,
        },
        ...props,
    ]
}

/**
 * The owner's scenario, middle two steps: resolve the module's providers, then trigger the lazy one. Also
 * takes a PropsRef subscription and drives an update through it, so the subscriber closure — which captures
 * this generation's instances — is live at the moment the module is torn down.
 */
export function exercise(tracker: LeakTracker, module: Module, propsUpdate = 1): void {
    const container = module.container

    const eager = container.resolve<EagerService>(EAGER)
    const alias = container.resolve<EagerService>(ALIAS)
    container.resolve<TransientThing>(TRANSIENT)

    // Lazy construction happens here and nowhere earlier.
    const lazy = container.resolve<LazyService>(LAZY)
    eager.peer = lazy

    const props = container.resolve<PropsRef<{ n: number }>>(PropsRef)

    const subscriber = tracker.track("Subscriber", (next: { n: number }) => {
        // Captures this generation's instances — a retained subscriber retains the whole graph.
        eager.peer = next.n === -1 ? alias : lazy
    })

    props.onUpdate(subscriber)
    props.update({ n: propsUpdate })
}
