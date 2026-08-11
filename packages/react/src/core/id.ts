const getId = (() => {
    let i = 0
    return () => `${i++}`
})()

export const id = () => {
    return `id:${getId()}`
}
