import type { InjectionToken } from "./container.types.js"

// Tokenizer
// ========================================

export type Tokenizer = <T = unknown>(name: string) => InjectionToken<T>

/**
 * A namespaced token factory. Every name is interned in the global symbol registry under
 * `<namespace>:<name>`, so the same name through the same namespace is the same token — twice in one file,
 * or once in each of two copies of a package sharing a process.
 */
export function makeTokenizer(namespace: string): Tokenizer {
    const trimmedNamespace = namespace.trim()
    if (!trimmedNamespace) {
        throw new Error("makeTokenizer: `namespace` must be a non-empty string.")
    }

    return function Token<T = unknown>(name: string): InjectionToken<T> {
        const trimmedName = name.trim()
        if (!trimmedName) {
            throw new Error("Token: `name` must be a non-empty string.")
        }

        return Symbol.for(`${trimmedNamespace}:${trimmedName}`)
    }
}
