# Live development app activation

The owner authorized live readings in the development app, without production
qualification gates. `npm run dev:live` serves the app at `http://localhost:8787`
using the existing server-side OpenAI key and project. It uses GPT-6.1 Terra,
fast service, xhigh reasoning and the v2 editorial prompt. Draft content retains
its actual review metadata.

## Browser check

A fresh test account enabled AI, submitted a question through Start, reloaded
while generation was running, received a model reading, saved it, turned AI off
and reopened identical content. The browser issued one Start, made no external
requests and recorded no JavaScript errors. The application stored one provider
dispatch for that request.

- Request: `41e7c1e0-5416-48e2-a665-26c3a549e1d1`.
- Reading: `6fb0a7a8-d656-4179-89fe-986751dbc040`.
- Returned model/tier: `gpt-6.1-terra` / `fast`.
- Requested reasoning: `xhigh`.
- Provider duration: 30.771 seconds.
- Recorded usage: 2,181 input, 3,211 output, including 2,588 reasoning tokens.
- Calculated cost: $0.037561, using the existing policy prices.

This is a live application integration check, not a new general quality assessment.
The private smoke result and screenshot are under
`~/.local/state/reflection-provider-evaluation/app-live-smoke/`.

## Corrections found during activation

The Worker rejects `redirect: 'error'` before dispatch. The transport now uses
`manual`, rejects redirect responses and never follows them. A Worker-native
request regression reproduces the original failure. Two earlier startup attempts
remain recorded with unknown cost reservations; neither is silently retried.

The next live response exposed a biography-screen false positive in the comparison
method “Separate what you’ve observed … from what you’re assuming.” The local app
policy `reading-local-live.v1` binds validator `bounded-developed-reading.v2.3`,
which permits that narrowly scoped method and still screens accompanying personal
assertions. The archived v2.2 policies and original fallback reading remain unchanged.
That response cost $0.027724; the two actual response receipts total $0.065285.

The launcher also uses the same persistent database path as migrations, serves the
built client, and permits saved-reading access when provider credentials are absent.
Unavailable runtime discovery cannot describe potential live calls as simulation.
Local storage and encryption keys persist in `.wrangler/live-development`.
