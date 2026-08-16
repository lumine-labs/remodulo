# @remodulo/view-model

**The reference lifecycle citizen for [remodulo](https://github.com/lumine-labs/remodulo).**

A base class that owns disposers and an `AbortSignal`, releases them at the right moment, and seals its own
lifecycle entry points so a subclass cannot silently disable the teardown. Reactivity-agnostic and
host-agnostic: it knows nothing about MobX, and nothing about React.

> ⚠️ **Experimental / internal use.**
>
> Primarily intended for personal and internal use. It may change, break, or be restructured at any time.
> Don't rely on it for public projects unless you're prepared to maintain your own fork.

## Install

```sh
npm install @remodulo/view-model
```

**Zero dependencies and zero peers** — not an accident, the point. The class is plain TypeScript over
`AbortController` and an array, so it costs a consumer nothing to adopt and cannot drag a second copy of
anything into their graph. The declarations gate pins it: the emitted `ViewModel.d.ts` contains no `import`
at all.

## Example

```ts
import { ViewModel } from "@remodulo/view-model"

class SearchStore extends ViewModel {
    results: string[] = []

    protected onMount(): void {
        this.track(subscribe(this.query, (results) => (this.results = results)))
    }

    protected async onDestroy(): Promise<void> {
        await this.flushPendingWrites()
    }

    private async query(term: string): Promise<string[]> {
        const response = await fetch(`/search?q=${term}`, { signal: this.signal() })
        return response.json()
    }
}
```

## The four hooks

`onInit()`, `onMount()`, `onUnmount()`, `onDestroy()` — all **optional**, all `protected`, **no `super`
call**. Declare only the ones you need, as a method or an arrow field. `onDestroy` is the only one that may
return a promise; it is awaited.

## `track()` and `signal()` are mount-scoped

`track(disposer)` registers cleanup and returns the disposer unchanged, so it wraps a subscription inline.
`signal()` lazily mints an `AbortController` and hands you its signal.

Both release at **unmount**, in reverse registration order, each disposer in its own `try/catch` — what a
mount acquires, the matching unmount lets go, so a remount starts clean instead of stacking a second
subscription on the first. The controller is aborted _after_ the disposer flush and then dropped, so the
next mount gets a fresh signal.

**Destroy is the backstop, not the scope.** A module that is created and destroyed without ever mounting
would otherwise leak whatever its constructor tracked, so `onDestroy` runs the same release afterwards.
Cleanup that genuinely belongs to the object's whole life is just the body of `onDestroy` — there is no
second registry for it.

## The seal, in three layers

The four `onModule*` hooks are the module lifecycle's entry points and the base owns all four. A subclass
that redefined one would drop the teardown the base runs after it, so the base refuses the redefinition
rather than trying to wrap it:

1. **Compile time.** The hooks are `private`, so they are emitted as `private onModuleInit;` and its three
   siblings. A subclass that redeclares one — method or arrow field — fails to compile before it can ever
   throw.
2. **Construction.** The constructor walks the prototype chain up to `ViewModel.prototype` and throws on any
   own `onModule*` descriptor, naming the replacement:
   `ViewModel seals onModuleMount() — override onMount() instead.` A grandchild is caught the same as a
   child.
3. **The property itself.** Each hook is then pinned as a non-writable, non-configurable own property of the
   instance. That closes the route the prototype scan cannot see — a class **field** initializer runs after
   the base constructor, so it gets a `TypeError` instead. Assignment and `defineProperty` after
   construction throw for the same reason.

The hooks are non-enumerable, so the instance still reads as plain state from the outside. `Reflect.ownKeys`
does see them, which is the trap for any annotation pass that walks own keys —
[`@remodulo/mobx`](https://www.npmjs.com/package/@remodulo/mobx)'s `makeInheritedAutoObservable` carries a
skip for exactly that.

## Honesty about the coupling

Nothing here imports `@remodulo/react`. The `onModule*` names are adopted **structurally** — the module
lifecycle looks them up at runtime and never names their types — which is what lets this package stay
dependency-free while still being a first-class participant. The flip side is that the contract is a naming
convention rather than a compiler-checked interface, and the two packages' suites are what keep it true.

## [Documentation](https://lumine-labs.github.io/remodulo/)

## License

MIT
