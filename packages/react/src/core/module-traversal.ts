import type { InjectionToken } from "@remodulo/container"
import type { Module } from "./module.js"

// ModuleTraversal
// ========================================

/**
 * A stateless view over the module graph. Every answer is derived from `parent`/`children` on the modules
 * themselves, so there is nothing here to keep in sync — and no state beyond the module it reads from.
 */
export class ModuleTraversal {
    constructor(private readonly module: Module) {}

    // Traversal
    // ========================================

    parent(): Module | null {
        return this.module.parent
    }

    /** Nearest first, excluding self. */
    ancestors(): Module[] {
        const found: Module[] = []
        let current = this.module.parent
        while (current) {
            found.push(current)
            current = current.parent
        }
        return found
    }

    /** The outermost module in this tree, or itself when already a root. */
    findRoot(): Module {
        return this.ancestors().at(-1) ?? this.module
    }

    /** Direct children only, in attach order. A child appears here once it has mounted. */
    children(): Module[] {
        return [...this.module.children]
    }

    /** Depth-first, excluding self. Recurses through each child's own view — one per module. */
    descendants(): Module[] {
        const found: Module[] = []
        for (const child of this.module.children) {
            found.push(child)
            found.push(...child.traversal.descendants())
        }
        return found
    }

    findAncestorById(id: string): Module | null {
        let current = this.module.parent
        while (current) {
            if (current.id === id) return current
            current = current.parent
        }
        return null
    }

    findDescendantById(id: string): Module | null {
        for (const child of this.module.children) {
            if (child.id === id) return child
            const found = child.traversal.findDescendantById(id)
            if (found) return found
        }
        return null
    }

    /**
     * Nearest ancestor holding the token. Asks the container rather than the declared provider snapshot,
     * which cannot see registrations made after resolution.
     */
    findAncestorByProvider(token: InjectionToken): Module | null {
        return this.ancestors().find((module) => module.container.isRegistered(token, "self")) ?? null
    }

    findDescendantsByProvider(token: InjectionToken): Module[] {
        return this.descendants().filter((module) => module.container.isRegistered(token, "self"))
    }
}
