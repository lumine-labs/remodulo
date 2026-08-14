import type { ComponentProps, ComponentType, FC } from "react"

type ModuleProps<M extends ComponentType<any>> = Omit<ComponentProps<M>, "children">
type ViewChildren<V extends ComponentType<any>> = Pick<ComponentProps<V>, "children" & keyof ComponentProps<V>>

type ChildrenOnly<V extends ComponentType<any>> = keyof ComponentProps<V> extends "children"
    ? unknown
    : { "withModule: the view may declare no prop other than `children`": never }

function nameOf(component: ComponentType<any>): string {
    return component.displayName || component.name || "Anonymous"
}

export function withModule<M extends ComponentType<any>, V extends ComponentType<any>>(
    Module: M,
    View: V & ChildrenOnly<V>
): FC<ModuleProps<M> & ViewChildren<V>> {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const Wrapper = Module as ComponentType<any>
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const Shell = View as ComponentType<any>

    const Composed: FC<ModuleProps<M> & ViewChildren<V>> = ({ children, ...props }) => (
        <Wrapper {...props}>
            <Shell>{children}</Shell>
        </Wrapper>
    )

    Composed.displayName = `withModule(${nameOf(Module)}, ${nameOf(View)})`
    return Composed
}
