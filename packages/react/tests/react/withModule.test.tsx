import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { FC, ReactNode } from "react"

import { createModuleComponent } from "../../src/react/createModuleComponent.js"
import { PropsRef } from "../../src/primitives/props-ref.js"
import { useResolve } from "../../src/react/useResolve.js"
import { useModuleContext } from "../../src/react/useModuleContext.js"
import { withModule } from "../../src/react/withModule.js"
import { Root, svc } from "../setup/react.js"

// `withModule` glues a module component around a pure view shell: the module props go to the module, the
// children go through the view. It adds no behaviour of its own — the module is the one from
// `createModuleComponent` and the view is rendered inside it, which is the whole of the composition.

type UserProps = { userId: string }

describe("withModule composition", () => {
    it("renders the module around the view around the children", () => {
        const log: string[] = []
        const UserModule = createModuleComponent<UserProps>({ id: "user", providers: [svc(log, "service")] })

        const Shell: FC<{ children?: ReactNode }> = ({ children }) => <section data-testid="shell">{children}</section>
        const Screen = withModule(UserModule, Shell)

        function Probe() {
            log.push(`probe:${useModuleContext().module.id}`)
            return <span data-testid="probe">inside</span>
        }

        render(
            <Root>
                <Screen userId="u1">
                    <Probe />
                </Screen>
            </Root>
        )

        // The shell is the parent of the children, and the module is above both — the probe resolves the
        // module context from inside, which it could only do if the module wraps the view.
        expect(screen.getByTestId("shell")).toContainElement(screen.getByTestId("probe"))
        expect(log).toContain("probe:user")

        // And the module really mounted around it, rather than the view being rendered bare.
        expect(log.filter((entry) => entry.startsWith("service:"))).toEqual(["service:init", "service:mount"])
    })

    it("passes the module's props to the MODULE, not to the view", () => {
        const UserModule = createModuleComponent<UserProps>({ id: "props", providers: [] })

        const captured: { bridged?: PropsRef<UserProps> } = {}
        let seenByShell: unknown = "untouched"

        const Shell: FC<{ children?: ReactNode }> = (props) => {
            seenByShell = (props as Record<string, unknown>).userId
            return <>{props.children}</>
        }
        const Screen = withModule(UserModule, Shell)

        function Probe() {
            captured.bridged = useResolve(PropsRef) as PropsRef<UserProps>
            return null
        }

        render(
            <Root>
                <Screen userId="u1">
                    <Probe />
                </Screen>
            </Root>
        )

        // The props bridge sees them, so `createModuleComponent`'s behaviour is untouched by the wrapper.
        expect(captured.bridged?.current).toEqual({ userId: "u1" })
        // The view is rendered with children alone, whatever the module was given.
        expect(seenByShell).toBeUndefined()
    })

    it("accepts a view that declares no props at all", () => {
        const UserModule = createModuleComponent<UserProps>({ id: "bare", providers: [] })

        const Bare = (): ReactNode => <div data-testid="bare">bare</div>
        const Screen = withModule(UserModule, Bare)

        render(
            <Root>
                <Screen userId="u1" />
            </Root>
        )

        expect(screen.getByTestId("bare")).toBeInTheDocument()
    })

    it("names the composed component after both halves", () => {
        const UserModule = createModuleComponent<UserProps>({ id: "named", providers: [] })
        const Shell: FC<{ children?: ReactNode }> = ({ children }) => <>{children}</>

        // `createModuleComponent` names its own output `Module`, so the composed name carries both.
        expect(withModule(UserModule, Shell).displayName).toBe("withModule(Module, Shell)")

        const Anonymous: FC<{ children?: ReactNode }> = ({ children }) => <>{children}</>
        Object.defineProperty(Anonymous, "name", { value: "" })
        expect(withModule(UserModule, Anonymous).displayName).toBe("withModule(Module, Anonymous)")
    })
})

// The view constraint — a view declares `children` or nothing
// ========================================
//
// The composition renders `<View>{children}</View>` and passes nothing else, so a view that needs anything
// else could never receive it. The constraint says so at compile time, in both directions: no props at all
// and `children` alone are legal; any other key — optional or required — is not. Checked by
// `typecheck:tests`, and again against the published declarations in the consumer fixtures. Never called.

function viewConstraint(): void {
    const Module = createModuleComponent<UserProps>({ id: "constraint", providers: [] })

    const NoProps = (): null => null
    const ChildrenOnly: FC<{ children?: ReactNode }> = () => null
    const OptionalExtra: FC<{ children?: ReactNode; className?: string }> = () => null
    const RequiredExtra: FC<{ children?: ReactNode; label: string }> = () => null

    withModule(Module, NoProps)
    withModule(Module, ChildrenOnly)

    // @ts-expect-error an optional extra is still an extra: the view could never be given one.
    withModule(Module, OptionalExtra)

    // @ts-expect-error and a required one could never be satisfied.
    withModule(Module, RequiredExtra)
}
void viewConstraint

function composedProps(): void {
    const Module = createModuleComponent<UserProps>({ id: "composed", providers: [] })
    const NoProps = (): null => null
    const ChildrenOnly: FC<{ children?: ReactNode }> = () => null

    const Bare = withModule(Module, NoProps)
    const Slotted = withModule(Module, ChildrenOnly)

    // The module's props are the composed component's props — no explicit generics at any call site.
    void (<Bare userId="u1" />)
    void (
        <Slotted userId="u1">
            <span />
        </Slotted>
    )

    // @ts-expect-error the module's own props stay required.
    void (<Bare />)

    // @ts-expect-error a no-props view contributes no children slot, so children are refused.
    void (<Bare userId="u1">nope</Bare>)
}
void composedProps
