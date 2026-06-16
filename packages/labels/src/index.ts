// @kda/labels — shared label payload, profiles, PDF renderer and validation.
// Node-only (depends on pdfkit + bwip-js); must NOT be imported by the browser
// dashboard bundle. Used by @kda/backend and apps/print-bridge.

export * from './profiles';
export * from './payload';
export * from './renderer';
export * from './validate';
