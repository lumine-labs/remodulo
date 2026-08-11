import type {
    ContainerEvent,
    ContainerEventListener,
    EntrySnapshot,
    InjectionToken,
    RegistrationMode,
    ResolveAllMode,
    ResolveMode,
} from "./container.types.js"
import type { Container } from "./container.js"

// Resolver
// ========================================

export class Resolver {
    // Container -> its canonical resolver. Weak, so viewing a container does not keep it alive.
    static readonly #cache = new WeakMap<Container, Resolver>()

    /** The one resolver for `container`, and the only way to obtain one: same container, same instance. */
    static for(container: Container): Resolver {
        const cached = Resolver.#cache.get(container)
        if (cached) return cached

        const resolver = new Resolver(container)
        Resolver.#cache.set(container, resolver)
        return resolver
    }

    readonly #container: Container

    private constructor(container: Container) {
        this.#container = container
    }

    // Resolution
    // ========================================

    resolve<T>(token: InjectionToken<T>, mode: ResolveMode = "nearest"): T {
        return this.#container.resolve(token, mode)
    }

    resolveOptional<T>(token: InjectionToken<T>, mode: ResolveMode = "nearest"): T | undefined {
        return this.#container.resolveOptional(token, mode)
    }

    resolveOr<T, F>(token: InjectionToken<T>, fallback: () => F, mode?: ResolveMode): T | F
    resolveOr<T, F>(token: InjectionToken<T>, fallback: F, mode?: ResolveMode): T | F
    resolveOr<T, F>(token: InjectionToken<T>, fallback: F | (() => F), mode: ResolveMode = "nearest"): T | F {
        return this.#container.resolveOr(token, fallback as F, mode)
    }

    resolveAll<T>(token: InjectionToken<T>, mode: ResolveAllMode = "chained"): T[] {
        return this.#container.resolveAll(token, mode)
    }

    isRegistered(token: InjectionToken, mode: RegistrationMode = "nearest"): boolean {
        return this.#container.isRegistered(token, mode)
    }

    // Lookups
    // ========================================

    registrations(): readonly EntrySnapshot[] {
        return this.#container.registrations()
    }

    entry(token: InjectionToken): EntrySnapshot | undefined {
        return this.#container.entry(token)
    }

    entries(token: InjectionToken): readonly EntrySnapshot[] {
        return this.#container.entries(token)
    }

    // Observation
    // ========================================

    on<E extends ContainerEvent>(event: E, listener: ContainerEventListener<E>): () => void {
        return this.#container.on(event, listener)
    }
}
