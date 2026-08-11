import { beforeEach, describe, expect, it } from "vitest"

import { Container } from "@remodulo/container"
import { App, Module } from "../../src/core/module.js"
import { ModuleTraversal } from "../../src/core/module-traversal.js"
import { makeApp, makeChild, refuses } from "../setup/helpers.js"

// ModuleTraversal
// ========================================
//
//   root ──┬── a ──┬── a1
//          │       └── a2
//          └── b
//
// Every traversal method deals in `Module` — ids and tokens are lookup keys, never return values, and a
// caller that wants the container reaches it through `module.container`. The tree is built from
// `module.parent`, and a node only becomes visible to its parent once it has mounted.
//
// Nothing here is stored: the view derives every answer from `parent`/`children` on the modules
// themselves, so there is no attach/detach on this class — the module graph is the only state.

const SHARED = Symbol.for("tests.traversal.shared")
const ROOT_ONLY = Symbol.for("tests.traversal.root-only")
const DEEP = Symbol.for("tests.traversal.deep")
const NOWHERE = Symbol.for("tests.traversal.nowhere")

type Tree = { root: Module; a: Module; a1: Module; a2: Module; b: Module }

let tree: Tree

function traversalOf(module: Module): ModuleTraversal {
    return module.container.resolve(ModuleTraversal)
}

beforeEach(() => {
    const root = makeApp({
        id: "root",
        providers: [
            { provide: SHARED, useValue: "root" },
            { provide: ROOT_ONLY, useValue: "root-only" },
        ],
    })
    const a = makeChild(root, { id: "a", providers: [{ provide: SHARED, useValue: "a" }] })
    const a1 = makeChild(a, { id: "a1" })
    const a2 = makeChild(a, { id: "a2", providers: [{ provide: DEEP, useValue: "a2" }] })
    const b = makeChild(root, { id: "b", providers: [{ provide: DEEP, useValue: "b" }] })

    // React mounts depth-first: leaves commit before their parents, siblings in render order.
    for (const module of [a1, a2, a, b, root]) module.mount()

    tree = { root, a, a1, a2, b }
})

describe("ModuleTraversal — parent", () => {
    it("returns the parent module", () => {
        expect(traversalOf(tree.a1).parent()).toBe(tree.a)
        expect(traversalOf(tree.a).parent()).toBe(tree.root)
        expect(traversalOf(tree.a1).parent()).toBeInstanceOf(Module)
    })

    it("returns null at an App root", () => {
        expect(traversalOf(tree.root).parent()).toBeNull()
    })
})

describe("ModuleTraversal — ancestors", () => {
    it("lists ancestors nearest first, excluding self", () => {
        expect(traversalOf(tree.a1).ancestors()).toEqual([tree.a, tree.root])
        expect(traversalOf(tree.a).ancestors()).toEqual([tree.root])
    })

    it("is empty at a root", () => {
        expect(traversalOf(tree.root).ancestors()).toEqual([])
    })

    it("does not depend on mounting — the chain is structural, not attachment", () => {
        const root = makeApp({ id: "unmounted-root" })
        const child = makeChild(root, { id: "unmounted-child" })

        expect(traversalOf(child).ancestors()).toEqual([root])
    })
})

describe("ModuleTraversal — findRoot", () => {
    it("returns the outermost module of the tree", () => {
        expect(traversalOf(tree.a1).findRoot()).toBe(tree.root)
        expect(traversalOf(tree.b).findRoot()).toBe(tree.root)
    })

    it("returns itself when it is already the root", () => {
        expect(traversalOf(tree.root).findRoot()).toBe(tree.root)
    })
})

describe("ModuleTraversal — children", () => {
    it("lists direct children only, in attach order", () => {
        expect(traversalOf(tree.root).children()).toEqual([tree.a, tree.b])
        expect(traversalOf(tree.a).children()).toEqual([tree.a1, tree.a2])
    })

    it("is empty for a leaf", () => {
        expect(traversalOf(tree.a1).children()).toEqual([])
    })

    it("only sees children that have mounted", () => {
        const late = makeChild(tree.root, { id: "late" })

        expect(traversalOf(tree.root).children()).toEqual([tree.a, tree.b])

        late.mount()
        expect(traversalOf(tree.root).children()).toEqual([tree.a, tree.b, late])
    })

    it("returns Modules, and the container is reached through them", () => {
        for (const child of traversalOf(tree.root).children()) {
            expect(child).toBeInstanceOf(Module)
            expect(child.container).toBeInstanceOf(Container)
        }

        expect(traversalOf(tree.root).children().map((child) => child.container)).toEqual([
            tree.a.container,
            tree.b.container,
        ])
    })
})

describe("ModuleTraversal — descendants", () => {
    it("walks depth-first, excluding self", () => {
        expect(traversalOf(tree.root).descendants()).toEqual([tree.a, tree.a1, tree.a2, tree.b])
    })

    it("is scoped to the subtree it is asked from", () => {
        expect(traversalOf(tree.a).descendants()).toEqual([tree.a1, tree.a2])
        expect(traversalOf(tree.b).descendants()).toEqual([])
    })

    it("only sees mounted nodes", async () => {
        makeChild(tree.b, { id: "unmounted" })
        expect(traversalOf(tree.root).descendants()).toEqual([tree.a, tree.a1, tree.a2, tree.b])

        tree.a2.unmount()
        await tree.a2.destroy()
        expect(traversalOf(tree.root).descendants()).toEqual([tree.a, tree.a1, tree.b])
    })

    it("returns Modules, and the container is reached through them", () => {
        for (const descendant of traversalOf(tree.root).descendants()) {
            expect(descendant).toBeInstanceOf(Module)
            expect(descendant.container).toBeInstanceOf(Container)
        }
    })
})

describe("ModuleTraversal — lookup by id", () => {
    it("finds an ancestor by id", () => {
        expect(traversalOf(tree.a1).findAncestorById("a")).toBe(tree.a)
        expect(traversalOf(tree.a1).findAncestorById("root")).toBe(tree.root)
    })

    it("returns null for an id that is not an ancestor", () => {
        expect(traversalOf(tree.a1).findAncestorById("b")).toBeNull()
        expect(traversalOf(tree.a1).findAncestorById("a1")).toBeNull()
        expect(traversalOf(tree.a1).findAncestorById("missing")).toBeNull()
    })

    it("finds a descendant by id", () => {
        expect(traversalOf(tree.root).findDescendantById("a2")).toBe(tree.a2)
        expect(traversalOf(tree.root).findDescendantById("b")).toBe(tree.b)
    })

    it("returns null for an id that is not a descendant", () => {
        expect(traversalOf(tree.root).findDescendantById("root")).toBeNull()
        expect(traversalOf(tree.a).findDescendantById("b")).toBeNull()
        expect(traversalOf(tree.a1).findDescendantById("a")).toBeNull()
    })

    it("returns the nearest match when two ancestors share an id", () => {
        const outer = makeApp({ id: "dup" })
        const middle = makeChild(outer, { id: "dup" })
        const leaf = makeChild(middle, { id: "leaf" })

        expect(traversalOf(leaf).findAncestorById("dup")).toBe(middle)
    })
})

describe("ModuleTraversal — lookup by provider", () => {
    it("finds the nearest ancestor that registers the token itself", () => {
        // `a` shadows the root's SHARED, and the ancestor search asks each container non-recursively,
        // so the nearest declaring module wins rather than the first one that can merely resolve it.
        expect(traversalOf(tree.a1).findAncestorByProvider(SHARED)).toBe(tree.a)
        expect(traversalOf(tree.a1).findAncestorByProvider(ROOT_ONLY)).toBe(tree.root)
    })

    it("does not count a token it owns itself", () => {
        expect(traversalOf(tree.a).findAncestorByProvider(SHARED)).toBe(tree.root)
    })

    it("returns null when no ancestor declares the token", () => {
        expect(traversalOf(tree.a1).findAncestorByProvider(NOWHERE)).toBeNull()
        expect(traversalOf(tree.a1).findAncestorByProvider(DEEP)).toBeNull()
        expect(traversalOf(tree.root).findAncestorByProvider(SHARED)).toBeNull()
    })

    it("finds every descendant declaring the token, depth-first", () => {
        expect(traversalOf(tree.root).findDescendantsByProvider(DEEP)).toEqual([tree.a2, tree.b])
    })

    it("excludes self and reports an empty list when nobody below declares it", () => {
        expect(traversalOf(tree.root).findDescendantsByProvider(SHARED)).toEqual([tree.a])
        expect(traversalOf(tree.root).findDescendantsByProvider(ROOT_ONLY)).toEqual([])
        expect(traversalOf(tree.root).findDescendantsByProvider(NOWHERE)).toEqual([])
    })

    it("ignores an inherited binding — the question is who declared it", () => {
        // a1 resolves SHARED through the chain but declares nothing. The token check still goes through
        // the container, reached as `module.container`.
        expect(tree.a1.container.isRegistered(SHARED)).toBe(true)
        expect(tree.a1.container.isRegistered(SHARED, "self")).toBe(false)
        expect(traversalOf(tree.a).findDescendantsByProvider(SHARED)).toEqual([])
    })

    it("returns Modules, and the container is reached through them", () => {
        const ancestor = traversalOf(tree.a1).findAncestorByProvider(ROOT_ONLY)
        const descendants = traversalOf(tree.root).findDescendantsByProvider(DEEP)

        expect(ancestor).toBeInstanceOf(Module)
        expect(ancestor?.container).toBe(tree.root.container)
        for (const module of descendants) expect(module.container).toBeInstanceOf(Container)
    })
})

describe("ModuleTraversal — a derived view, not a stored one", () => {
    // What replaced attach/detach: the class holds nothing but the module it reads from, so the linking
    // the lifecycle performs is visible through any instance, including one built before the link existed.
    it("reflects a link made after the view was created", () => {
        const parent = makeApp({ id: "p" })
        const view = traversalOf(parent)
        const child = makeChild(parent, { id: "c" })

        expect(view.children()).toEqual([])

        child.mount()
        expect(view.children()).toEqual([child])
    })

    it("agrees with a freshly constructed view, and with the module graph itself", async () => {
        expect(traversalOf(tree.root).descendants()).toEqual(new ModuleTraversal(tree.root).descendants())
        expect(traversalOf(tree.a).children()).toEqual([...tree.a.children])

        tree.a2.unmount()
        await tree.a2.destroy()

        expect(traversalOf(tree.a).children()).toEqual([...tree.a.children])
        expect(traversalOf(tree.root).descendants()).toEqual(new ModuleTraversal(tree.root).descendants())
    })
})

describe("ModuleTraversal — one instance, two access paths", () => {
    // The module owns exactly one view. `module.traversal` is for code already holding a module;
    // `inject(ModuleTraversal)` is for services. They are the same object, not two equivalent ones.
    it("registers the module's own view under the ModuleTraversal token", () => {
        for (const module of [tree.root, tree.a, tree.a1]) {
            expect(module.traversal).toBeInstanceOf(ModuleTraversal)
            expect(module.container.resolve(ModuleTraversal)).toBe(module.traversal)
        }
    })

    it("gives each module its own view, resolved from its own container and not inherited", () => {
        expect(tree.a.traversal).not.toBe(tree.root.traversal)
        expect(tree.a.container.isRegistered(ModuleTraversal, "self")).toBe(true)

        // The child's view answers about the child, so the token is not shadowed by the parent's.
        expect(tree.a.traversal.children()).toEqual([tree.a1, tree.a2])
        expect(tree.root.traversal.children()).toEqual([tree.a, tree.b])
    })

    it("is available before mount, and survives the module's whole life", async () => {
        const parent = makeApp({ id: "own-view" })
        const child = makeChild(parent, { id: "own-view-child" })
        const view = child.traversal

        expect(view.parent()).toBe(parent)

        child.mount()
        expect(view.parent()).toBe(parent)

        await child.destroy()
        expect(child.traversal).toBe(view)
        expect(view.parent()).toBe(parent)
    })
})
