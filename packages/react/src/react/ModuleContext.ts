import { createContext } from "react"
import type { Module } from "../core/module.js"

export type ModuleContextValue = {
    module: Module
    rebuild: () => void
}

export const ModuleContext = createContext<ModuleContextValue | null>(null)
