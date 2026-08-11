import { Enum } from "./utils/Enum.js"
import type { Container } from "./container.js"
import type { RequestCache } from "./frame.types.js"
import type { EntryMetadata } from "./providers.types.js"

// Tokens
// ========================================

export type Constructor<T = unknown> = new (...args: any[]) => T
export type AbstractConstructor<T = unknown> = abstract new (...args: any[]) => T
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export type ClassKey<T = unknown> = Function & { prototype: NoInfer<T> }

export type InjectionToken<T = unknown> = string | symbol | Constructor<T> | AbstractConstructor<T> | ClassKey<T>

// Scope
// ========================================

/**
 * `singleton` - one instance per container that declares it. The only scope that can carry lifecycle:
 *               one instance, one death point.
 *
 * `transient` - a fresh instance per resolve. Never carries lifecycle.
 *
 * `request`   - one instance per resolution graph: shared by everything reached from a single
 *               `resolve`/`resolveAll`, fresh for the next one. Never carries lifecycle.
 */
export const Scope = Enum({
    Singleton: "singleton",
    Transient: "transient",
    Request: "request",
})
export type Scope = Enum<typeof Scope>

// Read modes
// ========================================

/**
 * How far a SINGLE read (`container.resolve`) looks for its one binding.
 *
 * `self`    - this container's own bindings only; an inherited registration is a miss.
 *
 * `nearest` - the first binding at or above this container.
 *
 * There is no `chained` here: a single read produces one value, and one value cannot be accumulated.
 */
export const ResolveMode = Enum({
    Self: "self",
    Nearest: "nearest",
})
export type ResolveMode = Enum<typeof ResolveMode>

/**
 * How far a COLLECTION read (`container.resolveAll`) reaches.
 *
 * `self`    - this container's own bindings only; `[]` when it declares none.
 *
 * `nearest` - the first container at or above this one that contributes. That container's bindings
 *             ALONE, never the chain above it.
 *
 * `chained` - every level accumulated, nearest first.
 */
export const ResolveAllMode = Enum({
    Self: "self",
    Nearest: "nearest",
    Chained: "chained",
})
export type ResolveAllMode = Enum<typeof ResolveAllMode>

/**
 * How far a REGISTRATION question (`container.isRegistered`) looks.
 *
 * `self`    - this container's own bindings only; an inherited registration is a miss.
 *
 * `nearest` - the first binding at or above this container.
 */
export const RegistrationMode = Enum({
    Self: "self",
    Nearest: "nearest",
})
export type RegistrationMode = Enum<typeof RegistrationMode>

// Entry snapshots
// ========================================

export type BindingEntrySnapshot<T = unknown> = {
    readonly kind: "class" | "value" | "factory"
    readonly token: InjectionToken<T>
    readonly scope: Scope
    readonly multi: boolean
    /** The frozen bag the registration carried, absent when it carried none. */
    readonly metadata?: EntryMetadata
}

export type AliasEntrySnapshot<T = unknown> = {
    readonly kind: "alias"
    readonly token: InjectionToken<T>
    readonly target: InjectionToken
    readonly multi: boolean
    /** The frozen bag the registration carried, absent when it carried none. */
    readonly metadata?: EntryMetadata
}

export type EntrySnapshot<T = unknown> = BindingEntrySnapshot<T> | AliasEntrySnapshot<T>

// Events
// ========================================

export const ContainerEvent = Enum({
    BeforeResolution: "beforeResolution",
    AfterResolution: "afterResolution",
    BeforeMaterialize: "beforeMaterialize",
    AfterMaterialize: "afterMaterialize",
})
export type ContainerEvent = Enum<typeof ContainerEvent>

export type BeforeResolutionEvent = {
    readonly token: InjectionToken
    readonly mode: ResolveMode | ResolveAllMode
    /** The entry as spelled. */
    readonly snapshot: EntrySnapshot
}

export type AfterResolutionEvent = {
    readonly instance: unknown
    readonly mode: ResolveMode | ResolveAllMode
    readonly snapshot: EntrySnapshot
}

export type BeforeMaterializeEvent = {
    readonly token: InjectionToken
    readonly snapshot: BindingEntrySnapshot
}

export type AfterMaterializeEvent = {
    readonly instance: unknown
    readonly snapshot: BindingEntrySnapshot
}

export type ContainerEventPayload = {
    readonly beforeResolution: BeforeResolutionEvent
    readonly afterResolution: AfterResolutionEvent
    readonly beforeMaterialize: BeforeMaterializeEvent
    readonly afterMaterialize: AfterMaterializeEvent
}

export type ContainerEventListener<E extends ContainerEvent = ContainerEvent> = (
    event: ContainerEventPayload[E]
) => void

// Container internals
// ========================================

export type EntrySource =
    | { kind: "class"; implementation: Constructor<unknown> }
    | { kind: "value"; value: unknown }
    | { kind: "factory"; factory: () => unknown }
    | { kind: "alias"; target: InjectionToken }

export type Entry = {
    readonly token: InjectionToken
    readonly source: EntrySource
    readonly scope: Scope
    readonly multi: boolean
    readonly metadata?: EntryMetadata
    /** Present once a singleton (or a constant) has produced its instance. */
    cache?: { value: unknown }
}

export type Resolution = { readonly request: RequestCache; readonly chain: readonly InjectionToken[] }

export type Found = { owner: Container; entry: Entry }

/** The binding an alias walk landed on, with the resolution the walk's own tokens have joined. */
export type Landing = Found & { readonly context: Resolution }
