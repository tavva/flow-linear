// ABOUTME: Jest setup shared by all tests.
// ABOUTME: Plugin code uses window timers, as Obsidian requires; under Node they are the global ones.

(globalThis as { window?: unknown }).window = globalThis;
