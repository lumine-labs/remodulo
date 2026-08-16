import { defineConfig } from "vitest/config"

// eslint-disable-next-line import/no-default-export
export default defineConfig({
    test: {
        environment: "node",
        globals: true,
        include: ["tests/**/*.test.ts"],
        coverage: {
            provider: "v8",
            reporter: ["text", "html", "lcov"],
            include: ["src/**/*.ts"],
            exclude: ["tests/**/*.test.ts"],
        },
    },
})
