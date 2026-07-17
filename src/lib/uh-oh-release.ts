import pkg from "../../package.json";

// Shared release string for uh-oh crash reporting (wired into instrumentation.ts,
// instrumentation-client.ts, and the MCP server). This repo has no build-id/git-sha
// env convention, so the build segment is a fixed "0" per the wiring convention
// (see DECISIONS). Bump automatically whenever package.json's version bumps.
export const UH_OH_RELEASE = `${pkg.version}+0`;
