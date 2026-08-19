/**
 * dsh-pet-frieren node half: serves the pet's runtime assets to the browser
 * through the DSH host webserver, the same way the web-app bundle serves its
 * frontend dist.
 *
 * The row's presence in the profile Loader is also what the DSH client-modules
 * node half scans to discover this package's `dsh.client` declaration and
 * serve /plugins/dsh-pet-frieren/client.js; the client half then reads the
 * spritesheet from the asset route registered here.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Route prefix owned by this plugin (namespaced so plugins cannot collide). */
const ASSET_PREFIX = '/dsh-plugin-assets/dsh-pet-frieren'

/** Runtime sprite atlas: the optimized copy generated from the lossless root sheet. */
const SPRITE_FILE = fileURLToPath(new URL('../assets/spritesheet.webp', import.meta.url))
const SPRITE_TYPE = 'image/webp'

/** Required services: the host webserver owns all HTTP route registration. */
export const inject = ['webServer']

/** Content of the sprite atlas, read once at activation (local GUI asset, small). */
let spriteBytes = null

/**
 * Serve one asset: fixed allowlist map, no path traversal surface.
 * @param req - node:http incoming request.
 * @param res - node:http server response.
 */
async function serve(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405)
    res.end()
    return
  }
  /* v8 ignore next -- node:http always sets url on server requests. */
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
  let bytes = null
  let type = null
  if (pathname === `${ASSET_PREFIX}/spritesheet.webp`) {
    bytes = spriteBytes
    type = SPRITE_TYPE
  }
  if (bytes === null) {
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': String(bytes.length),
    'cache-control': 'no-cache',
  })
  res.end(req.method === 'HEAD' ? undefined : bytes)
}

/**
 * Host plugin body: register the asset route with the host webserver.
 * @param ctx - host cordis context carrying the webServer service.
 */
export function apply(ctx) {
  if (spriteBytes === null) spriteBytes = readFileSync(SPRITE_FILE)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ASSET_PREFIX,
    handler: serve,
  }), 'dsh-pet-frieren: asset route')
}
