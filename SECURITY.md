# Security and abuse

## What there is to attack

Not much, by design. There is no database, no account, no session, no logging of furls or targets. A furl is a compressed URL; unfurling one is a pure function. The interesting surface is:

- **The codec.** A malformed furl must throw, never produce a wrong URL or hang. The decoder validates the result with the WHATWG URL parser and refuses unknown versions. If you find an input that crashes, loops, or misdecodes, that is a bug worth reporting.
- **The redirect.** `furl.li/<furl>` answers a 302 to whatever the furl unfurls to, restricted to `http:` and `https:` targets, with `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. Open redirects are inherent to a shortener; the `+` peek form and a static blocklist hook are the mitigations.
- **The static page.** No backend, no cookies, no third-party scripts, the model is bundled. Everything after `#` never leaves the browser.

## Reporting a vulnerability

Open a GitHub issue if it is not sensitive. If it is (for example a way to make the worker fetch or leak something), email the maintainer through the address on the GitHub profile with "enfurl security" in the subject. Expect an answer within a week.

## Reporting abuse

A furl cannot be deleted; there is nothing to delete. What can be done: the redirect worker carries a static blocklist evaluated at request time (`apps/edge/src/worker.ts`, `blocked()`), which refuses to redirect to listed targets and shows a page instead. To report a furl used for phishing or malware, open an issue titled "abuse:" with the furl and the target. Do not include anything you would not want public.
