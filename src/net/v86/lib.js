// Hex formatter used in the vendored files' debug messages.
export function h(n, len) {
    const str = n ? n.toString(16) : "";
    return "0x" + "0".repeat(Math.max(0, (len || 1) - str.length)) + str;
}
