/**
 * Inline theme bootstrap, shared between the root layout (which renders it) and
 * the tests (which assert the CSP nonce plumbing lets it run).
 *
 * Applied before first paint so the public marketing pages never flash the
 * wrong theme. Default is dark (the brand default); a stored choice wins. The
 * attribute is read by the `.lz` light-theme CSS overrides.
 *
 * It is emitted as an inline <script>, so it needs the per-request CSP nonce
 * (see lib/deployment-security.ts and worker/index.ts). A static hash is NOT
 * usable here because the framework also streams dynamic inline RSC bootstrap
 * scripts whose contents vary per request — only a nonce covers all of them.
 */
export const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem("sutra.theme");document.documentElement.dataset.theme=(t==="light"||t==="dark")?t:"dark";}catch(e){document.documentElement.dataset.theme="dark";}})();`;
