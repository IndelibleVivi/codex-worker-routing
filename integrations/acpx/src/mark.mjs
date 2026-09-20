// SPDX-License-Identifier: SUL-1.0
// Fixed product mark; companion artwork remains in brand.mjs / mascots.mjs.
export function productMark(){return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" aria-hidden="true"><path d="M6 31C11 22 16 12 20 10C23 14 19 26 20 30C23 26 27 20 29 22C31 24 26 33 31 32L42 21" fill="none" stroke="#51415f" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="36" r="1.7" fill="#61794f"/><circle cx="42" cy="21" r="1.7" fill="#51415f"/></svg>`;}

export const renderProductMarkSVG = () => productMark().replace('aria-hidden="true"','role="img" aria-label="Worker Routing"');
