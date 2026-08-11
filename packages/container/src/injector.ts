import type { Container } from "./container.js"
import type { InjectionToken, ResolveAllMode, ResolveMode } from "./container.types.js"
import type { Frame } from "./frame.types.js"
import { Resolver } from "./resolver.js"
import { activeFrame, runInFrame } from "./frame.js"
import { InjectionContextError, notInInjectionContext } from "./injector.errors.js"

function requireFrame(caller: string, token?: InjectionToken): Frame {
    const frame = activeFrame()
    if (frame === null) throw new InjectionContextError(notInInjectionContext(caller, token), caller)
    return frame
}

// Injection
// ========================================

/** One value from the declaring container, required. */
export function inject<T>(token: InjectionToken<T>, mode: ResolveMode = "nearest"): T {
    return requireFrame("inject", token).container.resolve<T>(token, mode)
}

/** One value from the declaring container, `undefined` when nothing is registered. */
export function injectOptional<T>(token: InjectionToken<T>, mode: ResolveMode = "nearest"): T | undefined {
    return requireFrame("injectOptional", token).container.resolveOptional<T>(token, mode)
}

/** A collection from the declaring container. */
export function injectAll<T>(token: InjectionToken<T>, mode: ResolveAllMode = "chained"): T[] {
    return requireFrame("injectAll", token).container.resolveAll<T>(token, mode)
}

/** The declaring container itself, for the rare consumer that needs the container and not a value. */
export function injectContainer(): Container {
    return requireFrame("injectContainer").container
}

/** The declaring container's canonical resolver: the reads and `on`, without the registration door. */
export function injectResolver(): Resolver {
    return Resolver.for(requireFrame("injectResolver").container)
}

/**
 * Open a frame anchored at `container` and run `run` inside it, so bare `inject` works outside
 * construction. A frame already in progress lends its request cache and chain rather than being replaced.
 */
export function runInInjectionContext<T>(container: Container, run: () => T): T {
    const outer = activeFrame()
    const frame: Frame = { container, request: outer?.request ?? new Map(), chain: outer?.chain ?? [] }
    return runInFrame(frame, run)
}
