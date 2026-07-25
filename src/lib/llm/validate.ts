// A23.4 / D188: shape checks for the two untrusted strings that reach the LLM
// subprocess boundary. Pure and dependency-free so the routes and the client
// can share them and the unit suite can pin them.

// A model id reaches argv. On Linux the CLI is always spawned with shell false,
// so nothing is interpreted, but the Windows dev fallback can spawn with shell
// true (D64), where argv values are not quoted. This alphabet covers every real
// model id (letters, digits, dot, underscore, colon, hyphen) and carries no
// shell metacharacter.
export const MODEL_ID_RE = /^[A-Za-z0-9._:-]+$/;

// A fixtureKey is interpolated into a fixture filename. It only matters when
// USE_FIXTURE_LLM is set, so production is unaffected, but it arrives verbatim
// from request bodies and must not be able to walk out of tests/fixtures.
export const FIXTURE_KEY_RE = /^[A-Za-z0-9._-]+$/;

export function isValidModelId(model: unknown): model is string {
  return typeof model === "string" && MODEL_ID_RE.test(model);
}

export function isValidFixtureKey(key: unknown): key is string {
  return typeof key === "string" && FIXTURE_KEY_RE.test(key);
}
