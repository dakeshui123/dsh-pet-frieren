/**
 * dsh-pet-frieren node half. Pure surface plugin: the empty apply exists so
 * the row appears in the profile's Loader entries — that presence is what the
 * DSH client-modules node half scans to discover the `dsh.client` declaration
 * and serve /plugins/dsh-pet-frieren/client.js to the browser, where the
 * client half mounts the pet.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply() {}
