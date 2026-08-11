import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { Provider } from "../../src/core/provider.types.js"
import { createFeature } from "../../src/core/feature.js"
import { createModuleComponent } from "../../src/react/createModuleComponent.js"
import { useResolveAll } from "../../src/react/useResolveAll.js"
import { Root } from "../setup/react.js"

// A feature reaches the React path through the same params object a provider does.

const PLUGINS = Symbol("tests.feature.react.plugins")

const member = (value: string): Provider => ({ provide: PLUGINS, useValue: value, multi: true })

const Billing = createFeature({ name: "billing", providers: [member("invoices"), member("receipts")] })

const BillingModule = createModuleComponent({ providers: [Billing] })

function Plugins(): React.ReactElement {
    return <span data-testid="plugins">{useResolveAll<string>(PLUGINS).join(",")}</span>
}

describe("createModuleComponent", () => {
    it("registers a feature's members through the module params", () => {
        render(
            <Root>
                <BillingModule>
                    <Plugins />
                </BillingModule>
            </Root>
        )

        expect(screen.getByTestId("plugins").textContent).toBe("invoices,receipts")
    })
})
