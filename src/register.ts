/** Side-effect entry: installs Manifest from `MNFST_KEY` before the app's
 * own modules evaluate.
 *
 *     node -r manifest/register app.js
 *
 * Some clients read global `fetch` once, when constructed. A client built at
 * import time, before `manifest()` could run, keeps the original `fetch` and
 * is never healed. Preloading this module installs first. */
import { manifest } from './index.js';
manifest();
